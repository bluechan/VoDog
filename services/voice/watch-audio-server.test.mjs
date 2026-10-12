import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { CLOSE, createOpusCodec, createWatchAudioServer, packFrame } from './watch-audio-server.mjs';

const callId = '00000000-0000-4000-8000-000000000105';
const TOKEN = 'watch-token-0123456789abcdef';
const tlsOptions = { mediaNodeId: 'relay-primary', mediaEpoch: 1, iceTransportPolicy: 'relay', iceServers: [{ urls: ['turns:vodog.example.com:16802?transport=tcp'], username: 'u', credential: 'c' }] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeWrtc() {
  const state = { pcs: [], writes: [], sinks: [] };
  class PC {
    constructor(config) { this.config = config; this.connectionState = 'new'; this.iceGatheringState = 'complete'; this.closed = false; state.pcs.push(this); }
    addTrack() {}
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
    setLocalDescription(value) { this.localDescription = value; return Promise.resolve(); }
    setRemoteDescription() { this.connectionState = 'connected'; queueMicrotask(() => this.ontrack?.({ track: { kind: 'audio' } })); return Promise.resolve(); }
    close() { this.closed = true; this.connectionState = 'closed'; }
  }
  class Source { createTrack() { return { stop() {} }; } onData(frame) { state.writes.push(frame); } }
  class Sink { constructor() { state.sinks.push(this); } stop() {} }
  return { wrtc: async () => ({ RTCPeerConnection: PC, nonstandard: { RTCAudioSource: Source, RTCAudioSink: Sink } }), state };
}

async function fakeControl({ callStatus = 200, callState = 'connecting', meStatus = 200 } = {}) {
  const seen = [];
  const control = { callStatus, callState, meStatus };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, host: req.headers.host, body: body ? JSON.parse(body) : null });
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.method === 'GET' && req.url === `/api/v1/calls/${callId}`) {
        return control.callStatus === 200 ? send(200, { call: { id: callId, state: control.callState } }) : send(control.callStatus, { error: { code: 'NOT_FOUND' } });
      }
      if (req.method === 'GET' && req.url === '/api/v1/auth/me') {
        return control.meStatus === 200 ? send(200, { user: { id: 'u1' } }) : send(control.meStatus, { error: { code: 'UNAUTHORIZED' } });
      }
      if (req.url.endsWith('/media/options')) return send(200, tlsOptions);
      if (req.url.endsWith('/media/offer')) return send(200, { type: 'answer', sdp: 'answer' });
      send(404, { error: { code: 'NOT_FOUND' } });
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return { control, seen, origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

async function harness(opts = {}) {
  const ctl = await fakeControl(opts);
  const { wrtc, state } = fakeWrtc();
  const logs = [];
  let nowUs = 0;
  const server = createWatchAudioServer({
    host: '127.0.0.1', port: 0, control: { origin: ctl.origin, host: 'vodog.example.com' }, wrtc, maxSessions: opts.maxSessions ?? 8,
    pollMs: opts.pollMs ?? 5_000, pollBackoffMs: opts.pollBackoffMs, tickMs: 60_000, loopbackMaxMs: opts.loopbackMaxMs, uplinkGateDbfs: opts.uplinkGateDbfs ?? null, paceNowUs: () => nowUs, log: record => logs.push(record),
  });
  await once(server.wss, 'listening');
  const url = `ws://127.0.0.1:${server.wss.address().port}/ws/watch-audio`;
  const open = async (token = TOKEN) => {
    const ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const messages = [];
    ws.on('message', (data, isBinary) => messages.push(isBinary ? Buffer.from(data) : JSON.parse(String(data))));
    const closed = once(ws, 'close').then(([code]) => code);
    await once(ws, 'open');
    return { ws, messages, closed };
  };
  const until = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await wait(5); assert.ok(predicate(), 'condition not reached'); };
  const advance = ms => { nowUs += ms * 1000; for (const s of server.sessions) s.tick(); };
  const teardown = async () => { await server.close(); ctl.close(); };
  return { ctl, state, logs, server, open, until, advance, teardown };
}

const hello = (extra = {}) => JSON.stringify({ type: 'hello', callId, codec: 'pcm16k', deviceName: 'Watch', ...extra });

test('handshake without a bearer token or with an unknown call closes 4401', async () => {
  const h = await harness({ callStatus: 404 });
  const anonymous = await h.open(null);
  assert.equal(await anonymous.closed, CLOSE.UNAUTHORIZED);
  const c = await h.open();
  c.ws.send(hello());
  assert.equal(await c.closed, CLOSE.UNAUTHORIZED);
  assert.equal(h.ctl.seen[0].auth, `Bearer ${TOKEN}`);
  assert.equal(h.ctl.seen[0].host, 'vodog.example.com');
  assert.equal(h.state.pcs.length, 0, 'no media leg for an unauthorized call');
  await h.teardown();
});

test('malformed hello closes 4400; a ninth socket is refused busy', async () => {
  const h = await harness({ maxSessions: 1 });
  const bad = await h.open();
  bad.ws.send(JSON.stringify({ type: 'hello', callId: 'nope' }));
  assert.equal(await bad.closed, CLOSE.BAD_HELLO);
  const first = await h.open();
  const second = await h.open();
  assert.equal(await second.closed, CLOSE.BUSY);
  first.ws.close();
  await h.teardown();
});

test('hello → options(tls, relay) + offer → ready; a ringing call is not terminal', async () => {
  const h = await harness({ callState: 'incoming_ringing' });
  const c = await h.open();
  c.ws.send(hello());
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  assert.deepEqual(c.messages.find(m => m.type === 'ready'), { type: 'ready', mediaNodeId: 'relay-primary', codec: 'pcm16k' });
  const options = h.ctl.seen.find(r => r.url.endsWith('/media/options'));
  assert.deepEqual(options.body, { transport: 'tls', relay: false });
  assert.equal(options.auth, `Bearer ${TOKEN}`);
  assert.equal(h.ctl.seen.find(r => r.url.endsWith('/media/offer')).body.type, 'offer');
  assert.equal(h.state.pcs[0].config.iceTransportPolicy, 'relay');
  c.ws.close();
  await h.teardown();
});

const frameOf = (value, bytes = 1280) => { const pcm = Buffer.alloc(bytes); for (let i = 0; i < bytes / 2; i++) pcm.writeInt16LE(value, i * 2); return pcm; };
const isSilence = w => w.samples.every(s => s === 0);

test('uplink: 40 ms frames slice into 10 ms writes behind a prebuffer gate (6 slices or 150 ms); bad sizes are ignored', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello());
  c.ws.send(packFrame(0, 0n, Buffer.alloc(1280, 1))); // before ready: must not become a backlog
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  h.state.writes.length = 0;
  const pcm = Buffer.alloc(1280);
  for (let i = 0; i < 640; i++) pcm.writeInt16LE(i + 1, i * 2);
  c.ws.send(packFrame(0, 1n, pcm));
  c.ws.send(Buffer.alloc(12 + 640)); // 20 ms frame on a 40 ms session: dropped
  const session = [...h.server.sessions][0];
  await h.until(() => session.stats.upFrames === 2);
  h.advance(60); // six frames due, catch-up bounded to five; 4 slices < 6 and 60 ms < 150 ms: all silence
  assert.equal(h.state.writes.length, 5);
  h.advance(0);
  assert.equal(h.state.writes.length, 5, 'the stalled frame is not replayed as a burst');
  h.advance(80); // t = 140 ms: still gated
  assert.equal(h.state.writes.length, 10);
  assert.ok(h.state.writes.every(isSilence));
  h.advance(10); // t = 150 ms: the timeout opens the gate
  h.advance(30);
  const audio = h.state.writes.slice(10);
  assert.equal(audio.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(audio[i].numberOfFrames, 160);
    assert.equal(audio[i].samples[0], i * 160 + 1, 'contiguous, in order');
  }
  assert.equal(session.stats.uplinkRebuffers, 0);
  h.advance(10);
  assert.ok(isSilence(h.state.writes.at(-1)));
  assert.equal(session.stats.uplinkRebuffers, 1, 'running dry mid-call re-arms once');
  assert.equal(session.stats.upBadFrames, 1);
  assert.equal(session.stats.upDropped, 0, 'the pre-ready frame was never queued');
  assert.equal(session.stats.silenceFrames, 11);
  c.ws.close();
  await h.until(() => h.logs.some(l => l.event === 'closed'));
  const closed = h.logs.find(l => l.event === 'closed');
  for (const key of ['uplinkRebuffers', 'uplinkOverflowDrops', 'downFrames', 'silenceFrames', 'firstUplinkMs', 'readyMs']) assert.ok(key in closed, key);
  assert.equal(closed.uplinkRebuffers, 1);
  assert.equal(closed.silenceFrames, 11);
  assert.equal(closed.readyMs, 0); // fake pacer clock does not move before ready
  assert.equal(closed.firstUplinkMs, 0);
  await h.teardown();
});

test('uplink: 6 slices start playout at once; after running dry it waits for 40 ms again, then plays the burst contiguously', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello({ frameMs: 20 }));
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  const session = [...h.server.sessions][0];
  h.state.writes.length = 0;
  for (let k = 1; k <= 3; k++) c.ws.send(packFrame(k, 0n, frameOf(k, 640)));
  await h.until(() => session.stats.upFrames === 3);
  h.advance(10);
  assert.equal(h.state.writes[0].samples[0], 1, 'six slices: no 150 ms wait');
  h.advance(50);
  assert.deepEqual(h.state.writes.map(w => w.samples[0]), [1, 1, 2, 2, 3, 3]);
  h.advance(10);
  assert.ok(isSilence(h.state.writes.at(-1)));
  assert.equal(session.stats.uplinkRebuffers, 1);
  c.ws.send(packFrame(4, 0n, frameOf(4, 640)));
  await h.until(() => session.stats.upFrames === 4);
  h.advance(10);
  assert.ok(isSilence(h.state.writes.at(-1)), '20 ms after a dry-out is below the 40 ms re-arm');
  c.ws.send(packFrame(5, 0n, frameOf(5, 640)));
  await h.until(() => session.stats.upFrames === 5);
  h.advance(40);
  assert.deepEqual(h.state.writes.slice(-4).map(w => w.samples[0]), [4, 4, 5, 5]);
  assert.equal(session.stats.uplinkRebuffers, 1, 'the dry-out is counted once, not per silent slice');
  c.ws.close();
  await h.teardown();
});

test('uplink overflow drops the oldest whole 40 ms group at 120 slices', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello());
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  const session = [...h.server.sessions][0];
  for (let k = 1; k <= 31; k++) c.ws.send(packFrame(k, 0n, frameOf(k)));
  await h.until(() => session.stats.upFrames === 31);
  assert.equal(session.uplink.length, 120);
  assert.equal(session.stats.uplinkOverflowDrops, 1);
  assert.equal(session.stats.upDropped, 4);
  assert.equal(session.uplink[0].readInt16LE(0), 2, 'frame 1 went as a whole group');
  assert.equal(session.uplink.filter(slice => slice.readInt16LE(0) === 2).length, 4);
  c.ws.close();
  await h.teardown();
});

test('downlink: 48 kHz PCM is resampled to 16 kHz and packed in frameMs frames with a 12 B header', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello({ frameMs: 20 }));
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  await h.until(() => h.state.sinks.length === 1);
  for (let i = 0; i < 5; i++) h.state.sinks[0].ondata({ samples: new Int16Array(480), sampleRate: 48_000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
  await h.until(() => c.messages.filter(Buffer.isBuffer).length === 2); // 50 ms → two 20 ms frames, 10 ms pending
  const frames = c.messages.filter(Buffer.isBuffer);
  assert.deepEqual(frames.map(f => f.length), [12 + 640, 12 + 640]);
  assert.deepEqual(frames.map(f => f.readUInt32BE(0)), [0, 1]);
  assert.ok(frames[1].readBigUInt64BE(4) >= frames[0].readBigUInt64BE(4));
  c.ws.close();
  await h.teardown();
});

test('socket close closes the peer; terminal poll closes 4410; peer fault sends MEDIA_FAULT', async () => {
  const h = await harness({ pollMs: 20 });
  const a = await h.open();
  a.ws.send(hello());
  await h.until(() => a.messages.some(m => m.type === 'ready'));
  a.ws.close();
  await h.until(() => h.state.pcs[0].closed);

  const b = await h.open();
  b.ws.send(hello());
  await h.until(() => b.messages.some(m => m.type === 'ready'));
  h.ctl.control.callState = 'ended';
  assert.equal(await b.closed, CLOSE.TERMINAL);
  assert.equal(h.state.pcs[1].closed, true);

  h.ctl.control.callState = 'active';
  const c = await h.open();
  c.ws.send(hello());
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  [...h.server.sessions][0].peer.emit('fault', new Error('WebRTC connection failed'));
  assert.equal(await c.closed, CLOSE.MEDIA);
  assert.deepEqual(c.messages.find(m => m.type === 'error'), { type: 'error', code: 'MEDIA_FAULT', ice: null });
  assert.equal(h.state.pcs[2].closed, true);
  assert.equal(h.server.sessions.size, 0);

  const d = await h.open();
  d.ws.send(hello());
  await h.until(() => d.messages.some(m => m.type === 'ready'));
  const error = new Error('WebRTC connection failed');
  error.iceStats = { connectionState: 'failed', iceConnectionState: 'failed', candidatePairs: 1, pair: { state: 'succeeded', local: 'relay/udp/tls', remote: 'relay/udp', rttMs: 40, consentRequestsSent: 7 } };
  [...h.server.sessions][0].peer.emit('fault', error);
  assert.equal(await d.closed, CLOSE.MEDIA);
  const ice = { connectionState: 'failed', local: 'relay/udp/tls', remote: 'relay/udp', consentRequestsSent: 7 };
  assert.deepEqual(d.messages.find(m => m.type === 'error'), { type: 'error', code: 'MEDIA_FAULT', ice });
  const closed = h.logs.filter(l => l.event === 'closed').at(-1);
  assert.equal(closed.code, CLOSE.MEDIA);
  assert.deepEqual(closed.ice, ice);
  await h.teardown();
});

test('an idle socket holds a slot without touching Control, answers ping, and times out 4408', async () => {
  const ctl = await fakeControl();
  const { wrtc } = fakeWrtc();
  const server = createWatchAudioServer({ host: '127.0.0.1', port: 0, control: { origin: ctl.origin }, wrtc, maxSessions: 1, helloTimeoutMs: 150, log: () => {} });
  await once(server.wss, 'listening');
  const url = `ws://127.0.0.1:${server.wss.address().port}/ws/watch-audio`;
  const connect = () => { const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } }); const messages = []; ws.on('message', d => messages.push(JSON.parse(String(d)))); return { ws, messages, closed: once(ws, 'close').then(([code, reason]) => [code, String(reason)]) }; };
  const idle = connect();
  await once(idle.ws, 'open');
  idle.ws.send(JSON.stringify({ type: 'ping', t: 7 }));
  for (let i = 0; i < 100 && !idle.messages.length; i++) await wait(5);
  assert.equal(idle.messages[0].type, 'pong'); assert.equal(idle.messages[0].t, 7); assert.equal(typeof idle.messages[0].serverTimeMs, 'number');
  const second = connect();
  assert.deepEqual(await second.closed, [CLOSE.BUSY, 'busy'], 'idle sockets count toward the limit');
  assert.deepEqual(await idle.closed, [CLOSE.HELLO_TIMEOUT, 'HELLO_TIMEOUT']);
  assert.equal(ctl.seen.length, 0, 'no Control call before hello');
  await server.close(); ctl.close();
});

test('loopback: /auth/me 200 → ready(loopback), binary frames echo verbatim, ping → pong, no media routes or peer', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello({ callId: 'loopback' }));
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  assert.deepEqual(c.messages.find(m => m.type === 'ready'), { type: 'ready', mediaNodeId: 'loopback' });
  const frame = packFrame(9, 123456789n, frameOf(77));
  c.ws.send(frame);
  c.ws.send(JSON.stringify({ type: 'ping', t: 3 }));
  await h.until(() => c.messages.some(Buffer.isBuffer) && c.messages.some(m => m.type === 'pong'));
  assert.ok(c.messages.find(Buffer.isBuffer).equals(frame), 'same header + PCM');
  assert.equal(c.messages.find(m => m.type === 'pong').t, 3);
  assert.deepEqual(h.ctl.seen.map(r => r.url), ['/api/v1/auth/me']);
  assert.equal(h.ctl.seen[0].auth, `Bearer ${TOKEN}`);
  assert.equal(h.state.pcs.length, 0);
  assert.equal(h.server.sessions.size, 1, 'counts toward the session cap');
  assert.ok(h.logs.some(l => l.event === 'loopback_open' && l.callId === 'loopback'));
  c.ws.close();
  assert.equal(await c.closed, 1005);
  await h.until(() => h.logs.some(l => l.event === 'loopback_closed'));
  const closed = h.logs.find(l => l.event === 'loopback_closed');
  assert.equal(closed.frames, 1); assert.equal(closed.bytes, frame.length); assert.equal(typeof closed.seconds, 'number');
  assert.equal(h.server.sessions.size, 0);
  await h.teardown();
});

test('loopback: /auth/me 401 closes 4401; the time limit closes 4410', async () => {
  const h = await harness({ meStatus: 401, loopbackMaxMs: 50 });
  const a = await h.open();
  a.ws.send(hello({ callId: 'loopback' }));
  assert.equal(await a.closed, CLOSE.UNAUTHORIZED);
  assert.ok(!a.messages.some(m => m.type === 'ready'));
  h.ctl.control.meStatus = 200;
  const b = await h.open();
  b.ws.send(hello({ callId: 'loopback' }));
  assert.equal(await b.closed, CLOSE.TERMINAL);
  assert.ok(b.messages.some(m => m.type === 'ready'));
  assert.equal(h.logs.filter(l => l.event === 'loopback_closed').at(-1).reason, 'loopback_limit');
  assert.equal(h.state.pcs.length, 0);
  await h.teardown();
});

test('S105k: poll 401/403 after ready keeps the session, logs poll_unauthorized once and backs off; 404 closes 4410', async () => {
  const h = await harness({ pollMs: 20, pollBackoffMs: 60_000 });
  const c = await h.open();
  c.ws.send(hello());
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  h.ctl.control.callStatus = 401;
  await h.until(() => h.logs.some(l => l.event === 'poll_unauthorized'));
  const polls = h.ctl.seen.length;
  await wait(150); // seven normal poll periods
  assert.equal(h.ctl.seen.length, polls, 'backed off: no further polls');
  assert.equal(h.logs.filter(l => l.event === 'poll_unauthorized').length, 1);
  assert.equal(h.logs.find(l => l.event === 'poll_unauthorized').nextPollMs, 60_000);
  assert.equal(h.server.sessions.size, 1);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.equal(h.state.pcs[0].closed, false, 'media leg untouched');
  // A rotated token resumes the normal cadence; a 404 on that poll then closes 4410.
  h.ctl.control.callStatus = 404;
  c.ws.send(JSON.stringify({ type: 'token', token: 'rotated-token-0123456789abcdef' }));
  assert.equal(await c.closed, CLOSE.TERMINAL);
  await h.teardown();
});

test('S105k: a 403 poll after ready also keeps the session', async () => {
  const h = await harness({ pollMs: 20, pollBackoffMs: 60_000 });
  const c = await h.open();
  c.ws.send(hello());
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  h.ctl.control.callStatus = 403;
  await h.until(() => h.logs.some(l => l.event === 'poll_unauthorized' && l.status === 403));
  await wait(60);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.ws.close();
  await h.teardown();
});

test('S105k: {type:"token"} rotates the token used by the next poll; a malformed token is refused without closing', async () => {
  const h = await harness({ pollMs: 20 });
  const c = await h.open();
  c.ws.send(hello());
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  const fresh = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
  c.ws.send(JSON.stringify({ type: 'token', token: fresh }));
  await h.until(() => c.messages.some(m => m.type === 'token_ok'));
  await h.until(() => h.ctl.seen.some(r => r.auth === `Bearer ${fresh}`)); // an in-flight poll may still carry the old one
  assert.ok(h.logs.some(l => l.event === 'token_rotated'));
  assert.ok(!JSON.stringify(h.logs).includes(fresh), 'token never logged');
  c.ws.send(JSON.stringify({ type: 'token', token: 'short' }));
  c.ws.send(JSON.stringify({ type: 'token', token: 'x'.repeat(4097) }));
  await h.until(() => c.messages.filter(m => m.type === 'error' && m.code === 'BAD_TOKEN').length === 2);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  const n = h.ctl.seen.length;
  await h.until(() => h.ctl.seen.length > n);
  assert.equal(h.ctl.seen.at(-1).auth, `Bearer ${fresh}`, 'refused token did not replace the session token');
  c.ws.close();
  await h.teardown();
});

test('S105k: a 401 on the hello lookup still closes 4401 with no media leg', async () => {
  const h = await harness({ callStatus: 401 });
  const c = await h.open();
  c.ws.send(hello());
  assert.equal(await c.closed, CLOSE.UNAUTHORIZED);
  assert.equal(h.state.pcs.length, 0);
  assert.ok(!h.logs.some(l => l.event === 'poll_unauthorized'));
  await h.teardown();
});

test('S105n: uplink gate replaces frames under the threshold with silence, keeps loud frames and a 300 ms hangover; off by default', async () => {
  const quiet = Buffer.alloc(1280); for (let i = 0; i < 640; i++) quiet.writeInt16LE(30, i * 2);   // ≈ −61 dBFS
  const loud = Buffer.alloc(1280); for (let i = 0; i < 640; i++) loud.writeInt16LE(3000, i * 2);   // ≈ −21 dBFS
  for (const gate of [null, -50]) {
    const h = await harness({ uplinkGateDbfs: gate });
    const c = await h.open();
    c.ws.send(hello());
    await h.until(() => c.messages.some(m => m.type === 'ready'));
    const session = [...h.server.sessions][0];
    const tail = () => session.uplink.slice(-4).map(b => b.readInt16LE(0));
    const push = async (seq, pcm, ms) => { h.advance(ms); c.ws.send(packFrame(seq, BigInt(seq + 1), pcm)); await h.until(() => session.stats.upFrames === seq + 1); return tail(); };
    assert.deepEqual(await push(0, quiet, 0), gate === null ? [30, 30, 30, 30] : [0, 0, 0, 0], 'quiet with no hangover is gated');
    assert.deepEqual(await push(1, loud, 40), [3000, 3000, 3000, 3000], 'loud passes and opens the hangover');
    assert.deepEqual(await push(2, quiet, 40), [30, 30, 30, 30], 'quiet inside the 300 ms hangover is kept');
    assert.deepEqual(await push(3, quiet, 300), gate === null ? [30, 30, 30, 30] : [0, 0, 0, 0], 'quiet after the hangover is gated again');
    assert.equal(session.stats.gatedFrames, gate === null ? 0 : 2);
    c.ws.close();
    await h.until(() => h.logs.some(l => l.event === 'closed'));
    await h.teardown();
  }
});

const sine40ms = (amp = 8000) => { const pcm = Buffer.alloc(1280); for (let i = 0; i < 640; i++) pcm.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2); return pcm; };
const peak = samples => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('S112 opus16k: hello → ready(codec); a real Opus packet decodes to 4 slices and reaches the peer as audio', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello({ codec: 'opus16k' }));
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  assert.deepEqual(c.messages.find(m => m.type === 'ready'), { type: 'ready', mediaNodeId: 'relay-primary', codec: 'opus16k' });
  const session = [...h.server.sessions][0];
  h.state.writes.length = 0;
  const codec = await createOpusCodec(40);
  for (let k = 0; k < 3; k++) {
    const packet = codec.encode(sine40ms());
    assert.ok(packet.length > 0 && packet.length < 400);
    c.ws.send(packFrame(k, BigInt(k), packet));
  }
  codec.close();
  await h.until(() => session.stats.upFrames === 3);
  assert.equal(session.stats.upBadFrames, 0);
  assert.equal(session.uplink.length, 12, 'each packet decoded to exactly 40 ms');
  for (let i = 0; i < 12; i++) h.advance(10); // 12 queued slices ≥ 6: playout starts at once
  assert.equal(h.state.writes.length, 12);
  assert.ok(h.state.writes.slice(4).every(w => peak(w.samples) > 2000), 'decoded sine is audio, not silence');
  c.ws.close();
  await h.until(() => h.logs.some(l => l.event === 'closed'));
  assert.equal(h.logs.find(l => l.event === 'closed').codec, 'opus16k');
  await h.teardown();
});

test('S112 opus16k: undecodable / wrong-length / empty / oversize payloads count upBadFrames and queue silence', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello({ codec: 'opus16k' }));
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  const session = [...h.server.sessions][0];
  const payloads = [Buffer.from('hello garbage'), Buffer.alloc(0), Buffer.alloc(5000, 0xff), Buffer.from([0x03, 0x00])];
  payloads.forEach((p, k) => c.ws.send(packFrame(k, 0n, p)));
  await h.until(() => session.stats.upFrames === payloads.length);
  assert.equal(session.stats.upBadFrames, payloads.length);
  assert.equal(session.uplink.length, payloads.length * 4);
  assert.ok(session.uplink.every(slice => slice.every(b => b === 0)));
  c.ws.close();
  await h.teardown();
});

test('S112 opus16k: downlink frames carry one Opus packet that decodes back to frameMs of PCM', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello({ codec: 'opus16k', frameMs: 40 }));
  await h.until(() => c.messages.some(m => m.type === 'ready'));
  await h.until(() => h.state.sinks.length === 1);
  const samples = new Int16Array(480);
  for (let i = 0; i < 480; i++) samples[i] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 48000));
  for (let i = 0; i < 9; i++) h.state.sinks[0].ondata({ samples, sampleRate: 48_000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
  await h.until(() => c.messages.filter(Buffer.isBuffer).length === 2); // 90 ms → two 40 ms frames
  const frames = c.messages.filter(Buffer.isBuffer);
  assert.deepEqual(frames.map(f => f.readUInt32BE(0)), [0, 1]);
  const codec = await createOpusCodec(40);
  for (const f of frames) {
    assert.ok(f.length > 12 && f.length < 12 + 1280, 'compressed payload');
    const pcm = codec.decode(f.subarray(12));
    assert.ok(pcm, 'decodes'); assert.equal(pcm.length, 1280);
  }
  codec.close();
  assert.equal([...h.server.sessions][0].stats.downFrames, 2);
  c.ws.close();
  await h.teardown();
});

test('S112: an unknown codec closes 4400', async () => {
  const h = await harness();
  const c = await h.open();
  c.ws.send(hello({ codec: 'g711' }));
  assert.equal(await c.closed, CLOSE.BAD_HELLO);
  assert.equal(h.ctl.seen.length, 0);
  await h.teardown();
});
