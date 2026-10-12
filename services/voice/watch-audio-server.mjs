// S105 音频桥合同: the Apple Watch's call audio leg. One WebSocket per watch call; the bridge joins the
// call's media room as the user's client leg (same user routes and token the watch holds) and moves
// 16 kHz PCM between the socket and a ClientMediaPeer. It never holds call-control authority.
//
// Wire format (same as the S105 spike echo):
//   text   first: {"type":"hello","callId","codec":"pcm16k"|"opus16k","frameMs":20|40,"deviceName"}
//   binary both ways: 4 B BE seq + 8 B BE monotonic ns + payload of frameMs audio:
//     pcm16k  (default): PCM16LE 16 kHz mono, exactly frameMs*32 bytes.
//     opus16k (S112):    ONE Opus packet (16 kHz mono, VOIP, 24 kbit/s, inband FEC, no DTX), variable length.
//   An uplink frame of the wrong size / undecodable packet counts upBadFrames (Opus: replaced by silence).
// Loopback (spike page): `callId: "loopback"` checks the token via /auth/me, then echoes every binary
// frame verbatim. No media route, no peer; capped at LOOPBACK_MAX_MS and counts toward maxSessions.
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { ClientMediaPeer, loadWrtc } from './webrtc-media.mjs';
import { Pcm16kResampler, pcmConstants } from './pcm-pipeline.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/;
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,4096}$/;
const HEADER_BYTES = 12;
const SLICE_BYTES = pcmConstants.PCM16K_10MS_BYTES;
const SILENCE_10MS = Buffer.alloc(SLICE_BYTES);
const PACE_FRAME_US = 10_000;
const PACE_MAX_CATCHUP_FRAMES = 5;
/** 1.2 s of uplink; on overflow the oldest whole 40 ms group (4 slices) goes, never a lone 10 ms slice. */
const UPLINK_MAX_SLICES = 120;
const UPLINK_DROP_GROUP = 4;
/**
 * Uplink prebuffer: the watch sends 40 ms frames over BT/Wi-Fi with jitter, so a strict 10 ms pacer
 * would splice silence into nearly every frame (clicks). Playout starts at 6 slices (60 ms); after the
 * queue runs dry it re-arms at 4 slices (40 ms). Either gate also opens once the oldest queued slice
 * has waited 150 ms (one uniform rule, so a lone trailing 20 ms frame is not stuck behind the gate).
 * ponytail: fixed thresholds, no adaptive jitter estimate; tune these if field stats say so.
 */
const UPLINK_PREBUFFER_SLICES = 6;
const UPLINK_REARM_SLICES = 4;
const UPLINK_PREBUFFER_MAX_US = 150_000;
/** Downlink frames are dropped (not queued) once the socket holds this much unsent data. */
const DOWNLINK_MAX_BUFFERED = 64 * 1024;
const LOOPBACK_CALL_ID = 'loopback';
/**
 * S105n uplink noise gate (off unless WATCH_UPLINK_GATE_DBFS is set): the watch has no working echo canceller
 * (setVoiceProcessingEnabled stalls the engine on watchOS 27), so the far end's own voice comes back ~1 s late at
 * about −60 dBFS and voice IVRs (10010) react to it. A 40 ms frame whose RMS is under the threshold is replaced by
 * silence unless a frame passed within the hangover, so quiet word tails are kept.
 * ponytail: fixed RMS threshold + hangover, no spectral VAD; raise/lower the env value from field recordings.
 */
const UPLINK_GATE_HANGOVER_US = 300_000;
function frameRmsDbfs(pcm) {
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; }
  return n ? 10 * Math.log10(Math.max(sum / n, 1e-12)) : -120;
}
/**
 * S112 Opus codec, one per opus16k session (encoder for downlink, decoder for uplink). opusscript is WASM with a
 * fixed heap: every instance must be close()d. Imported lazily so pcm16k sessions never load it.
 * frameSize for encode is samples per channel (frameMs*16), not bytes. decode returns null for anything that
 * throws or does not decode to exactly one frameMs of PCM (opusscript silently decodes some garbage to other lengths).
 */
/**
 * S112b downlink encoder knobs (env, read once per session): the watch bridge speaks over TCP, so packets are never
 * lost in transit (only whole stalls) — inband FEC just steals bits from every frame. A field call at
 * 24 kbps + FEC 10% came out at 13–16 kbps VBR and the user heard hiss behind the +9 dB watch gain.
 * ponytail: three env ints, no runtime negotiation; tune from field calls.
 */
const OPUS_BITRATE = Number(process.env.WATCH_OPUS_BITRATE || 40_000);
const OPUS_LOSS_PCT = Number(process.env.WATCH_OPUS_LOSS_PCT || 0); // >0 also turns inband FEC on
const OPUS_COMPLEXITY = Number(process.env.WATCH_OPUS_COMPLEXITY || 5); // S112c: 10 buys nothing audible in WASM, 5 halves encode time
export async function createOpusCodec(frameMs, { bitrate = OPUS_BITRATE, lossPct = OPUS_LOSS_PCT, complexity = OPUS_COMPLEXITY } = {}) {
  const { default: OpusScript } = await import('opusscript');
  const frameSamples = frameMs * 16;
  const enc = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  const dec = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  enc.setBitrate(bitrate);
  enc.encoderCTL(4012, lossPct > 0 ? 1 : 0); // OPUS_SET_INBAND_FEC
  enc.encoderCTL(4014, lossPct); // OPUS_SET_PACKET_LOSS_PERC: FEC is only emitted when this is > 0
  enc.encoderCTL(4016, 0); // OPUS_SET_DTX off
  enc.encoderCTL(4010, complexity); // OPUS_SET_COMPLEXITY
  let closed = false;
  return {
    encode: pcm => enc.encode(pcm, frameSamples),
    decode(packet) {
      try { const pcm = dec.decode(packet); return pcm.length === frameSamples * 2 ? pcm : null; } catch { return null; }
    },
    close() { if (closed) return; closed = true; enc.delete(); dec.delete(); },
  };
}

const TERMINAL_STATES = new Set(['ended', 'failed']);

export const CLOSE = Object.freeze({ BAD_HELLO: 4400, UNAUTHORIZED: 4401, HELLO_TIMEOUT: 4408, TERMINAL: 4410, BUSY: 4429, MEDIA: 4500 });

const monoNs = () => process.hrtime.bigint();
const monoUs = () => Number(process.hrtime.bigint() / 1000n);

export function packFrame(seq, ns, pcm) {
  const frame = Buffer.allocUnsafe(HEADER_BYTES + pcm.length);
  frame.writeUInt32BE(seq >>> 0, 0);
  frame.writeBigUInt64BE(BigInt.asUintN(64, ns), 4);
  pcm.copy(frame, HEADER_BYTES);
  return frame;
}

export class ControlError extends Error {
  constructor(status, code) { super(`Control ${status} ${code ?? ''}`.trim()); this.status = status; this.code = code; }
}

/**
 * node:http rather than fetch: fetch drops a caller-set Host header, and Control may be reached at a
 * private address (CONTROL_ORIGIN) while nginx/Control expect its public host name (CONTROL_HOST).
 */
export function controlRequest({ origin, host }, method, path, token, body, signal) {
  const url = new URL(path, origin);
  const client = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method, signal, timeout: 15_000, headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(host ? { Host: host } : {}),
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) req.destroy(new Error('Control response too large')); else chunks.push(chunk); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch {}
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Control request timed out')));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

async function controlJson(control, method, path, token, body, signal) {
  const { status, json } = await controlRequest(control, method, path, token, body, signal);
  if (status < 200 || status >= 300) throw new ControlError(status, json?.error?.code ?? json?.code);
  return json;
}

/** The user-route counterpart of the worker's run signaling (control-client.mjs `signaling(run)`). */
export class UserMediaSignaling {
  constructor({ control, token, relay }) { Object.assign(this, { control, token, relay }); }
  async options(callId, transport, signal) {
    const options = await controlJson(this.control, 'POST', `/api/v1/calls/${callId}/media/options`, this.token, { transport, relay: this.relay }, signal);
    // node-wrtc's native IceServer reads only urls/username/credential: the relay `hostname` (SNI for an
    // IP TURN URL, S71) cannot be applied here, so it is dropped rather than silently ignored downstream.
    // ClientMediaPeer.connect validates the single relay-only `turns:` URL shape.
    this.relayApplied = options?.relay === true;
    if (Array.isArray(options?.iceServers)) options.iceServers = options.iceServers.map(({ hostname, ...server }) => server);
    return options;
  }
  offer(callId, { type, sdp }, signal) {
    return controlJson(this.control, 'POST', `/api/v1/calls/${callId}/media/offer`, this.token, { type, sdp }, signal);
  }
}

class WatchSession {
  constructor({ ws, token, server }) {
    Object.assign(this, { ws, token, server });
    this.abort = new AbortController();
    this.uplink = [];
    this.downPending = Buffer.alloc(0);
    this.resampler = new Pcm16kResampler();
    this.stats = { upFrames: 0, upBadFrames: 0, upDropped: 0, uplinkOverflowDrops: 0, uplinkRebuffers: 0, pacedFrames: 0, silenceFrames: 0, downFrames: 0, downDropped: 0, gatedFrames: 0 };
    this.gateOpenUntilUs = 0;
    this.uplinkPlaying = false;
    this.uplinkNeed = UPLINK_PREBUFFER_SLICES;
    this.readyMs = null;
    this.firstUplinkMs = null;
    this.faultIce = null;
    this.downSeq = 0;
    this.closed = false;
  }

  log(event, extra = {}) { this.server.log({ event, callId: this.callId ?? null, ...extra }); }

  async start(hello) {
    const { control, transport, relay, wrtc, connectTimeoutMs } = this.server.options;
    this.callId = hello.callId;
    if (this.callId === LOOPBACK_CALL_ID) return this.startLoopback();
    this.frameMs = hello.frameMs ?? 40;
    this.frameBytes = this.frameMs * 32;
    this.codec = hello.codec ?? 'pcm16k';
    this.helloUs = this.server.options.paceNowUs();
    this.log('hello', { codec: this.codec, frameMs: this.frameMs, deviceName: String(hello.deviceName ?? '').slice(0, 64) });
    if (this.codec === 'opus16k') {
      this.opus = await createOpusCodec(this.frameMs);
      if (this.closed) { this.opus.close(); return; }
    }
    const signal = this.abort.signal;
    // 预连: a call still ringing/connecting is fine; only an unknown or foreign call is refused.
    const call = (await controlJson(control, 'GET', `/api/v1/calls/${this.callId}`, this.token, undefined, signal))?.call;
    if (TERMINAL_STATES.has(call?.state)) return this.close(CLOSE.TERMINAL, 'call_terminal');
    this.startPolling();
    const signaling = new UserMediaSignaling({ control, token: this.token, relay });
    const peer = await ClientMediaPeer.connect({ wrtc: await wrtc(), signaling, callId: this.callId, transport, signal, timeoutMs: connectTimeoutMs });
    if (this.closed) { peer.close(); return; }
    this.peer = peer;
    peer.on('pcm', data => this.onPeerPcm(data));
    peer.on('fault', error => {
      const iceStats = error?.iceStats ?? null;
      this.faultIce = iceStats ? {
        connectionState: iceStats.connectionState ?? null, local: iceStats.pair?.local ?? null,
        remote: iceStats.pair?.remote ?? null, consentRequestsSent: iceStats.pair?.consentRequestsSent ?? null,
      } : null;
      this.log('media_fault', { message: String(error?.message ?? error).slice(0, 120), iceStats });
      // Summary rides in the JSON error, never the close reason (ws caps that at 123 bytes).
      this.sendJson({ type: 'error', code: 'MEDIA_FAULT', ice: this.faultIce });
      this.close(CLOSE.MEDIA, 'media_fault');
    });
    for (const name of ['disconnected', 'reconnected', 'inboundRtp', 'mediaGap', 'mediaResumed']) peer.on(name, detail => this.log(`media_${name}`, detail ?? {}));
    this.startPacer();
    this.readyMs = this.sinceHelloMs();
    this.sendJson({ type: 'ready', mediaNodeId: peer.mediaNodeId, codec: this.codec });
    this.log('ready', { mediaNodeId: peer.mediaNodeId, relayApplied: signaling.relayApplied });
  }

  async startLoopback() {
    const { control, loopbackMaxMs } = this.server.options;
    await controlJson(control, 'GET', '/api/v1/auth/me', this.token, undefined, this.abort.signal);
    if (this.closed) return;
    this.loopback = { frames: 0, bytes: 0, startedMs: Date.now() };
    this.loopbackTimer = setTimeout(() => this.close(CLOSE.TERMINAL, 'loopback_limit'), loopbackMaxMs);
    this.loopbackTimer.unref?.();
    this.sendJson({ type: 'ready', mediaNodeId: LOOPBACK_CALL_ID });
    this.log('loopback_open');
  }

  onLoopback(data) {
    this.loopback.frames += 1;
    this.loopback.bytes += data.length;
    if (this.ws.bufferedAmount > DOWNLINK_MAX_BUFFERED) return;
    this.ws.send(data, { binary: true });
  }

  sinceHelloMs() { return Math.round((this.server.options.paceNowUs() - this.helloUs) / 1000); }

  startPolling() {
    this.pollDelayMs = this.server.options.pollMs;
    this.schedulePoll();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (this.closed) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollDelayMs);
    this.pollTimer.unref?.();
  }

  /**
   * S105k: the watch's 15-min access token can expire mid-call while the media leg (authorized at
   * connect) stays healthy. After `ready`, a 401/403 only backs the poll off; the peer `fault` or the
   * socket close ends the session. 404 / terminal state still close 4410; network errors are logged.
   */
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    const { control, pollMs, pollBackoffMs } = this.server.options;
    try {
      const call = (await controlJson(control, 'GET', `/api/v1/calls/${this.callId}`, this.token, undefined, this.abort.signal))?.call;
      this.pollDelayMs = pollMs;
      if (TERMINAL_STATES.has(call?.state)) this.close(CLOSE.TERMINAL, 'call_terminal');
    } catch (error) {
      const status = error instanceof ControlError ? error.status : null;
      if (this.closed) return;
      if (status === 404) this.close(CLOSE.TERMINAL, 'call_not_found');
      else if ((status === 401 || status === 403) && this.readyMs === null) this.close(CLOSE.UNAUTHORIZED, 'unauthorized');
      else if (status === 401 || status === 403) {
        if (this.pollDelayMs !== pollBackoffMs) this.log('poll_unauthorized', { status, nextPollMs: pollBackoffMs });
        this.pollDelayMs = pollBackoffMs;
      } else this.log('poll_failed', { message: String(error?.message ?? error).slice(0, 120) });
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  }

  rotateToken(token) {
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) { this.sendJson({ type: 'error', code: 'BAD_TOKEN' }); return; }
    this.token = token;
    this.sendJson({ type: 'token_ok' });
    this.log('token_rotated', { backedOff: this.pollDelayMs === this.server.options.pollBackoffMs });
    // A backed-off poll resumes at the normal cadence with the fresh token.
    if (this.pollTimer && this.pollDelayMs !== this.server.options.pollMs) {
      this.pollDelayMs = this.server.options.pollMs;
      if (!this.polling) this.schedulePoll();
    }
  }

  onUplink(data) {
    this.stats.upFrames += 1;
    let pcm;
    if (this.opus) {
      pcm = data.length > HEADER_BYTES ? this.opus.decode(data.subarray(HEADER_BYTES)) : null;
      if (!pcm) { this.stats.upBadFrames += 1; pcm = Buffer.alloc(this.frameBytes); }
    } else {
      if (data.length !== HEADER_BYTES + this.frameBytes) { this.stats.upBadFrames += 1; return; }
      pcm = data.subarray(HEADER_BYTES);
    }
    if (this.firstUplinkMs === null) this.firstUplinkMs = this.sinceHelloMs();
    const nowUs = this.server.options.paceNowUs();
    if (!this.uplinkPlaying && !this.uplink.length) this.prebufferSinceUs = nowUs;
    const gate = this.server.options.uplinkGateDbfs;
    if (gate !== null) {
      if (frameRmsDbfs(pcm) >= gate) this.gateOpenUntilUs = nowUs + UPLINK_GATE_HANGOVER_US;
      else if (nowUs >= this.gateOpenUntilUs) { this.stats.gatedFrames += 1; pcm = Buffer.alloc(this.frameBytes); }
    }
    for (let offset = 0; offset < pcm.length; offset += SLICE_BYTES) {
      if (this.uplink.length >= UPLINK_MAX_SLICES) {
        this.uplink.splice(0, UPLINK_DROP_GROUP);
        this.stats.upDropped += UPLINK_DROP_GROUP;
        this.stats.uplinkOverflowDrops += 1;
      }
      this.uplink.push(Buffer.from(pcm.subarray(offset, offset + SLICE_BYTES)));
    }
  }

  /** Same monotonic pacing as RealtimeAudioBridge.tick (audio-bridge.mjs): frames due by the clock, bounded catch-up. */
  tick() {
    if (this.closed || !this.peer) return;
    try {
      const now = this.server.options.paceNowUs();
      if (this.paceOriginUs === undefined) { this.paceOriginUs = now; this.pacedFrames = 0; }
      let frames = Math.max(0, Math.floor((now - this.paceOriginUs) / PACE_FRAME_US) - this.pacedFrames);
      if (frames > PACE_MAX_CATCHUP_FRAMES) {
        this.paceOriginUs += (frames - PACE_MAX_CATCHUP_FRAMES) * PACE_FRAME_US;
        frames = PACE_MAX_CATCHUP_FRAMES;
      }
      for (let i = 0; i < frames; i++) {
        if (!this.uplinkPlaying && this.uplink.length
          && (this.uplink.length >= this.uplinkNeed || now - this.prebufferSinceUs >= UPLINK_PREBUFFER_MAX_US)) this.uplinkPlaying = true;
        const slice = this.uplinkPlaying ? this.uplink.shift() : undefined;
        if (this.uplinkPlaying && !slice) {
          this.uplinkPlaying = false;
          this.uplinkNeed = UPLINK_REARM_SLICES;
          this.stats.uplinkRebuffers += 1;
        }
        if (!slice) this.stats.silenceFrames += 1;
        this.peer.writePcm16k10ms(slice ?? SILENCE_10MS);
        this.pacedFrames += 1;
        this.stats.pacedFrames += 1;
      }
    } catch (error) {
      this.log('pacer_failed', { message: String(error?.message ?? error).slice(0, 120) });
      this.sendJson({ type: 'error', code: 'MEDIA_FAULT' });
      this.close(CLOSE.MEDIA, 'pacer_failed');
    }
  }

  startPacer() {
    this.paceTimer = setInterval(() => this.tick(), this.server.options.tickMs);
    this.paceTimer.unref?.();
    this.tick();
  }

  onPeerPcm({ pcm, sampleRate }) {
    if (this.closed) return;
    let pcm16k;
    try { pcm16k = this.resampler.process(pcm, sampleRate); } catch { return; }
    this.downPending = this.downPending.length ? Buffer.concat([this.downPending, pcm16k]) : pcm16k;
    while (this.downPending.length >= this.frameBytes) {
      const chunk = this.downPending.subarray(0, this.frameBytes);
      this.downPending = this.downPending.subarray(this.frameBytes);
      if (this.ws.bufferedAmount > DOWNLINK_MAX_BUFFERED) { this.stats.downDropped += 1; continue; }
      let payload = chunk;
      if (this.opus) { try { payload = this.opus.encode(chunk); } catch { this.stats.downDropped += 1; continue; } }
      this.ws.send(packFrame(this.downSeq++, monoNs(), payload), { binary: true });
      this.stats.downFrames += 1;
    }
  }

  sendJson(value) { try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(value)); } catch {} }

  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.paceTimer); clearTimeout(this.pollTimer); clearTimeout(this.loopbackTimer);
    this.abort.abort(new Error(`Watch session closed: ${reason}`));
    try { this.peer?.close(); } catch {}
    this.opus?.close();
    this.server.sessions.delete(this);
    if (code && this.ws.readyState <= 1) this.ws.close(code, reason);
    if (this.loopback) {
      const { frames, bytes, startedMs } = this.loopback;
      this.log('loopback_closed', { code: code ?? null, reason, frames, bytes, seconds: Math.round((Date.now() - startedMs) / 1000) });
      return;
    }
    this.log('closed', { code: code ?? null, reason, codec: this.codec ?? null, ...this.stats, readyMs: this.readyMs, firstUplinkMs: this.firstUplinkMs, ice: this.faultIce });
  }
}

function parseHello(hello) {
  if (hello?.type !== 'hello' || typeof hello.callId !== 'string' || !(UUID.test(hello.callId) || hello.callId === LOOPBACK_CALL_ID)) return null;
  if (hello.codec !== undefined && hello.codec !== 'pcm16k' && hello.codec !== 'opus16k') return null;
  if (hello.frameMs !== undefined && hello.frameMs !== 20 && hello.frameMs !== 40) return null;
  return hello;
}

export function createWatchAudioServer({
  host = '0.0.0.0', port = 16811, control, transport = 'tls', relay = false, wrtc = loadWrtc, maxSessions = 8,
  pollMs = 5_000, pollBackoffMs = 30_000, helloTimeoutMs = 90_000, connectTimeoutMs = 20_000, tickMs = 5, paceNowUs = monoUs,
  loopbackMaxMs = 10 * 60_000, uplinkGateDbfs = null,
  log = record => console.log(JSON.stringify({ ts: new Date().toISOString(), ...record })),
} = {}) {
  const server = { options: { control, transport, relay, wrtc, pollMs, pollBackoffMs, connectTimeoutMs, tickMs, paceNowUs, loopbackMaxMs, uplinkGateDbfs }, sessions: new Set(), log };
  const wss = new WebSocketServer({ host, port, path: '/ws/watch-audio', maxPayload: 64 * 1024 });
  server.wss = wss;
  wss.on('connection', (ws, req) => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    if (!token) { log({ event: 'rejected', reason: 'no_token' }); ws.close(CLOSE.UNAUTHORIZED, 'unauthorized'); return; }
    if (server.sessions.size >= maxSessions) { log({ event: 'rejected', reason: 'busy', sessions: server.sessions.size }); ws.close(CLOSE.BUSY, 'busy'); return; }
    const session = new WatchSession({ ws, token, server });
    server.sessions.add(session);
    // The watch may open the socket at ring time and send `hello` only once answered: an idle socket
    // holds a slot (counts toward maxSessions) but touches nothing in Control until `hello`.
    const helloTimer = setTimeout(() => session.close(CLOSE.HELLO_TIMEOUT, 'HELLO_TIMEOUT'), helloTimeoutMs);
    helloTimer.unref?.();
    ws.on('message', (data, isBinary) => {
      if (session.closed) return;
      // Frames sent before `ready` are dropped: queued, they would become a permanent backlog (the pacer drains at 1x).
      if (isBinary) { if (session.loopback) session.onLoopback(data); else if (session.peer) session.onUplink(data); return; }
      let message;
      try { message = JSON.parse(String(data)); } catch {}
      if (message?.type === 'ping') { session.sendJson({ type: 'pong', t: message.t, serverTimeMs: Date.now() }); return; }
      if (message?.type === 'token') { session.rotateToken(message.token); return; }
      if (session.callId) return;
      clearTimeout(helloTimer);
      const hello = parseHello(message);
      if (!hello) { session.close(CLOSE.BAD_HELLO, 'bad_hello'); return; }
      session.start(hello).catch(error => {
        if (session.closed) return;
        if (error instanceof ControlError && (error.status === 401 || error.status === 404)) { session.close(CLOSE.UNAUTHORIZED, 'unauthorized'); return; }
        const code = error instanceof ControlError ? (error.code ?? `CONTROL_${error.status}`) : 'MEDIA_CONNECT_FAILED';
        session.log('start_failed', { code, message: String(error?.message ?? error).slice(0, 160) });
        session.sendJson({ type: 'error', code });
        session.close(CLOSE.MEDIA, 'start_failed');
      });
    });
    ws.on('close', () => { clearTimeout(helloTimer); session.close(null, 'socket_closed'); });
    ws.on('error', error => log({ event: 'socket_error', callId: session.callId ?? null, message: error.message }));
  });
  server.close = () => new Promise(resolve => {
    for (const session of [...server.sessions]) session.close(1001, 'server_shutdown');
    wss.close(() => resolve());
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const transport = env.WATCH_MEDIA_TRANSPORT || 'tls';
  if (transport !== 'tls' && transport !== 'udp') throw new Error('WATCH_MEDIA_TRANSPORT must be tls or udp');
  const server = createWatchAudioServer({
    port: Number(env.WATCH_AUDIO_PORT || 16811),
    host: env.WATCH_AUDIO_HOST || '0.0.0.0',
    control: { origin: env.CONTROL_ORIGIN || 'http://127.0.0.1:16880', host: env.CONTROL_HOST || undefined },
    transport,
    relay: env.WATCH_MEDIA_RELAY === 'true',
    maxSessions: Number(env.WATCH_AUDIO_MAX_SESSIONS || 8),
    uplinkGateDbfs: env.WATCH_UPLINK_GATE_DBFS ? Number(env.WATCH_UPLINK_GATE_DBFS) : null,
  });
  server.wss.on('listening', () => server.log({ event: 'listening', port: server.wss.address().port, transport, relay: env.WATCH_MEDIA_RELAY === 'true', uplinkGateDbfs: server.options.uplinkGateDbfs, opus: { bitrate: OPUS_BITRATE, lossPct: OPUS_LOSS_PCT, complexity: OPUS_COMPLEXITY } }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close().then(() => process.exit(0)));
}
