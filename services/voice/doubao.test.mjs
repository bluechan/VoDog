import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DOUBAO_ENV_KEYS, DoubaoVoiceAgent, doubaoConfig, doubaoConfigured, doubaoFaultKind, doubaoRealtimeUrl, float32ToPcm16 } from './providers/doubao.mjs';
import { availableProviders, createVoiceAgent, providerConfig, providerLabel } from './providers/index.mjs';

/** The same fake socket the xAI suite uses; `socketFactory` is the adapter's only injection point. */
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close() { this.readyState = 3; this.emit('close'); }
}

/** A live session: open the socket, answer `session.create` with `session.created`. */
async function ready(options = {}) {
  const socket = new Socket();
  const agent = new DoubaoVoiceAgent({ apiKey: 'test', instructions: '你是一名沉着、专业的个人助理秘书。', socketFactory: () => socket, ...options });
  const started = agent.start();
  socket.emit('open');
  socket.emit('message', Buffer.from('{"type":"session.created","event_id":"event_1","session":{"id":"dlg_1"}}'));
  const info = await started;
  return { agent, socket, info };
}
const typesOf = socket => socket.sent.map(event => event.type);
const appendsOf = socket => socket.sent.filter(event => event.type === 'input_audio_buffer.append');
/** S127: caller finals carry a wall-clock `timing`; compare the rest exactly and check it on its own. */
const untimed = ({ timing, ...event }) => event;

test('S27: session.create carries the frozen protocol shape and the session is muted the moment it opens', async () => {
  const { agent, socket, info } = await ready({ voice: 'zh_female_zhixingnv_uranus_bigtts', speed: 10, loudness: -5 });
  const create = socket.sent[0];
  assert.equal(create.type, 'session.create');
  assert.match(create.event_id, /^evt_\d+$/);
  assert.equal(create.session.model, '1.2.6.1');
  assert.equal(create.session.instructions, '你是一名沉着、专业的个人助理秘书。');
  assert.deepEqual(create.session.audio.input.format, { type: 'pcm', rate: 16_000 });
  assert.deepEqual(create.session.audio.output.format, { type: 'pcm', rate: 24_000 });
  assert.equal(create.session.audio.output.voice, 'zh_female_zhixingnv_uranus_bigtts');
  assert.deepEqual([create.session.audio.output.speed, create.session.audio.output.loudness], [10, -5]);
  assert.equal(create.session.tools, undefined, 'the end_call tool is off by default');
  assert.deepEqual(create.extension.asr, {});
  assert.deepEqual(create.extension.tts, {});
  assert.deepEqual(create.extension.dialog.extra, { strict_audit: true, enable_user_query_exit: true });
  // The worker prewarms up to 30 s before the caller says anything; without the mute the server
  // times out waiting for an upstream audio frame and then never answers.
  assert.equal(socket.sent[1].type, 'input_audio_mute.commit');
  assert.deepEqual(info, { provider: 'doubao', sessionId: 'dlg_1', model: '1.2.6.1' });
  assert.equal(agent.sessionId, 'dlg_1');
  agent.stop();
});

test('S27: optional tuning stays out of the payload and the end_call tool is declared only when enabled', async () => {
  const plain = await ready();
  assert.equal('speed' in plain.socket.sent[0].session.audio.output, false);
  assert.equal('loudness' in plain.socket.sent[0].session.audio.output, false);
  plain.agent.stop();
  const tooled = await ready({ endCallTool: true, strictAudit: false, exitIntent: false });
  const [tool] = tooled.socket.sent[0].session.tools;
  assert.equal(tool.name, 'end_call');
  assert.equal(tool.type, 'function');
  assert.deepEqual(tool.parameters.required, ['reason']);
  assert.deepEqual(tool.parameters.properties.reason.enum, ['sales_refused', 'info_collected', 'abusive', 'other']);
  assert.deepEqual(tooled.socket.sent[0].extension.dialog.extra, { strict_audit: false, enable_user_query_exit: false });
  tooled.agent.stop();
});

test('S27: the greeting is one speech_text_buffer.commit and never repeats', async () => {
  const { agent, socket } = await ready({ greeting: '您好！我是 VoDog AI 助理，代用户接听电话。' });
  assert.equal(agent.greet(), true);
  assert.equal(agent.greet(), false);
  const greetings = socket.sent.filter(event => event.type === 'speech_text_buffer.commit');
  assert.equal(greetings.length, 1);
  assert.equal(greetings[0].text, '您好！我是 VoDog AI 助理，代用户接听电话。');
  agent.stop();
});

test('S27: caller audio is unmuted once and paced as 20 ms packets instead of one 100 ms burst', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  agent.appendAudio(Buffer.alloc(3_200, 3), { sequence: 4 });
  // S98: the unmute goes first and the packet that is due now leaves with it; the other four wait for
  // the pacer — a burst of five packets is what the provider calls "too fast".
  assert.deepEqual(typesOf(socket).slice(-2), ['input_audio_unmute.commit', 'input_audio_buffer.append']);
  assert.equal(appendsOf(socket).length, 1);
  t.mock.timers.tick(20); assert.equal(appendsOf(socket).length, 2);
  t.mock.timers.tick(20); assert.equal(appendsOf(socket).length, 3);
  t.mock.timers.tick(60); assert.equal(appendsOf(socket).length, 5);
  for (const append of appendsOf(socket)) assert.equal(Buffer.from(append.audio, 'base64').length, 640);
  assert.equal(Buffer.concat(appendsOf(socket).map(a => Buffer.from(a.audio, 'base64'))).equals(Buffer.alloc(3_200, 3)), true);
  // A second batch does not re-send the unmute, and the pacer restarts on its own.
  agent.appendAudio(Buffer.alloc(3_200, 4), { sequence: 9 });
  assert.equal(socket.sent.filter(event => event.type === 'input_audio_unmute.commit').length, 1);
  assert.equal(appendsOf(socket).length, 6);
  t.mock.timers.tick(100);
  assert.equal(appendsOf(socket).length, 10);
  agent.stop();
});

// S98: the bridge now hands Doubao one 20 ms frame per append (`inputBatchFrames: 1`) instead of a
// 100 ms batch, and the frames already arrive at real-time cadence.
test('S98: a frame arriving on cadence leaves at once; frames that bunch up are still paced at 20 ms', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  assert.equal(agent.inputBatchFrames, 1);
  let sequence = 0;
  const frame = () => agent.appendAudio(Buffer.alloc(640, 1), { sequence: sequence++ });
  frame(); assert.equal(appendsOf(socket).length, 1, 'no wait for a fresh 20 ms tick');
  t.mock.timers.tick(20); frame(); assert.equal(appendsOf(socket).length, 2);
  // The bridge's own jitter: a frame a few milliseconds early is still on cadence.
  t.mock.timers.tick(15); frame(); assert.equal(appendsOf(socket).length, 3);
  assert.equal(agent.pacer, undefined, 'nothing queued, nothing ticking');
  // A stalled main thread delivers three frames at once: one leaves now, the others at real time.
  t.mock.timers.tick(20); frame(); frame(); frame();
  assert.deepEqual([appendsOf(socket).length, agent.queue.length], [4, 2]);
  t.mock.timers.tick(20); assert.equal(appendsOf(socket).length, 5);
  t.mock.timers.tick(20); assert.equal(appendsOf(socket).length, 6);
  assert.deepEqual([agent.queue.length, agent.pacer], [0, undefined]);
  agent.stop();
});

test('S27: a backlog past one second drops the oldest packets and reports it once', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  for (let i = 0; i < 12; i++) agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 + i * 5 });
  // S98: the first packet left on arrival; 59 more were queued against a cap of 50.
  assert.equal(agent.queue.length, 50);
  assert.equal(agent.droppedPackets, 9);
  assert.deepEqual(notices, ['input_backlog']);
  assert.equal(appendsOf(socket).length, 1);
  agent.stop();
  assert.equal(agent.queue.length, 0);
});

test('S27: a late pacer catches up at three packets a tick, never faster and never by dropping', async () => {
  const { agent, socket } = await ready();
  for (let i = 0; i < 4; i++) agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 + i * 5 });
  // S98: the first packet left on arrival.
  assert.deepEqual([appendsOf(socket).length, agent.queue.length], [1, 19]);
  // A 250 ms event-loop stall: the packets that were due during it are still owed. Sending one per
  // tick from here would leave the upstream permanently 250 ms late (in and out are both 5 packets
  // per 100 ms, so the backlog would never drain) — the caller's words reach the model late for the
  // rest of the call. Sending them all at once is what the provider calls "too fast".
  agent.nextSendAtMs = Date.now() - 250;
  for (let tick = 1; tick <= 4; tick++) {
    agent.drainAudio();
    assert.equal(appendsOf(socket).length, 1 + tick * 3, `tick ${tick} sent more than the catch-up bound`);
  }
  agent.drainAudio();
  const sent = appendsOf(socket).length;
  assert.ok(sent >= 14 && sent <= 15, `caught up to ${sent} packets`);
  agent.drainAudio();
  assert.equal(appendsOf(socket).length, sent, 'a caught-up pacer must not run ahead of real time');
  assert.equal(sent + agent.queue.length, 20, 'a stall must never lose caller audio');
  agent.stop();
});

test('S27: appendAudio keeps the same boundaries as every other provider', async () => {
  const { agent } = await ready();
  agent.appendAudio(Buffer.alloc(640), { sequence: 0 });
  assert.throws(() => agent.appendAudio(Buffer.alloc(640), { sequence: 0 }), /sequence/);
  assert.throws(() => agent.appendAudio(Buffer.alloc(640), { sequence: 1, sampleRate: 24_000 }), /PCM16/);
  assert.throws(() => agent.appendAudio(Buffer.alloc(641), { sequence: 1 }), /PCM16/);
  assert.throws(() => agent.appendAudio(Buffer.alloc(32_002), { sequence: 1 }), /PCM16/);
  agent.stop();
  assert.throws(() => agent.appendAudio(Buffer.alloc(640), { sequence: 2 }), /not ready/);
});

test('S27: 24 kHz output is resampled to the 16 kHz the playback queue assumes', async () => {
  // S129: digital silence in, so the lead-in trim is off — this is about the resampled byte count.
  const { agent, socket } = await ready({ outputFormat: 's16le', leadTrimRms: 0 });
  const audio = [];
  agent.on('audio', event => audio.push(event));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":"","tts_type":""}'));
  // 100 ms at 24 kHz = 2400 samples; at 16 kHz the same 100 ms is 1600 samples / 3200 bytes.
  const delta = Buffer.alloc(4_800).toString('base64');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta })));
  assert.equal(audio.length, 1);
  assert.equal(audio[0].pcm.length, 3_200);
  assert.equal(audio[0].sampleRate, 16_000);
  assert.deepEqual([audio[0].responseId, audio[0].generation], ['resp_1', 0]);
  agent.stop();
});

test('S27: an audio delta that splits a sample carries the odd byte into the next one', async () => {
  // S129: 0x0101 samples are RMS 257, below the lead-in threshold; the trim is off so every byte is counted.
  const { agent, socket } = await ready({ outputFormat: 's16le', leadTrimRms: 0 });
  const audio = [];
  agent.on('audio', event => audio.push(event));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  // The provider is streaming bytes, not samples; a throw here would kill the provider thread.
  const first = Buffer.alloc(4_801, 1), second = Buffer.alloc(4_799, 1);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: first.toString('base64') })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: second.toString('base64') })));
  assert.equal(agent.state, 'ready');
  // 9600 bytes of 24 kHz in, 6400 bytes of 16 kHz out, and not one byte of the stream discarded.
  assert.equal(audio.reduce((total, event) => total + event.pcm.length, 0), 6_400);
  agent.stop();
});

test('S27: an error that arrives after session.close is the provider tidying up, not a fault', async () => {
  const { agent, socket } = await ready();
  const notices = [], faults = [];
  let closed = 0;
  agent.on('notice', notice => notices.push(notice.kind));
  agent.on('fault', error => faults.push(error));
  agent.on('closed', () => closed++);
  agent.stop();
  // Observed on relay-secondary 2026-09-12: `55000000 rpc error … the stream is done` lands ~300 ms after
  // our session.close and ~immediately before session.closed. Failing the run on it would turn
  // every clean hangup into a provider fault.
  socket.emit('message', Buffer.from('{"type":"error","error":{"code":"55000000","type":"Internal Server Error","message":"rpc error: code = 13 desc = the stream is done"}}'));
  assert.deepEqual([faults.length, closed], [0, 0], 'the close handshake must still be waiting');
  assert.deepEqual(notices, ['error_after_close']);
  socket.emit('message', Buffer.from('{"type":"session.closed"}'));
  assert.deepEqual([closed, agent.sessionClosedAck, faults.length], [1, true, 0]);
});

test('S27: the transcript contract is one caller final and one assistant final per response', async () => {
  const { agent, socket } = await ready();
  const transcripts = [], notices = [];
  agent.on('transcript', event => transcripts.push(event));
  agent.on('notice', notice => notices.push(notice.kind));
  // Real server shape (probe 2026-09-12): cumulative deltas, then `completed` with the text in `text`.
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"我是"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"我是顺丰"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.completed","item_id":"i1","text":"我是顺丰快递"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.delta","response_id":"resp_1","delta":"好的"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.delta","response_id":"resp_1","delta":"，我记下了"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.done","response_id":"resp_1","text":"好的，我记下了。"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.failed","error":{"code":"audio_unintelligible"}}'));
  assert.equal(transcripts[0].timing.via, 'completed');
  assert.deepEqual(transcripts.map(untimed), [
    { text: '我是顺丰快递', final: true, speaker: 'caller' },
    { text: '好的，我记下了。', final: true, responseId: 'resp_1' },
  ]);
  // A phrase the provider could not transcribe is a report, never a hangup.
  assert.deepEqual(notices, ['transcription_failed']);
  agent.stop();
});

test('S27: barge-in cancels the response, fences playback atomically and drops the late audio', async () => {
  const { agent, socket } = await ready();
  const events = [];
  for (const name of ['audio', 'flushAudio', 'speechStarted', 'completed', 'response']) agent.on(name, payload => events.push({ name, payload }));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":"resp_1"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started","item_id":"item_1"}'));
  assert.equal(socket.sent.at(-1).type, 'response.cancel');
  assert.equal(agent.outputGeneration, 1);
  // The generation bump and the flush are one step: the playback fence would otherwise misalign.
  const order = events.map(event => event.name);
  assert.deepEqual(order, ['response', 'flushAudio', 'speechStarted']);
  assert.deepEqual(events[1].payload, { generation: 1 });
  socket.emit('message', Buffer.from('{"type":"response.output_audio.delta","response_id":"resp_1","delta":"AAAAAAAA"}'));
  assert.equal(events.filter(event => event.name === 'audio').length, 0);
  socket.emit('message', Buffer.from('{"type":"response.canceled","event_id":"event_17"}'));
  const completed = events.find(event => event.name === 'completed').payload;
  assert.deepEqual(completed, { status: 'cancelled', responseId: 'resp_1', generation: 0, current: false });
  agent.stop();
});

test('S27: barge-in stays silent when nothing is playing, and DOUBAO_BARGE_IN=off disables it', async () => {
  const idle = await ready();
  let speech = 0, flushes = 0;
  idle.agent.on('speechStarted', () => speech++);
  idle.agent.on('flushAudio', () => flushes++);
  idle.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  assert.deepEqual([speech, flushes, idle.agent.outputGeneration], [1, 0, 0]);
  assert.equal(idle.socket.sent.some(event => event.type === 'response.cancel'), false);
  idle.agent.stop();

  const off = await ready({ bargeIn: 'off' });
  off.socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  let started = 0;
  off.agent.on('speechStarted', () => started++);
  off.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  assert.equal(off.socket.sent.some(event => event.type === 'response.cancel'), false);
  assert.deepEqual([started, off.agent.outputGeneration], [1, 0]);
  off.agent.stop();
});

/**
 * S98: `ms` of 24 kHz s16le output (48 bytes/ms) — exactly `ms` of 16 kHz playout once resampled.
 * S129: speech-level (0x1010 samples), so it is audible from its first block and the lead-in trim drops nothing.
 */
const audioDelta = (ms, responseId = '') => Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: responseId, delta: Buffer.alloc(ms * 48, 0x10).toString('base64') }));

/** S97: greet, then the server starts the greeting (`chat_tts_text`) and the caller starts talking. */
async function greeting(t, options = {}, apis = ['Date']) {
  t.mock.timers.enable({ apis });
  const session = await ready(options);
  const events = [];
  for (const name of ['audio', 'flushAudio', 'speechStarted']) session.agent.on(name, payload => events.push({ name, payload }));
  session.agent.greet();
  session.socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q0","response_id":"","tts_type":"chat_tts_text"}'));
  const speak = () => session.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  const cancels = () => session.socket.sent.filter(event => event.type === 'response.cancel').length;
  return { ...session, events, speak, cancels, count: name => events.filter(event => event.name === name).length };
}

test('S97: the caller speaking inside the greeting guard does not cut the greeting', async t => {
  // S129: the delta below is 30 bytes of zeros — less than one block — so the lead-in trim is off here.
  const g = await greeting(t, { leadTrimRms: 0 });
  t.mock.timers.tick(800);
  g.speak();
  assert.deepEqual([g.cancels(), g.count('flushAudio'), g.agent.outputGeneration, g.count('speechStarted')], [0, 0, 0, 1]);
  g.socket.emit('message', Buffer.from('{"type":"response.output_audio.delta","response_id":"","delta":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'));
  assert.equal(g.count('audio'), 1);
  assert.equal(g.events.find(event => event.name === 'audio').payload.generation, 0);
  g.agent.stop();
});

test('S97: after the guard expires the caller interrupts the greeting exactly as before', async t => {
  const g = await greeting(t);
  t.mock.timers.tick(2_500);
  g.speak();
  assert.deepEqual([g.cancels(), g.count('flushAudio'), g.agent.outputGeneration], [1, 1, 1]);
  assert.deepEqual(g.events.map(event => event.name), ['flushAudio', 'speechStarted']);
  g.agent.stop();
});

test('S97: DOUBAO_GREETING_GUARD_MS=0 restores the immediate greeting barge-in', async t => {
  const g = await greeting(t, { greetingGuardMs: doubaoConfig({ DOUBAO_API_KEY: 'k', DOUBAO_GREETING_GUARD_MS: '0' }).greetingGuardMs });
  g.speak();
  assert.deepEqual([g.cancels(), g.agent.outputGeneration], [1, 1]);
  g.agent.stop();
});

test('S97: only the greeting is guarded; a reply that starts inside the window is interruptible at once', async t => {
  const g = await greeting(t);
  t.mock.timers.tick(300);
  // The server answering the caller while the greeting window is still open ends the protection.
  g.socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":"resp_1","tts_type":"default"}'));
  g.speak();
  assert.deepEqual([g.cancels(), g.agent.outputGeneration], [1, 1]);
  g.agent.stop();

  // Without greet() a chat_tts_text response is not the greeting and is never guarded either.
  t.mock.timers.reset();
  const plain = await ready();
  plain.socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_2","tts_type":"default"}'));
  plain.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  assert.equal(plain.socket.sent.at(-1).type, 'response.cancel');
  plain.agent.stop();
});

test('S27: a finished response completes first and only then reports the exit intent', async () => {
  const { agent, socket } = await ready();
  const order = [];
  agent.on('completed', payload => order.push(['completed', payload]));
  agent.on('notice', notice => order.push(['notice', notice.kind]));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":""}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.done","question_id":"q1","response_id":"resp_1","status_code":"20000002"}'));
  assert.deepEqual(order.map(entry => entry[0]), ['completed', 'notice']);
  assert.deepEqual(order[0][1], { status: 'completed', responseId: 'resp_1', generation: 0, current: true, leadTrimMs: 0 });
  assert.equal(order[1][1], 'exit_intent');
  // `response.done` is usage accounting, not a call event.
  socket.emit('message', Buffer.from('{"type":"response.done"}'));
  assert.equal(order.length, 2);
  agent.stop();
});

test('S27: the exit intent stays quiet when DOUBAO_EXIT_INTENT is off', async () => {
  const { agent, socket } = await ready({ exitIntent: false });
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.done","response_id":"resp_1","status_code":"20000002"}'));
  assert.deepEqual(notices, []);
  agent.stop();
});

// S27 决策 12（2026-09-12 真实通话 + /tmp/doubao-endcall-check.mjs）: replying `{"ok":true}` to
// `end_call` makes the model append a narration（"已结束通话。"/"（已挂断）"）to the SAME response and
// the TTS voices it — a real caller heard「已挂断」. Not replying keeps the full goodbye audio (7.6 s
// measured) and produces no narration, but the server then never sends `response.output_text.done`
// for that response, so the goodbye has to be finalised from the buffer here or it never reaches
// the call record.
test('S27 决策 12: end_call is not answered, the goodbye is finalised from the buffer, and the notice comes last', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const order = [];
  agent.on('notice', notice => order.push(['notice', notice.kind]));
  agent.on('transcript', event => order.push(['transcript', event]));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_1', delta: '好的，' })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_1', delta: '再见。\n' })));
  const before = socket.sent.length;
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'end_call', arguments: '{"reason":"sales_refused"}' }],
  })));
  assert.equal(socket.sent.length, before, 'a tool reply is what makes the model narrate the hangup out loud');
  assert.deepEqual(order, [
    ['transcript', { text: '好的，再见。', final: true, responseId: 'resp_1' }],
    ['notice', 'end_call'],
  ]);
  assert.equal(agent.endCallRequested, true);
  // The server may never send it, but if it does the goodbye must not land in the record twice.
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_text.done', response_id: 'resp_1', text: '好的，再见。\n' })));
  assert.equal(order.length, 2, 'a late output_text.done for the same response is ignored');
  agent.stop();
});

test('S27 决策 12: a tool that is not end_call is still answered by call_id', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ id: 'item_1', type: 'function_call', call_id: 'call_2', name: 'lookup_order', arguments: '{}' }],
  })));
  const reply = socket.sent.at(-1);
  assert.equal(reply.type, 'conversation.item.create');
  assert.deepEqual(reply.items, [{ call_id: 'call_2', role: 'tool', content: [{ type: 'input_text', text: '{"ok":true}' }] }]);
  assert.deepEqual(notices, []);
  assert.equal(agent.endCallRequested, false);
  agent.stop();
});

// S27 决策 13: without an answer the server keeps the turn open and may drop the socket on its own.
// That close must not fence playback — the goodbye is still in the bridge's queue — and it must say
// so, or `worker.mjs` reports `provider_disconnected` for a call the AI ended on purpose.
test('S27 决策 13: after end_call a server close keeps the queued goodbye and reports ended_by_provider', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const flushes = [], closed = [];
  agent.on('flushAudio', event => flushes.push(event));
  agent.on('closed', payload => closed.push(payload));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ call_id: 'call_1', name: 'end_call', arguments: '{"reason":"sales_refused"}' }],
  })));
  socket.close();
  assert.deepEqual(flushes, [], 'a flush here clears the audio the caller has not heard yet');
  assert.deepEqual(closed, [{ reason: 'ended_by_provider' }]);
  assert.equal(agent.outputGeneration, 0);
});

test('S27 决策 13: an ordinary close still fences playback and carries an empty reason', async () => {
  const { agent, socket } = await ready();
  const flushes = [], closed = [];
  agent.on('flushAudio', event => flushes.push(event));
  agent.on('closed', payload => closed.push(payload));
  socket.close();
  assert.deepEqual(flushes, [{ generation: 1 }]);
  assert.deepEqual(closed, [{}]);
});

test('S27: provider errors are classified, reported as a kind and never carry the payload into a log', async () => {
  assert.equal(doubaoFaultKind('42000020'), 'doubao_request_rejected');
  assert.equal(doubaoFaultKind('45000003'), 'doubao_idle_timeout');
  assert.equal(doubaoFaultKind('55000001'), 'doubao_server_error');
  assert.equal(doubaoFaultKind('50700000'), 'doubao_server_error');
  assert.equal(doubaoFaultKind(undefined), 'doubao_error');
  for (const [code, kind] of [['42000020', 'doubao_request_rejected'], ['45000003', 'doubao_idle_timeout'], ['55000001', 'doubao_server_error']]) {
    const { agent, socket } = await ready();
    const notices = [], faults = [];
    agent.on('notice', notice => notices.push(notice.kind));
    agent.on('fault', error => faults.push(error));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'error', error: { code, message: 'x'.repeat(900) } })));
    assert.deepEqual(notices, [kind]);
    assert.equal(faults[0].code, kind);
    assert.ok(faults[0].message.length <= 200 + kind.length + 2);
    assert.equal(agent.state, 'closed');
  }
});

test('S27: stop() says goodbye and waits for session.closed before dropping the socket', async () => {
  const { agent, socket } = await ready();
  let closed = 0;
  agent.on('closed', () => closed++);
  agent.stop();
  // R11 §6.2: dropping the WebSocket without this handshake is recorded as 55000001 ContextCanceled.
  assert.equal(socket.sent.at(-1).type, 'session.close');
  assert.equal(socket.readyState, 1);
  assert.deepEqual([closed, agent.outputGeneration], [0, 1]);
  socket.emit('message', Buffer.from('{"type":"session.closed"}'));
  assert.equal(socket.readyState, 3);
  assert.deepEqual([closed, agent.sessionClosedAck], [1, true]);
  agent.stop();
  assert.equal(closed, 1);
});

test('S27: a server that never answers session.closed still ends the session on the bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { agent, socket } = await ready();
  let closed = 0;
  agent.on('closed', () => closed++);
  agent.stop();
  assert.equal(closed, 0);
  t.mock.timers.tick(2_000);
  assert.deepEqual([closed, socket.readyState, agent.sessionClosedAck], [1, 3, false]);
});

test('S27: a socket that dies mid-session closes once and never waits for a reply that cannot come', async () => {
  const { agent, socket } = await ready();
  let closed = 0;
  agent.on('closed', () => closed++);
  socket.close();
  assert.deepEqual([closed, agent.state], [1, 'closed']);
  // Aborting setup before a session exists must not put session.close on a socket with no session.
  const controller = new AbortController();
  const early = new Socket();
  const agentTwo = new DoubaoVoiceAgent({ apiKey: 'test', instructions: 'x', socketFactory: () => early });
  const started = agentTwo.start({ signal: controller.signal });
  controller.abort(new Error('lease lost'));
  await assert.rejects(started, /lease lost/);
  assert.equal(early.sent.some(event => event.type === 'session.close'), false);
});

test('S27: the endpoint is fixed, overridable only by a wss URL or a loopback test server', () => {
  assert.equal(doubaoRealtimeUrl(), 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  assert.equal(doubaoRealtimeUrl(''), 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  assert.equal(doubaoRealtimeUrl('wss://example.test/duplex'), 'wss://example.test/duplex');
  assert.equal(doubaoRealtimeUrl('ws://127.0.0.1:9001/duplex'), 'ws://127.0.0.1:9001/duplex');
  for (const value of ['http://openspeech.bytedance.com', 'ws://openspeech.bytedance.com', 'openspeech.bytedance.com', 'wss://', 'ws://192.0.2.21:9001'])
    assert.throws(() => doubaoRealtimeUrl(value), /DOUBAO_REALTIME_URL/);
});

test('S27: the API key is the only thing that decides whether this worker announces doubao', () => {
  assert.equal(doubaoConfigured({}), false);
  assert.equal(doubaoConfigured({ DOUBAO_API_KEY: '' }), false);
  assert.equal(doubaoConfigured({ DOUBAO_API_KEY: 'k' }), true);
  assert.deepEqual(availableProviders({ DOUBAO_API_KEY: 'k' }), ['doubao']);
  assert.deepEqual(availableProviders({ XAI_API_KEY: 'k', XAI_AGENT_ID: 'a', DOUBAO_API_KEY: 'k' }), ['xai', 'doubao']);
  assert.deepEqual(availableProviders({ XAI_API_KEY: 'k', XAI_AGENT_ID: 'a' }), ['xai']);
  assert.equal(providerLabel('doubao'), '豆包');
  // Known but unconfigured is reported exactly like an unknown id, and must stay that way.
  assert.throws(() => providerConfig({ provider: 'doubao', env: { XAI_API_KEY: 'k' } }), error => error.code === 'provider_unavailable');
});

test('S27: the startup parse produces structured-cloneable defaults and refuses every malformed value', () => {
  const config = providerConfig({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k' } });
  assert.equal(config.apiKey, 'k');
  assert.equal(config.model, '1.2.6.1');
  assert.equal(config.voice, 'zh_female_vv_jupiter_bigtts');
  assert.equal(config.greeting, '喂，您好！我是 VoDog AI 助理，代用户接听电话，您请说。');
  assert.deepEqual([config.strictAudit, config.exitIntent, config.endCallTool, config.bargeIn], [true, true, false, 'cancel']);
  assert.deepEqual([config.maxCallSeconds, config.silenceHangupSeconds], [180, 15]);
  assert.equal(config.greetingGuardMs, 2_500);
  assert.equal(doubaoConfig({ DOUBAO_API_KEY: 'k', DOUBAO_GREETING_GUARD_MS: '0' }).greetingGuardMs, 0);
  assert.equal('speed' in config, false);
  assert.equal('loudness' in config, false);
  assert.equal('realtimeUrl' in config, false);
  // The persona ships with the image, not in --env-file: docker env files cannot hold it.
  assert.match(config.instructions, /VoDog AI 电话助理/);
  assert.match(config.instructions, /不要编造用户的身份/);
  // Structured-cloneable on purpose: this object is what crosses into the provider thread.
  assert.deepEqual(structuredClone(config), config);

  const tuned = providerConfig({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k', DOUBAO_SPEED: '20', DOUBAO_LOUDNESS: '-50',
    DOUBAO_MAX_CALL_SECONDS: '60', DOUBAO_SILENCE_HANGUP_SECONDS: '0', DOUBAO_STRICT_AUDIT: 'false', DOUBAO_END_CALL_TOOL: 'true',
    DOUBAO_BARGE_IN: 'off', DOUBAO_VOICE: 'zh_female_zhixingnv_uranus_bigtts', DOUBAO_GREETING: '您好' } });
  assert.deepEqual([tuned.speed, tuned.loudness, tuned.maxCallSeconds, tuned.silenceHangupSeconds], [20, -50, 60, 0]);
  assert.deepEqual([tuned.strictAudit, tuned.endCallTool, tuned.bargeIn, tuned.greeting], [false, true, 'off', '您好']);

  const bad = {
    DOUBAO_MAX_CALL_SECONDS: ['59', '3601', '180.0', '1e2', 'soon', '+180'],
    DOUBAO_SILENCE_HANGUP_SECONDS: ['-1', '121', 'never'],
    DOUBAO_SPEED: ['-51', '101', 'fast'],
    DOUBAO_LOUDNESS: ['-51', '101', ''.padEnd(3, 'x')],
    DOUBAO_STRICT_AUDIT: ['yes', '1', 'maybe'],
    DOUBAO_EXIT_INTENT: ['on'],
    DOUBAO_END_CALL_TOOL: ['maybe'],
    DOUBAO_BARGE_IN: ['loud', 'OFF'],
    DOUBAO_GREETING_GUARD_MS: ['-1', '30001', '2.5s'],
    DOUBAO_VOICE: ['bad voice', 'a'.repeat(129)],
    DOUBAO_MODEL: ['bad/model', 'a'.repeat(65)],
    DOUBAO_REALTIME_URL: ['http://openspeech.bytedance.com', 'nope'],
    DOUBAO_INSTRUCTIONS_FILE: ['prompts/does-not-exist.md', '/nonexistent/persona.md'],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.throws(() => providerConfig({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k', [key]: value } }),
        error => new RegExp(key).test(error.message), `${key}=${value} was accepted`);
    }
  }
  assert.throws(() => doubaoConfig({}), /DOUBAO_API_KEY/);
  // Surrounding whitespace is trimmed on purpose: `secrets/voice.env` is written line by line and
  // docker's --env-file does no unquoting, so a stray space must not fail the service.
  const trimmed = doubaoConfig({ DOUBAO_API_KEY: ' k ', DOUBAO_STRICT_AUDIT: ' TRUE ', DOUBAO_BARGE_IN: ' off ', DOUBAO_MAX_CALL_SECONDS: ' 120 ' });
  assert.deepEqual([trimmed.apiKey, trimmed.strictAudit, trimmed.bargeIn, trimmed.maxCallSeconds], ['k', true, 'off', 120]);
  assert.equal(DOUBAO_ENV_KEYS.includes('DOUBAO_API_KEY'), true);
  assert.equal(DOUBAO_ENV_KEYS.every(key => key.startsWith('DOUBAO_')), true);
});

test('S27: the registry builds the real adapter from the parsed configuration', async () => {
  const socket = new Socket();
  const seen = [];
  const agent = createVoiceAgent({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k', DOUBAO_VOICE: 'zh_female_vv_uranus_bigtts' },
    overrides: { socketFactory: (url, options) => { seen.push({ url, options }); return socket; } } });
  assert.equal(agent instanceof DoubaoVoiceAgent, true);
  const started = agent.start();
  socket.emit('open');
  socket.emit('message', Buffer.from('{"type":"session.created","session":{"id":"dlg_1"}}'));
  await started;
  assert.equal(seen[0].url, 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  // R11 §1: the request header block is exactly one field, and nothing here weakens TLS.
  assert.deepEqual(seen[0].options.headers, { 'X-Api-Key': 'k' });
  assert.deepEqual(Object.keys(seen[0].options).sort(), ['handshakeTimeout', 'headers', 'maxPayload', 'perMessageDeflate']);
  // S98: base64 PCM barely compresses; zlib on every frame is CPU and latency for nothing.
  assert.equal(seen[0].options.perMessageDeflate, false);
  assert.equal(socket.sent[0].session.audio.output.voice, 'zh_female_vv_uranus_bigtts');
  assert.equal(typesOf(socket).includes('input_audio_mute.commit'), true);
  agent.stop();
});

// 2026-09-12 real-call finding: the server streams 32-bit little-endian floats in [-1, 1], not the
// int16 the documentation states. Decoding them as int16 is white-noise-like garbage (zero-crossing
// rate 0.47 per sample, full-scale peaks) — exactly the "robot noise" heard on the first three calls.
test('S27: output deltas are float32 by default and become PCM16 before resampling, across split samples', async () => {
  const { agent, socket } = await ready();
  const audio = [];
  agent.on('audio', event => audio.push(event));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1"}'));
  // 2400 float samples (100 ms at 24 kHz) of a 1 kHz sine at 0.5 amplitude.
  const floats = Buffer.alloc(2_400 * 4);
  for (let i = 0; i < 2_400; i++) floats.writeFloatLE(0.5 * Math.sin(2 * Math.PI * 1_000 * i / 24_000), i * 4);
  // Split at a byte offset that is not a multiple of 4: the remainder must carry over, nothing lost.
  const first = floats.subarray(0, 4_806), second = floats.subarray(4_806);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: first.toString('base64') })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: second.toString('base64') })));
  const pcm = Buffer.concat(audio.map(event => event.pcm));
  assert.equal(pcm.length, 3_200, '100 ms at 16 kHz');
  assert.equal(audio[0].sampleRate, 16_000);
  let peak = 0, crossings = 0, previous = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    peak = Math.max(peak, Math.abs(sample));
    if (i > 0 && (sample < 0) !== (previous < 0)) crossings++;
    previous = sample;
  }
  // 0.5 of full scale, allowing for the FIR's transition band; 1 kHz over 100 ms crosses zero ~200 times.
  assert.ok(peak > 12_000 && peak < 18_000, `peak ${peak}`);
  assert.ok(crossings > 170 && crossings < 230, `crossings ${crossings}`);
  agent.stop();
});

test('S27: float32 samples outside [-1, 1] or non-finite are clamped, never full-scale bursts', () => {
  const bytes = Buffer.alloc(16);
  bytes.writeFloatLE(2.5, 0); bytes.writeFloatLE(-7, 4); bytes.writeFloatLE(Number.NaN, 8); bytes.writeFloatLE(0.25, 12);
  const pcm = float32ToPcm16(bytes);
  assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2), pcm.readInt16LE(4), pcm.readInt16LE(6)], [32_767, -32_767, 0, 8_192]);
});

test('S27: a caller utterance without a completed event is finalised from the last cumulative delta when the model answers', async () => {
  const { agent, socket } = await ready();
  const transcripts = [];
  agent.on('transcript', event => transcripts.push(event));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"你好"}'));
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"你好我是快递"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_text.delta","response_id":"resp_1","delta":"好的"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1","tts_type":"default"}'));
  assert.equal(transcripts[0].timing.via, 'partial');
  assert.deepEqual(transcripts.map(untimed), [{ text: '你好我是快递', final: true, speaker: 'caller' }]);
  // The documented `transcript` field is still honoured when it is the only one present.
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.completed","item_id":"i2","transcript":"单号一二三"}'));
  assert.equal(transcripts.at(-1).timing.via, 'completed');
  assert.deepEqual(untimed(transcripts.at(-1)), { text: '单号一二三', final: true, speaker: 'caller' });
  agent.stop();
});

test('S27: the greeting reaches the transcript once, as the assistant final of its own response', async () => {
  const { agent, socket } = await ready({ greeting: '您好！我是 VoDog AI 助理，代用户接听电话。' });
  const transcripts = [];
  agent.on('transcript', event => transcripts.push(event));
  agent.greet();
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q1","response_id":"","tts_type":"chat_tts_text"}'));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.done","question_id":"q1","response_id":""}'));
  // A later chat turn is not the greeting even though nothing else changed.
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","question_id":"q2","response_id":"resp_2","tts_type":"default"}'));
  assert.deepEqual(transcripts, [{ text: '您好！我是 VoDog AI 助理，代用户接听电话。', final: true, responseId: 'q1', immediate: true }]);
  agent.stop();
});

// 2026-09-12 real call: a congestion episode 34 s into an otherwise good Doubao call tripped the
// old `bufferedAmount > 64 KB` guard, which faulted immediately and ended the call
// (`provider_failed`). Upstream congestion must cost the caller audio, never the call.
test('S27: transient upstream backpressure drops audio and keeps the call, and recovers on its own', async () => {
  const { agent, socket } = await ready();
  const notices = [], faults = [];
  agent.on('notice', notice => notices.push(notice.kind));
  agent.on('fault', error => faults.push(error));
  // S98: congested before the audio arrives — the packet that would leave on arrival meets the full buffer too.
  socket.bufferedAmount = 200_000;
  agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 });
  agent.drainAudio();
  agent.drainAudio();
  assert.deepEqual(faults, [], 'a congested second is not a failed call');
  assert.equal(agent.state, 'ready');
  assert.deepEqual(notices, ['input_backpressure'], 'one notice per episode, not one per tick');
  assert.equal(appendsOf(socket).length, 0, 'nothing is pushed into a full send buffer');
  // The link drains: the pacer re-times instead of dumping the backlog in one burst.
  socket.bufferedAmount = 0;
  agent.drainAudio();
  assert.deepEqual(notices, ['input_backpressure', 'input_backpressure_cleared']);
  assert.equal(appendsOf(socket).length, 1, 'back to one packet per 20 ms tick');
  agent.stop();
});

test('S27: backpressure that never clears is a real fault, bounded in time and in bytes', async () => {
  const sustained = await ready();
  const faults = [], kinds = [];
  sustained.agent.on('fault', error => faults.push(error));
  sustained.agent.on('notice', notice => kinds.push(notice.kind));
  sustained.agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 });
  sustained.socket.bufferedAmount = 200_000;
  sustained.agent.drainAudio();
  assert.deepEqual(faults, []);
  // Five seconds of a send buffer that never drains: the link is gone, end the run the normal way.
  sustained.agent.backpressureSinceMs = Date.now() - 5_000;
  sustained.agent.drainAudio();
  assert.equal(faults.length, 1);
  assert.deepEqual(kinds, ['input_backpressure', 'input_backpressure_fatal']);
  assert.equal(sustained.agent.state, 'closed');

  // A buffer past the hard ceiling does not wait out the five seconds.
  const burst = await ready();
  const burstFaults = [];
  burst.agent.on('fault', error => burstFaults.push(error));
  burst.agent.appendAudio(Buffer.alloc(3_200), { sequence: 4 });
  burst.socket.bufferedAmount = 600_000;
  burst.agent.drainAudio();
  assert.equal(burstFaults.length, 1, 'half a megabyte queued is not a transient hiccup');
  assert.equal(burst.agent.state, 'closed');
});

// S27 决策 15（与 xAI 真实通话 c3734597 同源）: `ws` 先报 `error` 再报 `close`，那一声 fault 会被
// worker 当成 `provider_failed`，在收尾 drain 还没跑完时把桥拆掉，来电者听到的再见被切掉一截。
test('S27 决策 15: a socket error after end_call is the expected end, not a fault', async () => {
  const { agent, socket } = await ready({ endCallTool: true });
  const faults = [], closed = [], flushes = [];
  agent.on('fault', error => faults.push(error));
  agent.on('closed', payload => closed.push(payload));
  agent.on('flushAudio', event => flushes.push(event));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.function_call_arguments.done',
    items: [{ call_id: 'call_1', name: 'end_call', arguments: '{"reason":"sales_refused"}' }],
  })));
  socket.emit('error', new Error('read ECONNRESET'));
  socket.close();
  assert.deepEqual(faults, [], 'an expected teardown must not end the run as a provider failure');
  assert.deepEqual(closed, [{ reason: 'ended_by_provider' }]);
  assert.deepEqual(flushes, [], 'and the goodbye still queued in the bridge is not cleared');
  assert.equal(agent.state, 'closed');
});

test('S27 决策 15: a socket error with no end_call behind it is still a fault', async () => {
  const { agent, socket } = await ready();
  const faults = [], notices = [];
  agent.on('fault', error => faults.push(error));
  agent.on('notice', notice => notices.push(notice.kind));
  socket.emit('error', new Error('read ECONNRESET'));
  assert.equal(faults.length, 1);
  assert.deepEqual(notices, ['socket_error']);
  assert.equal(agent.state, 'closed');
});

test('a failed socket send is reported once per session as provider_send_failed', async () => {
  const { agent, socket } = await ready(); const notices = [];
  agent.on('notice', notice => notices.push(notice));
  socket.send = () => { throw new Error('WebSocket is not open: readyState 2'); };
  assert.equal(agent.sendEvent({ type: 'x' }), false); assert.equal(agent.sendEvent({ type: 'y' }), false);
  assert.deepEqual(notices, [{ kind: 'provider_send_failed', message: 'WebSocket is not open: readyState 2' }]);
  agent.stop();
});

test('S97b: a guarded speech start that is still open when the guard expires cuts the greeting then', async t => {
  const g = await greeting(t, { outputFormat: 's16le' }, ['Date', 'setTimeout']);
  const started = [], notices = [];
  g.agent.on('speechStarted', payload => started.push(payload));
  g.agent.on('notice', notice => notices.push(notice.kind));
  // Three seconds of greeting arrive at once, far faster than they play.
  g.socket.emit('message', audioDelta(3_000));
  t.mock.timers.tick(800);
  g.speak();
  assert.deepEqual(started.map(({ guarded, responseActive }) => [guarded, responseActive]), [[true, true]]);
  assert.ok(Math.abs(started[0].playoutMs - 2_200) <= 1, `playoutMs ${started[0].playoutMs}`);
  // Real server (S97b probe): it truncates the greeting itself with `response.done` and
  // never sends `output_audio.done` for it. S98: that ends the response here and now.
  g.socket.emit('message', Buffer.from('{"type":"response.done"}'));
  assert.deepEqual(notices, ['response_done_without_audio_done']);
  assert.equal(g.agent.responseActive, false);
  t.mock.timers.tick(1_699);
  assert.deepEqual([g.cancels(), g.agent.outputGeneration], [0, 0]);
  t.mock.timers.tick(1);
  // What already arrived is still playing at the guard's end, so it is flushed — but no
  // `response.cancel` goes out for a response the server has already ended.
  assert.deepEqual([g.cancels(), g.count('flushAudio'), g.agent.outputGeneration], [0, 1, 1]);
  assert.deepEqual(notices, ['response_done_without_audio_done', 'greeting_guard_cancel']);
  g.agent.stop();
});

test('S97b: the deferred cancel is dropped when the caller finishes inside the guard, a new turn starts, or the agent stops', async t => {
  const done = await greeting(t, {}, ['Date', 'setTimeout']);
  t.mock.timers.tick(500);
  done.speak();
  done.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.completed","text":"喂"}'));
  t.mock.timers.tick(5_000);
  assert.deepEqual([done.cancels(), done.agent.outputGeneration], [0, 0]);
  done.agent.stop();
  t.mock.timers.reset();

  const reply = await greeting(t, {}, ['Date', 'setTimeout']);
  t.mock.timers.tick(500);
  reply.speak();
  reply.socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1","tts_type":"default"}'));
  t.mock.timers.tick(5_000);
  assert.equal(reply.cancels(), 0);
  reply.agent.stop();
  t.mock.timers.reset();

  const stopped = await greeting(t, {}, ['Date', 'setTimeout']);
  t.mock.timers.tick(500);
  stopped.speak();
  stopped.agent.stop();
  t.mock.timers.tick(5_000);
  assert.equal(stopped.cancels(), 0);
});

// S98: Doubao delivers a whole reply far faster than real time (an 11 s greeting arrives in ~1.4 s,
// S97b probe), so `output_audio.done` lands while the caller has heard only the start of it. Barge-in
// follows the estimated playout, not the delivery.
/** A non-greeting reply of `ms` milliseconds delivered in one burst and finished on the wire. */
async function delivered(t, ms, apis = ['Date']) {
  t.mock.timers.enable({ apis });
  const session = await ready({ outputFormat: 's16le' });
  const flushes = [], started = [];
  session.agent.on('flushAudio', event => flushes.push(event));
  session.agent.on('speechStarted', payload => started.push(payload));
  session.socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1","tts_type":"default"}'));
  session.socket.emit('message', audioDelta(ms, 'resp_1'));
  session.socket.emit('message', Buffer.from('{"type":"response.output_audio.done","response_id":"resp_1"}'));
  const speak = () => session.socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  const cancels = () => session.socket.sent.filter(event => event.type === 'response.cancel').length;
  return { ...session, flushes, started, speak, cancels };
}

test('S98: the caller still barges in after the reply is delivered, while it plays: flush, no cancel', async t => {
  const d = await delivered(t, 3_000);
  assert.equal(d.agent.responseActive, false);
  t.mock.timers.tick(1_000);
  d.speak();
  assert.deepEqual([d.flushes.length, d.agent.outputGeneration, d.cancels()], [1, 1, 0]);
  assert.deepEqual(d.started.map(({ guarded, responseActive }) => [guarded, responseActive]), [[false, false]]);
  assert.ok(Math.abs(d.started[0].playoutMs - 2_000) <= 1, `playoutMs ${d.started[0].playoutMs}`);
  // The flush ended the playout: a second start in the same pause has nothing left to cut.
  d.speak();
  assert.deepEqual([d.flushes.length, d.agent.outputGeneration], [1, 1]);
  d.agent.stop();
});

test('S98: once the estimated playout is over, the caller speaking flushes nothing', async t => {
  const d = await delivered(t, 3_000);
  t.mock.timers.tick(3_001);
  d.speak();
  assert.deepEqual([d.flushes.length, d.agent.outputGeneration, d.cancels()], [0, 0, 0]);
  assert.equal(d.started[0].playoutMs, 0);
  d.agent.stop();
});

test('S98: response.done ends a response the server truncated, so no later cancel can target it', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { agent, socket } = await ready();
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  socket.emit('message', Buffer.from('{"type":"response.output_audio.started","response_id":"resp_1","tts_type":"default"}'));
  socket.emit('message', Buffer.from('{"type":"response.done"}'));
  assert.deepEqual([agent.responseActive, notices], [false, ['response_done_without_audio_done']]);
  // Nothing was ever played, so there is nothing to cancel and nothing to flush.
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  assert.deepEqual([socket.sent.some(event => event.type === 'response.cancel'), agent.outputGeneration], [false, 0]);
  // An ordinary `response.done` after `output_audio.done` stays silent.
  socket.emit('message', Buffer.from('{"type":"response.done"}'));
  assert.deepEqual(notices, ['response_done_without_audio_done']);
  agent.stop();
});

test('S98: inside the guard nothing flushes; at its end a greeting that only remains as playout is flushed without a cancel', async t => {
  const g = await greeting(t, { outputFormat: 's16le' }, ['Date', 'setTimeout']);
  g.socket.emit('message', audioDelta(4_000));
  g.socket.emit('message', Buffer.from('{"type":"response.output_audio.done","response_id":""}'));
  t.mock.timers.tick(800);
  g.speak();
  assert.deepEqual([g.count('flushAudio'), g.agent.outputGeneration, g.cancels()], [0, 0, 0]);
  t.mock.timers.tick(1_700);
  assert.deepEqual([g.count('flushAudio'), g.agent.outputGeneration, g.cancels()], [1, 1, 0]);
  g.agent.stop();
  t.mock.timers.reset();

  // A greeting still being delivered at the guard's end is cancelled on the wire as well (S97b).
  const live = await greeting(t, { outputFormat: 's16le' }, ['Date', 'setTimeout']);
  live.socket.emit('message', audioDelta(1_000));
  t.mock.timers.tick(800);
  live.speak();
  t.mock.timers.tick(1_700);
  assert.deepEqual([live.count('flushAudio'), live.agent.outputGeneration, live.cancels()], [1, 1, 1]);
  live.agent.stop();
});

test('S119: an ASR turn that stops reporting while caller audio still flows is force-ended with one commit, at most twice', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  const notices = [];
  agent.on('notice', notice => notices.push(notice.kind));
  let sequence = 1;
  const frame = () => { agent.appendAudio(Buffer.alloc(640, 1), { sequence: sequence++ }); t.mock.timers.tick(20); };
  const commits = () => typesOf(socket).filter(type => type === 'input_audio_buffer.commit').length;
  const asr = (type, extra = {}) => socket.emit('message', Buffer.from(JSON.stringify({ type: `conversation.item.input_audio_transcription.${type}`, ...extra })));
  // No open turn: silence and speech alike never trigger a commit.
  for (let i = 0; i < 200; i++) frame();
  assert.equal(commits(), 0);
  // Deltas keep arriving inside the window: a long sentence is not cut.
  asr('started');
  for (let i = 0; i < 400; i++) { frame(); if (i % 100 === 99) asr('delta', { delta: '喂' }); }
  assert.equal(commits(), 0);
  // The server goes quiet mid-turn (S119 field calls): one commit after 3 s, a second 3 s later, then nothing.
  for (let i = 0; i < 149; i++) frame();
  assert.equal(commits(), 0);
  frame(); frame();
  assert.equal(commits(), 1);
  for (let i = 0; i < 150; i++) frame();
  assert.equal(commits(), 2);
  for (let i = 0; i < 400; i++) frame();
  assert.equal(commits(), 2);
  assert.deepEqual(notices, ['asr_stall_commit', 'asr_stall_commit']);
  // A completed turn closes the watch; the next turn gets its own budget.
  asr('completed', { text: '喂，你好。' });
  for (let i = 0; i < 200; i++) frame();
  assert.equal(commits(), 2);
  asr('started');
  for (let i = 0; i < 160; i++) frame();
  assert.equal(commits(), 3);
  agent.stop();
});

test('S119: DOUBAO_ASR_STALL_MS=0 turns the stall commit off and the env key is accepted', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready({ asrStallMs: 0 });
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.started"}'));
  for (let i = 0; i < 500; i++) { agent.appendAudio(Buffer.alloc(640, 1), { sequence: i + 1 }); t.mock.timers.tick(20); }
  assert.equal(typesOf(socket).filter(type => type === 'input_audio_buffer.commit').length, 0);
  agent.stop();
  assert.ok([...DOUBAO_ENV_KEYS].includes('DOUBAO_ASR_STALL_MS'));
  assert.equal(doubaoConfig({ DOUBAO_API_KEY: 'k', DOUBAO_ASR_STALL_MS: '2500' }).asrStallMs, 2_500);
});

test('S127: a caller final carries when the last voiced packet reached Doubao and how the ASR turn went', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  const finals = [];
  agent.on('transcript', event => { if (event.speaker === 'caller') finals.push(event); });
  let sequence = 1;
  const frame = fill => { agent.appendAudio(Buffer.alloc(640, fill), { sequence: sequence++ }); t.mock.timers.tick(20); };
  const asr = (type, extra = {}) => socket.emit('message', Buffer.from(JSON.stringify({ type: `conversation.item.input_audio_transcription.${type}`, ...extra })));
  // Silence only: nothing voiced has reached the provider yet (the mocked clock starts at 0, so null is not "0 ms ago").
  for (let i = 0; i < 3; i++) frame(0);
  asr('completed', { text: '嗯' });
  assert.deepEqual(finals[0].timing, { via: 'completed', deltas: 0, lastDeltaGapMs: null, sinceLastVoiceMs: null, queuedMs: 0, droppedPackets: 0, commits: 0 });
  // Three voiced packets, then five of silence: each frame is sent on arrival and the clock then moves 20 ms,
  // so the turn completes 20 + 5 × 20 = 120 ms after the last voiced packet went out.
  asr('started');
  for (let i = 0; i < 3; i++) frame(0x10);
  asr('delta', { delta: '我是' });
  for (let i = 0; i < 2; i++) frame(0);
  asr('delta', { delta: '我是顺丰' });
  for (let i = 0; i < 3; i++) frame(0);
  asr('completed', { text: '我是顺丰快递' });
  assert.equal(appendsOf(socket).length, 11, 'every packet was sent, voiced or not');
  assert.deepEqual(finals[1], { text: '我是顺丰快递', final: true, speaker: 'caller',
    timing: { via: 'completed', deltas: 2, lastDeltaGapMs: 60, sinceLastVoiceMs: 120, queuedMs: 0, droppedPackets: 0, commits: 0 } });
  // No `completed`: the model answering finalises the last delta, and says so.
  asr('started');
  asr('delta', { delta: '单号' });
  t.mock.timers.tick(40);
  socket.emit('message', Buffer.from('{"type":"response.output_text.delta","response_id":"resp_1","delta":"好的"}'));
  assert.deepEqual(finals[2], { text: '单号', final: true, speaker: 'caller',
    timing: { via: 'partial', deltas: 1, lastDeltaGapMs: 40, sinceLastVoiceMs: 160, queuedMs: 0, droppedPackets: 0, commits: 0 } });
  agent.stop();
  t.mock.timers.reset();
});

test('S127: the timing reports the uplink queue and the drop counter, and only audio actually sent counts as voiced', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { agent, socket } = await ready();
  const finals = [];
  agent.on('transcript', event => finals.push(event));
  // One second of voiced audio in one go: the first packet leaves at once, 49 wait; another 200 ms overflows the cap by 9.
  agent.appendAudio(Buffer.alloc(32_000, 0x10), { sequence: 1 });
  agent.appendAudio(Buffer.alloc(6_400, 0x10), { sequence: 2 });
  t.mock.timers.tick(40);
  socket.emit('message', Buffer.from('{"type":"conversation.item.input_audio_transcription.completed","text":"喂"}'));
  assert.deepEqual(finals[0].timing, { via: 'completed', deltas: 0, lastDeltaGapMs: null, sinceLastVoiceMs: 0, queuedMs: 960, droppedPackets: 9, commits: 0 });
  agent.stop();
  t.mock.timers.reset();
});

// S129: Doubao opens every reply with ~0.4 s of low-level lead-in (loudest block −47 dBFS, speech onset
// ≥ −23). The adapter drops it before the playback queue. The oracle for every case is the same delta
// sequence through an agent with the trim off: the trim only ever removes a prefix of whole 20 ms blocks.
/** `ms` of 24 kHz s16le 1 kHz sine at `amplitude` (RMS = amplitude / √2). */
const tone24k = (ms, amplitude) => {
  const out = Buffer.alloc(ms * 48);
  for (let i = 0; i < ms * 24; i++) out.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 1_000 * i / 24_000)), i * 2);
  return out;
};
const LEAD = 100, SPEECH = 4_500; // RMS ≈ 71 and ≈ 3180
/** Cuts a byte stream at offsets that align with neither samples nor 20 ms blocks. */
const awkward = bytes => {
  const parts = [];
  for (let offset = 0, i = 0; offset < bytes.length; i++) { const size = [1_001, 4_803, 77, 9_999, 2_402][i % 5]; parts.push(bytes.subarray(offset, offset + size)); offset += size; }
  return parts;
};
const blockRms = (pcm, block) => {
  let sum = 0;
  for (let i = 0; i < 320; i++) sum += pcm.readInt16LE(block * 640 + i * 2) ** 2;
  return Math.sqrt(sum / 320);
};
async function trimSession(options = {}) {
  const session = await ready({ outputFormat: 's16le', ...options });
  const events = [];
  for (const name of ['audio', 'completed', 'flushAudio']) session.agent.on(name, payload => events.push({ name, payload }));
  const emit = event => session.socket.emit('message', Buffer.from(JSON.stringify(event)));
  return { ...session, events,
    start: (id = 'resp_1') => emit({ type: 'response.output_audio.started', response_id: id }),
    send: (parts, id = 'resp_1') => { for (const part of [parts].flat()) emit({ type: 'response.output_audio.delta', response_id: id, delta: part.toString('base64') }); },
    done: (id = 'resp_1') => emit({ type: 'response.output_audio.done', response_id: id }),
    emit,
    pcm: id => Buffer.concat(events.filter(event => event.name === 'audio' && (!id || event.payload.responseId === id)).map(event => event.payload.pcm)),
    completed: () => events.filter(event => event.name === 'completed').map(event => event.payload) };
}
/** One whole response through a trimming agent and through the oracle; returns both byte streams. */
async function trimmed(parts, options = {}) {
  const on = await trimSession(options), off = await trimSession({ leadTrimRms: 0 });
  for (const session of [on, off]) { session.start(); session.send(parts); session.done(); }
  const result = { pcm: on.pcm(), oracle: off.pcm(), leadTrimMs: on.completed()[0].leadTrimMs, events: [...on.events] };
  assert.equal(off.completed()[0].leadTrimMs, 0);
  assert.equal(on.events.every(event => event.name !== 'audio' || event.payload.pcm.length % 2 === 0), true, 'even byte lengths only');
  assert.equal(Buffer.compare(result.pcm, result.oracle.subarray(result.leadTrimMs * 32)), 0, 'emitted = the untrimmed stream minus a whole-block prefix');
  on.agent.stop(); off.agent.stop();
  return result;
}

test('S129: a lead-in split across deltas at awkward offsets is dropped except the pre-roll', async () => {
  const r = await trimmed(awkward(Buffer.concat([tone24k(400, LEAD), tone24k(600, SPEECH)])));
  assert.equal(r.oracle.length, 32_000);
  // 20 lead-in blocks, the last 4 (80 ms) kept as pre-roll.
  assert.equal(r.leadTrimMs, 320);
  assert.equal(r.pcm.length, 32_000 - 320 * 32);
  assert.deepEqual([0, 1, 2, 3].map(block => blockRms(r.pcm, block) < 330), [true, true, true, true]);
  assert.deepEqual([4, 5].map(block => blockRms(r.pcm, block) > 2_000), [true, true]);
  // Pre-roll, the two onset blocks and what followed them in that delta leave as one buffer; later deltas pass through.
  assert.ok(r.events[0].name === 'audio' && r.events[0].payload.pcm.length >= 6 * 640);
  assert.equal(r.events.at(-1).name, 'completed');

  // Pre-roll and cap are parameters.
  const short = await trimmed(awkward(Buffer.concat([tone24k(400, LEAD), tone24k(600, SPEECH)])), { leadTrimPrerollMs: 0 });
  assert.equal(short.leadTrimMs, 400);
  assert.equal(blockRms(short.pcm, 0) > 2_000, true);
});

test('S129: one loud block inside the lead-in is not an onset', async () => {
  // 15 ms bump inside block 10, then quiet again, then speech at 420 ms.
  const r = await trimmed(awkward(Buffer.concat([tone24k(200, LEAD), tone24k(15, SPEECH), tone24k(205, LEAD), tone24k(400, SPEECH)])));
  assert.equal(blockRms(r.oracle, 10) > 330, true, 'the bump really is a loud block');
  assert.equal(r.leadTrimMs, 340);

  // A bump right before the onset is still inside the pre-roll window and is played.
  const late = await trimmed(Buffer.concat([tone24k(340, LEAD), tone24k(15, SPEECH), tone24k(45, LEAD), tone24k(400, SPEECH)]));
  assert.equal(late.leadTrimMs, 320);
  assert.deepEqual([0, 1, 2, 3].map(block => blockRms(late.pcm, block) > 330), [false, true, false, false]);
});

test('S129: after the cap the rest of the response passes through, however quiet', async () => {
  const r = await trimmed(awkward(Buffer.concat([tone24k(1_000, LEAD), tone24k(200, SPEECH)])));
  assert.equal(r.leadTrimMs, 600);
  assert.equal(r.pcm.length, 600 * 32);
  // Quiet audio after the cap is emitted delta by delta, not held for an onset.
  const session = await trimSession({ leadTrimMaxMs: 100 });
  session.start(); session.send(tone24k(300, LEAD));
  assert.equal(session.pcm().length, 200 * 32);
  session.send(tone24k(10, LEAD));
  assert.equal(session.pcm().length, 210 * 32);
  session.done();
  assert.equal(session.completed()[0].leadTrimMs, 100);
  session.agent.stop();
});

test('S129: a response that starts loud is byte-identical to the untrimmed stream', async () => {
  const r = await trimmed(awkward(tone24k(500, SPEECH)));
  assert.equal(r.leadTrimMs, 0);
  assert.equal(Buffer.compare(r.pcm, r.oracle), 0);
  assert.equal(r.pcm.length, 16_000);
});

test('S129: every response trims its own lead-in, and an interrupt mid-trim discards what was held', async () => {
  const reply = Buffer.concat([tone24k(400, LEAD), tone24k(300, SPEECH)]);
  const on = await trimSession(), off = await trimSession({ leadTrimRms: 0 });
  for (const session of [on, off]) { for (const id of ['resp_1', 'resp_2']) { session.start(id); session.send(awkward(reply), id); session.done(id); } }
  assert.deepEqual(on.completed().map(payload => payload.leadTrimMs), [320, 320]);
  for (const id of ['resp_1', 'resp_2']) assert.equal(Buffer.compare(on.pcm(id), off.pcm(id).subarray(320 * 32)), 0, id);
  on.agent.stop();

  // Interrupted while still holding: nothing held is ever emitted, the cancelled response's late audio
  // stays fenced, and the next response starts from a clean state.
  const cut = await trimSession();
  cut.start('resp_1'); cut.send(tone24k(150, LEAD), 'resp_1');
  assert.equal(cut.pcm().length, 0);
  assert.equal(cut.agent.leadHeld.length > 0, true);
  cut.agent.interrupt();
  assert.equal(cut.agent.leadHeld, null);
  cut.send(tone24k(200, SPEECH), 'resp_1');
  cut.emit({ type: 'response.canceled' });
  assert.equal(cut.pcm().length, 0);
  assert.deepEqual(cut.completed(), [{ status: 'cancelled', responseId: 'resp_1', generation: 0, current: false }]);
  cut.start('resp_2'); cut.send(awkward(reply), 'resp_2'); cut.done('resp_2');
  assert.equal(cut.pcm('resp_1').length, 0);
  assert.equal(Buffer.compare(cut.pcm('resp_2'), off.pcm('resp_2').subarray(320 * 32)), 0);
  assert.equal(cut.events.filter(event => event.name === 'audio').every(event => event.payload.generation === 1), true);
  assert.equal(cut.completed().at(-1).leadTrimMs, 320);
  cut.agent.stop(); off.agent.stop();
});

test('S129: a response that never gets loud gives its held audio back before completed', async () => {
  // 150 ms = 7 blocks + 10 ms: 3 blocks were already dropped, the 4-block pre-roll and the remainder are not swallowed.
  const r = await trimmed(awkward(tone24k(150, LEAD)));
  assert.equal(r.leadTrimMs, 60);
  assert.equal(r.pcm.length, 90 * 32);
  assert.deepEqual(r.events.map(event => event.name), ['audio', 'completed']);
  // Shorter than the pre-roll: nothing is lost at all.
  const tiny = await trimmed(tone24k(50, LEAD));
  assert.deepEqual([tiny.leadTrimMs, tiny.pcm.length], [0, 50 * 32]);

  // The server-truncated path (`response.done` with no `output_audio.done`) releases it too.
  const session = await trimSession();
  session.start(); session.send(tone24k(50, LEAD));
  assert.equal(session.pcm().length, 0);
  session.emit({ type: 'response.done' });
  assert.equal(session.pcm().length, 50 * 32);
  assert.equal(session.agent.leadHeld, null);
  session.agent.stop();
});

test('S129: DOUBAO_LEAD_TRIM_RMS=0 is the old byte stream, delta for delta', async () => {
  const { Pcm24kTo16kResampler } = await import('./pcm-pipeline.mjs');
  const parts = [tone24k(130, LEAD), tone24k(7, 0), tone24k(300, SPEECH), tone24k(33, LEAD)];
  for (const options of [{ leadTrimRms: 0 }, { leadTrimMaxMs: 0 }]) {
    const session = await trimSession(options);
    const resampler = new Pcm24kTo16kResampler();
    session.start(); session.send(parts); session.done();
    const audio = session.events.filter(event => event.name === 'audio').map(event => event.payload.pcm);
    assert.equal(audio.length, parts.length);
    parts.forEach((part, index) => assert.equal(Buffer.compare(audio[index], resampler.process(part)), 0, `delta ${index}`));
    assert.equal(session.completed()[0].leadTrimMs, 0);
    session.agent.stop();
  }
});

test('S129: the playout estimate counts only what was emitted', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const session = await trimSession();
  session.start();
  // Still holding the lead-in: no playout yet, but the response is live, so the caller can still barge in.
  session.send(tone24k(60, LEAD));
  assert.deepEqual([session.agent.playoutEndsAtMs, session.agent.audible()], [0, true]);
  session.send(Buffer.concat([tone24k(340, LEAD), tone24k(600, SPEECH)]));
  session.done();
  // 1000 ms delivered, 320 ms dropped: 680 ms of playout.
  assert.equal(session.completed()[0].leadTrimMs, 320);
  assert.equal(session.agent.playoutEndsAtMs - Date.now(), 680);
  t.mock.timers.tick(679); assert.equal(session.agent.audible(), true);
  t.mock.timers.tick(2); assert.equal(session.agent.audible(), false);
  session.agent.stop();
});

test('S129: the lead-trim env keys are accepted, defaulted and bounded', () => {
  for (const key of ['DOUBAO_LEAD_TRIM_RMS', 'DOUBAO_LEAD_TRIM_MAX_MS', 'DOUBAO_LEAD_TRIM_PREROLL_MS']) assert.ok(DOUBAO_ENV_KEYS.includes(key), key);
  const defaults = doubaoConfig({ DOUBAO_API_KEY: 'k' });
  assert.deepEqual([defaults.leadTrimRms, defaults.leadTrimMaxMs, defaults.leadTrimPrerollMs], [330, 600, 80]);
  const set = doubaoConfig({ DOUBAO_API_KEY: 'k', DOUBAO_LEAD_TRIM_RMS: '0', DOUBAO_LEAD_TRIM_MAX_MS: '2000', DOUBAO_LEAD_TRIM_PREROLL_MS: '400' });
  assert.deepEqual([set.leadTrimRms, set.leadTrimMaxMs, set.leadTrimPrerollMs], [0, 2_000, 400]);
  const bad = { DOUBAO_LEAD_TRIM_RMS: ['-1', '5001', '330.0'], DOUBAO_LEAD_TRIM_MAX_MS: ['-1', '2001', '0.6s'], DOUBAO_LEAD_TRIM_PREROLL_MS: ['-1', '401', 'x'] };
  for (const [key, values] of Object.entries(bad)) for (const value of values) assert.throws(() => doubaoConfig({ DOUBAO_API_KEY: 'k', [key]: value }), error => error.message.includes(key), `${key}=${value} was accepted`);
  assert.throws(() => new DoubaoVoiceAgent({ apiKey: 'k', instructions: 'x', leadTrimRms: 5_001 }), /lead trim/);
  // The parsed values reach the adapter (the rollback is DOUBAO_LEAD_TRIM_RMS=0 and a republish).
  const agent = createVoiceAgent({ provider: 'doubao', env: { DOUBAO_API_KEY: 'k', DOUBAO_LEAD_TRIM_RMS: '0', DOUBAO_LEAD_TRIM_MAX_MS: '400', DOUBAO_LEAD_TRIM_PREROLL_MS: '40' }, overrides: { socketFactory: () => new Socket() } });
  assert.deepEqual([agent.leadTrimRms, agent.leadTrimMaxBlocks, agent.leadTrimPrerollBlocks], [0, 20, 2]);
});
