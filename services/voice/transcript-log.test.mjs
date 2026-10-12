import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CUT_MARKER, TranscriptCollector } from './transcript-log.mjs';

function setup(options = {}) {
  const posts = [];
  const agent = new EventEmitter();
  const clock = { ms: 0 };
  const collector = new TranscriptCollector({ flushMs: 10_000, post: async items => { posts.push(items); }, now: () => clock.ms, ...options });
  collector.attach(agent);
  // A caller utterance is held briefly so the provider can revise it. Tests that only care about
  // delivery step the injected clock past that window instead of waiting on real time.
  const flush = async () => { clock.ms += 10_000; await collector.flush(); };
  return { agent, collector, posts, clock, flush };
}

test('both roles share one monotonic sequence and AI deltas flush on completion', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '你好', final: false, responseId: 'r1' });
  agent.emit('transcript', { text: '，请讲', final: false, responseId: 'r1' });
  assert.equal(collector.pending.length, 0);
  agent.emit('completed', { responseId: 'r1' });
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['ai', 0, '你好，请讲'], ['caller', 1, '我要退款']]);
  assert.match(posts[0][0].at, /^\d{4}-\d\d-\d\dT.*Z$/);
  await collector.close();
});

test('only final caller transcripts are kept and empty text is dropped', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '我要', final: false, cumulative: true, speaker: 'caller' });
  agent.emit('transcript', { text: '   ', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: ' 我要退款 ', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0], [{ role: 'caller', sequence: 0, text: '我要退款', at: posts[0][0].at }]);
  await collector.close();
});

test('batches never exceed maxBatch and the size threshold flushes without the timer', async () => {
  const { agent, collector, posts, flush } = setup({ maxBatch: 3 });
  for (let i = 0; i < 7; i++) agent.emit('transcript', { text: `t${i}`, final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts.map(batch => batch.length), [3, 3, 1]);
  assert.deepEqual(collector.stats(), { sent: 7, dropped: 0, failed: 0, pending: 0, merged: 0, cut: 0 });
  await collector.close();
});

test('overflow drops the oldest pending items instead of growing without bound', async () => {
  const { agent, collector, posts, flush } = setup({ maxBatch: 100, maxPending: 3 });
  for (let i = 0; i < 6; i++) agent.emit('transcript', { text: `t${i}`, final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => item.text), ['t3', 't4', 't5']);
  assert.deepEqual(posts[0].map(item => item.sequence), [3, 4, 5]);
  assert.equal(collector.stats().dropped, 3);
  await collector.close();
});

test('a throwing post is swallowed, counted and never retried', async () => {
  const { agent, collector, flush } = setup({ post: async () => { throw new Error('control down'); } });
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(collector.stats(), { sent: 0, dropped: 0, failed: 1, pending: 0, merged: 0, cut: 0 });
  await collector.close();
});

test('close flushes orphaned AI buffers once and then ignores late events', async () => {
  const { agent, collector, posts } = setup();
  agent.emit('transcript', { text: '未完成的回答', final: false, responseId: 'r9' });
  await collector.close();
  assert.deepEqual(posts[0].map(item => [item.role, item.text]), [['ai', '未完成的回答']]);
  agent.emit('transcript', { text: '太晚了', final: true, speaker: 'caller' });
  agent.emit('completed', { responseId: 'r9' });
  await collector.close();
  assert.equal(posts.length, 1);
});

test('S23: one caller sentence repeated verbatim becomes one transcript row', async () => {
  const { agent, collector, posts, flush } = setup();
  // Production shape: three identical `...transcription.completed` events inside one second.
  for (let i = 0; i < 3; i++) agent.emit('transcript', { text: '请问你是', final: true, speaker: 'caller' });
  assert.equal(collector.pending.length, 0, 'the utterance is still open for revision');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '请问你是']]);
  assert.equal(collector.stats().merged, 2, 'the folded duplicates are not reported');
  await collector.close();
});

test('S23: a caller sentence revised as a growing prefix keeps only its longest version', async () => {
  const { agent, collector, posts, flush } = setup();
  for (const text of ['呃，那我', '呃，那我这里还有个快递', '呃，那我这里还有个快递要寄'])
    agent.emit('transcript', { text, final: true, speaker: 'caller' });
  // A late shorter repeat is still the same utterance and must not truncate the finished sentence.
  agent.emit('transcript', { text: '呃，那我这里', final: true, speaker: 'caller' });
  // An unrelated sentence is never merged: it closes the held one and opens its own.
  agent.emit('transcript', { text: '好的谢谢', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => [item.sequence, item.text]), [[0, '呃，那我这里还有个快递要寄'], [1, '好的谢谢']]);
  assert.equal(collector.stats().merged, 3);
  await collector.close();
});

test('S23: a held caller sentence is posted before the AI reply it triggered', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '好的', final: false, responseId: 'r1' });
  agent.emit('completed', { responseId: 'r1' });
  assert.deepEqual(posts, [], 'nothing is posted before the flush');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '我要退款'], ['ai', 1, '好的']]);
  await collector.close();
});

test('S90: an immediate AI final (Doubao greeting) is posted first even if its completed never matches', async () => {
  const { agent, collector, posts, clock } = setup();
  agent.emit('transcript', { text: '您好，我是助理', final: true, responseId: 'K1', immediate: true });
  clock.ms += 15_000;
  agent.emit('transcript', { text: '我找王先生', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '好的，请稍等', final: true, responseId: 'K2' });
  agent.emit('completed', { responseId: 'K2' });
  agent.emit('completed', { responseId: 'other' });
  await collector.close();
  assert.deepEqual(posts.flat().map(item => [item.role, item.sequence, item.text]),
    [['ai', 0, '您好，我是助理'], ['caller', 1, '我找王先生'], ['ai', 2, '好的，请稍等']]);
});

test('S27: caller revisions 2.4 s apart are one utterance, not one row each', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  // Production shape from run 0407de3e (rows 2–4 at 43:29.7 / 43:31.8 / 43:34.3): a caller reading a
  // number aloud, each `...transcription.completed` event a longer prefix of the last, 2.1–2.5 s
  // apart. At the old 1.2 s hold this one sentence was written as four rows. This case is the plain
  // growing prefix; the re-punctuated shape the same run actually produced is the test below.
  for (const text of ['呃，请记下号码', '呃，请记下号码，388', '呃，请记下号码，388665', '呃，请记下号码，38866534。']) {
    agent.emit('transcript', { text, final: true, speaker: 'caller' });
    clock.ms += 2_400;
  }
  assert.equal(collector.pending.length, 0, 'the utterance is still open for revision');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '呃，请记下号码，38866534。']]);
  assert.equal(collector.stats().merged, 3);
  // The row is stamped when the caller started speaking, not when the last revision landed.
  assert.equal(posts[0][0].at, new Date(0).toISOString());
  await collector.close();
});

test('S27: the re-punctuated revisions of run 0407de3e become one row', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  // The four caller finals as stored for run 0407de3e. Each intermediate one closes with "。", which
  // the next revision rewrites into "，" — compared literally they are not prefixes, so before the
  // trailing-punctuation normalisation this single utterance could never merge, at any hold length.
  const revisions = ['呃，请记下号码。', '呃，请记下号码，388。', '呃，请记下号码，388665。', '呃，请记下号码，38866534。'];
  const gaps = [2_100, 2_500, 2_400];
  revisions.forEach((text, i) => {
    agent.emit('transcript', { text, final: true, speaker: 'caller' });
    clock.ms += gaps[i] ?? 0;
  });
  assert.equal(collector.pending.length, 0, 'the utterance is still open for revision');
  await flush();
  // The posted text keeps its punctuation: normalisation decides identity, it never edits the row.
  assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]), [['caller', 0, '呃，请记下号码，38866534。']]);
  assert.equal(collector.stats().merged, 3);
  await collector.close();
});

test('S27: a revision arriving after the hold window becomes its own row', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  agent.emit('transcript', { text: '呃，请记下号码。', final: true, speaker: 'caller' });
  clock.ms += 4_000;
  // Documented limitation: past callerHoldMs the utterance is considered finished and splits. No
  // timer runs in these tests, so this also pins the per-event expiry check in handleTranscript —
  // without it the split would depend on where the 2 s flush tick happened to fall.
  agent.emit('transcript', { text: '呃，请记下号码。388。', final: true, speaker: 'caller' });
  assert.equal(collector.pending.length, 1, 'the first half was posted the moment the window closed');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.sequence, item.text]), [[0, '呃，请记下号码。'], [1, '呃，请记下号码。388。']]);
  assert.equal(collector.stats().merged, 0);
  await collector.close();
});

test('S27: an unrelated sentence inside the hold window still opens its own row', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  agent.emit('transcript', { text: '呃，请记下号码。', final: true, speaker: 'caller' });
  clock.ms += 500;
  // The longer hold must not start merging different sentences: isSameUtterance stays prefix-based.
  agent.emit('transcript', { text: '今天几点下班', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => [item.sequence, item.text]), [[0, '呃，请记下号码。'], [1, '今天几点下班']]);
  assert.equal(collector.stats().merged, 0);
  await collector.close();
});

test('S27: a held caller utterance is posted before the AI reply, inside or past the hold window', async () => {
  // Inside the window flushResponse closes the utterance; past it the per-event expiry does. Either
  // way the caller keeps the lower sequence, so the conversation never reads AI-first.
  for (const gapMs of [2_500, 3_500]) {
    const { agent, collector, posts, clock, flush } = setup();
    agent.emit('transcript', { text: '我要退款', final: true, speaker: 'caller' });
    clock.ms += gapMs;
    agent.emit('transcript', { text: '好的', final: false, responseId: 'r1' });
    agent.emit('completed', { responseId: 'r1' });
    await flush();
    assert.deepEqual(posts[0].map(item => [item.role, item.sequence, item.text]),
      [['caller', 0, '我要退款'], ['ai', 1, '好的']], `gap ${gapMs} ms keeps caller→ai order`);
    await collector.close();
  }
});

test('detach stops collecting and no timer runs before start', async () => {
  const { agent, collector, posts } = setup({ flushMs: 1 });
  assert.equal(collector.timer, undefined);
  collector.start(); assert.ok(collector.timer);
  collector.detach(agent);
  agent.emit('transcript', { text: '忽略', final: true, speaker: 'caller' });
  await collector.close();
  assert.deepEqual(posts, []);
  assert.equal(collector.timer, undefined);
});

test('S120a: finals sharing a provider item id are one row holding the LAST revision', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  // One field call: one xAI item, five finals, the English first guess and a mid-sentence rewrite.
  const caller = (text, itemId) => agent.emit('transcript', { text, final: true, speaker: 'caller', itemId });
  caller("I'm", 'item_1');
  const firstAt = collector.callerPending.at;
  for (const text of ['你好，请问需要保洁。', '你好，请问你需要保洁服务吗？', '你好，请问你需要保洁服务吗？']) { clock.ms += 1_000; caller(text, 'item_1'); }
  // A shorter later revision still wins: the provider's latest final is its correction.
  clock.ms += 1_000; caller('你好，请问你需要保洁服务吗', 'item_1');
  await flush();
  assert.deepEqual(posts[0].map(item => [item.role, item.text, item.at]), [['caller', '你好，请问你需要保洁服务吗', firstAt]]);
  assert.equal(collector.stats().merged, 4);
  await collector.close();
});

test('S120a: different item ids are never merged, however alike the text', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '好', final: true, speaker: 'caller', itemId: 'a' });
  agent.emit('transcript', { text: '好的谢谢', final: true, speaker: 'caller', itemId: 'b' });
  agent.emit('transcript', { text: '好的谢谢', final: true, speaker: 'caller', itemId: 'c' });
  await flush();
  assert.deepEqual(posts[0].map(item => item.text), ['好', '好的谢谢', '好的谢谢']);
  assert.equal(collector.stats().merged, 0);
  await collector.close();
});

test('S120a: a same-id final after the hold expired opens a new row (no Control update path)', async () => {
  const { agent, collector, posts, clock, flush } = setup();
  agent.emit('transcript', { text: '你好', final: true, speaker: 'caller', itemId: 'a' });
  clock.ms += 3_000;
  agent.emit('transcript', { text: '你好，请问', final: true, speaker: 'caller', itemId: 'a' });
  await flush();
  assert.deepEqual(posts.flat().map(item => item.text), ['你好', '你好，请问']);
  await collector.close();
});

test('S120a: a final without an item id against an id-carrying one keeps the prefix rule', async () => {
  const { agent, collector, posts, flush } = setup();
  // Doubao flushes its cumulative partial (no id) when the model answers; the late completed has one.
  agent.emit('transcript', { text: '我是顺丰', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '我是顺丰快递', final: true, speaker: 'caller', itemId: 'i1' });
  agent.emit('transcript', { text: '我是', final: true, speaker: 'caller' });
  await flush();
  assert.deepEqual(posts[0].map(item => item.text), ['我是顺丰快递']);
  await collector.close();
});

// S127: `playout` is the playback queue's whole-run byte totals; tests move them by hand. 32 bytes
// are 1 ms of 16 kHz PCM16, and 16 000 (500 ms) cleared is the least that counts as a cut.
function playoutSetup(options = {}) {
  const queue = { enqueued: 0, played: 0, cleared: 0 };
  return { queue, ...setup({ playout: () => queue, ...options }) };
}
const rows = posts => posts.flat().map(item => [item.role, item.sequence, item.text]);

test('S127: a guarded greeting, a barged-in reply and a farewell cut by the hangup are all marked', async () => {
  const { agent, collector, posts, queue, flush } = playoutSetup();
  agent.emit('transcript', { text: '您好，我是助理', final: true, responseId: 'K1', immediate: true });
  queue.enqueued = 100_000; queue.played = 40_000;
  await flush();
  assert.deepEqual(posts, [], 'the greeting is held while its audio is queued');
  queue.cleared += 60_000; // greeting-guard cancel flushes the queue
  await flush();
  assert.deepEqual(rows(posts), [['ai', 0, `您好，我是助理${CUT_MARKER}`]]);
  agent.emit('transcript', { text: '喂', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '好的，我帮您转达，请问', final: true, responseId: 'r1' });
  queue.enqueued += 80_000; queue.played += 20_000;
  queue.cleared += 60_000; // barge-in
  agent.emit('completed', { status: 'cancelled', responseId: 'x1' });
  agent.emit('transcript', { text: '等一下', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '好的，再见', final: true, responseId: 'r2' });
  queue.enqueued += 50_000;
  agent.emit('completed', { status: 'completed', responseId: 'x2' });
  queue.played += 10_000;
  queue.cleared += 40_000; // the caller hung up: teardown clears the bridge before close()
  await collector.close();
  // Neither `completed` matched its key, so both replies become rows at close — after the caller rows.
  assert.deepEqual(rows(posts), [['ai', 0, `您好，我是助理${CUT_MARKER}`], ['caller', 1, '喂'], ['caller', 2, '等一下'],
    ['ai', 3, `好的，我帮您转达，请问${CUT_MARKER}`], ['ai', 4, `好的，再见${CUT_MARKER}`]]);
  assert.deepEqual(collector.stats(), { sent: 5, dropped: 0, failed: 0, pending: 0, merged: 0, cut: 3 });
});

test('S127: a farewell that drained before the hangup is not marked though its row is made at close', async () => {
  const { agent, collector, posts, queue } = playoutSetup();
  agent.emit('transcript', { text: '好的，再见', final: true, responseId: 'r2' });
  queue.enqueued = 256_000;
  agent.emit('completed', { status: 'completed', responseId: 'x2' });
  // An unanswered end_call leaves a sub-frame remainder that only the teardown clears.
  queue.played = 255_500; queue.cleared = 500;
  await collector.close();
  assert.deepEqual(rows(posts), [['ai', 0, '好的，再见']]);
  assert.equal(collector.stats().cut, 0);
});

test('S127: a reply that played out stays unmarked when a later reply is cut, mismatched ids throughout', async () => {
  const { agent, collector, posts, queue } = playoutSetup();
  agent.emit('transcript', { text: '请问您找哪位', final: true, responseId: 'r1' });
  queue.enqueued = 50_000;
  agent.emit('completed', { status: 'completed', responseId: 'x1' });
  queue.played = 50_000;
  agent.emit('transcript', { text: '我找王先生', final: true, speaker: 'caller' });
  agent.emit('transcript', { text: '好的，我帮您转达', final: true, responseId: 'r2' });
  queue.enqueued = 110_000;
  agent.emit('completed', { status: 'completed', responseId: 'x2' });
  queue.played = 60_000; queue.cleared = 50_000;
  await collector.close();
  assert.deepEqual(rows(posts).filter(row => row[0] === 'ai').map(row => row[2]), ['请问您找哪位', `好的，我帮您转达${CUT_MARKER}`]);
});

test('S127: a mid-call reply is held while its audio is queued, and a caller row never passes it', async () => {
  const { agent, collector, posts, queue, flush } = playoutSetup();
  agent.emit('transcript', { text: '好的，', final: false, responseId: 'r1' });
  agent.emit('transcript', { text: '请稍等', final: false, responseId: 'r1' });
  queue.enqueued = 64_000;
  agent.emit('completed', { status: 'completed', responseId: 'r1' });
  await flush();
  agent.emit('transcript', { text: '谢谢', final: true, speaker: 'caller' });
  queue.played = 32_000;
  await flush();
  assert.deepEqual(posts, [], 'two rows wait behind the audio still queued');
  assert.equal(collector.stats().pending, 2);
  // `end` was read before the bridge padded the tail: one frame short of it is played out.
  queue.played = 63_500;
  await flush();
  assert.deepEqual(rows(posts), [['ai', 0, '好的，请稍等'], ['caller', 1, '谢谢']]);
  await collector.close();
});

test('S127: a hangup inside the last half second is not a cut', async () => {
  const { agent, collector, posts, queue } = playoutSetup();
  agent.emit('transcript', { text: '好的，再见', final: true, responseId: 'r1' });
  queue.enqueued = 64_000;
  agent.emit('completed', { status: 'completed', responseId: 'x1' });
  queue.played = 48_032; queue.cleared = 15_968;
  await collector.close();
  assert.deepEqual(rows(posts), [['ai', 0, '好的，再见']]);
});

test('S127: without a playout accessor an AI row posts once any completed arrives, or at close', async () => {
  const { agent, collector, posts, flush } = setup();
  agent.emit('transcript', { text: '您好', final: true, responseId: 'K1', immediate: true });
  await flush();
  assert.deepEqual(posts, [], 'no completed yet');
  agent.emit('completed', { responseId: 'other' });
  agent.emit('transcript', { text: '请讲', final: false, responseId: 'r1' });
  agent.emit('completed', { responseId: 'r1' });
  await flush();
  assert.deepEqual(rows(posts), [['ai', 0, '您好'], ['ai', 1, '请讲']]);
  agent.emit('transcript', { text: '再见', final: true, responseId: 'K2', immediate: true });
  await collector.close();
  assert.deepEqual(rows(posts).at(-1), ['ai', 2, '再见']);
});

test('S127: the marker fits inside the text limit Control enforces, and a throwing accessor is harmless', async () => {
  let cleared = 0;
  const { agent, collector, posts } = setup({ playout: () => { if (cleared < 0) throw new Error('bridge gone'); return { enqueued: 0, played: 0, cleared }; } });
  agent.emit('transcript', { text: '长'.repeat(20_000), final: false, responseId: 'r1' });
  cleared = 16_000;
  agent.emit('completed', { responseId: 'r1' });
  cleared = -1;
  agent.emit('transcript', { text: '喂', final: true, speaker: 'caller' });
  await collector.close();
  assert.equal(posts[0][0].text.length, 16_384);
  assert.ok(posts[0][0].text.endsWith(CUT_MARKER));
  assert.equal(posts[0][1].text, '喂');
});
