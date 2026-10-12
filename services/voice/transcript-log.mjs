import { pcmConstants } from './pcm-pipeline.mjs';

const MAX_TEXT = 16_384;
const MAX_BUFFERS = 50;
/** S127: appended to an AI row whose audio was dropped from the playback queue before the caller heard it. */
export const CUT_MARKER = '（未播完）';
// S127: bytes of queued 16 kHz PCM16 (the playback queue's unit), 500 ms. Less than this dropped is a
// hangup in the trailing fraction of a second — the sentence was heard, it is not marked.
const CUT_MIN_BYTES = 50 * pcmConstants.PCM16K_10MS_BYTES;
const NO_PLAYOUT = { enqueued: 0, played: 0, cleared: 0 };

/**
 * S27: a provider closes every intermediate final with a full stop and rewrites it into a comma when
 * the sentence turns out to continue — run 0407de3e reported "呃，请记下号码。" then "呃，请记下号码，
 * 388。" then "呃，请记下号码，388665。". Compared literally those are not prefixes, so a sentence read
 * across pauses split into a row per revision no matter how long it was held. Trailing punctuation is
 * therefore not part of the utterance for the comparison; it is kept in the text that is posted.
 * Only the tail is normalised, so a rewrite deeper inside the sentence is still a different utterance.
 */
const TRAILING_PUNCTUATION = /[\s。？！，、；：…．\.,?!;:]+$/u;

/**
 * Two caller finals are the same utterance when one is the other, or a prefix of it, ignoring the
 * punctuation each ends with. That covers all three shapes seen in production: the identical text
 * repeated ("请问你是" three times in a second), the growing prefix ("呃，那我" → "呃，那我这里还有个
 * 快递") and the re-punctuated prefix above. Distinct sentences are not prefixes of one another, so
 * they are never merged. The accepted cost is that a genuinely new sentence that starts with the
 * previous one ("好" then "好的谢谢") is treated as a revision inside the hold window.
 */
function isSameUtterance(held, next) {
  const a = held.replace(TRAILING_PUNCTUATION, '');
  const b = next.replace(TRAILING_PUNCTUATION, '');
  // A final made of nothing but punctuation normalises to '' and would otherwise prefix-match — and
  // so swallow — whatever the caller says next. It only merges into an identical one.
  if (!a || !b) return held === next;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Turns adapter transcript events into batched Control items. Every post is
 * best effort: the transcript is a by-product of the call, never a reason to
 * fault it. Sequence is one monotonic counter shared by both roles because
 * Control enforces UNIQUE(run_id, sequence) per run, not per role.
 */
export class TranscriptCollector {
  // S27: callerHoldMs 1_200 → 3_000. On run 0407de3e xAI spread one slowly read phone number over
  // four to seven `...transcription.completed` events 1–2.5 s apart, so a 1.2 s hold expired between
  // revisions and one sentence became four and seven rows. 3 s covers the observed gaps with margin;
  // the accepted cost is that a settled caller row now lands 3–5 s after its last revision (hold plus
  // the flushMs 2 s tick) instead of 1.2–3.2 s. Nothing waits on it: close() flushes what is held.
  //
  // S127: text is what the provider generated, not what was played. `playout()` returns the playback
  // queue's whole-run byte totals, with enqueued === played + cleared + still queued. An AI item takes
  // `cleared` as its baseline when its text first appears and is held — as an open buffer or as an
  // unposted row — until it is settled: cut (≥ CUT_MIN_BYTES cleared since) or played (a `completed`
  // came, and everything enqueued by then has left the queue). The verdict is frozen once reached, so
  // a later barge-in or the teardown clear cannot mark a reply that had already played out.
  constructor({ flushMs = 2_000, maxBatch = 50, maxPending = 400, post, recording = true,
    now = () => Date.now(), callerHoldMs = 3_000, playout = () => NO_PLAYOUT } = {}) {
    Object.assign(this, { flushMs, maxBatch, maxPending, post, now, callerHoldMs });
    // A throwing accessor must never surface inside the provider's emit.
    this.playout = () => { try { return playout() ?? NO_PLAYOUT; } catch { return NO_PLAYOUT; } };
    // S22 决策 3: the worker starts the collector muted and opens it at activation, so the opener the
    // Space agent says to itself while the bridge is still silent never becomes call history.
    this.recording = recording === true;
    this.pending = [];
    this.buffers = new Map();
    // S23 决策 4: one held caller utterance, replaced in place while the provider keeps revising it.
    this.callerPending = null;
    // How many caller finals were folded into an utterance already held: dedup self-evidence in run_closed.
    this.merged = 0;
    this.sequence = 0;
    this.sent = 0;
    this.dropped = 0;
    this.failed = 0;
    // S127: rows posted with CUT_MARKER.
    this.cut = 0;
    this.started = false;
    this.closed = false;
    this.flushing = null;
    this.onTranscript = event => { if (!this.closed) this.handleTranscript(event); };
    this.onCompleted = event => { if (!this.closed) { this.flushResponse(event?.responseId ?? ''); this.markDone(); this.settle(); } };
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.timer = setInterval(() => { void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  /** Opened once at real audio activation; closing it again also drops any half-built response. */
  setRecording(value) {
    const next = value === true;
    if (this.recording === next) return;
    this.recording = next;
    if (!next) { this.buffers.clear(); this.callerPending = null; }
  }

  attach(agent) { agent.on('transcript', this.onTranscript); agent.on('completed', this.onCompleted); }
  detach(agent) { agent.off('transcript', this.onTranscript); agent.off('completed', this.onCompleted); }

  handleTranscript(event) {
    if (!this.recording) return;
    this.settle();
    // Expiry is checked here as well as on the flush tick: with flushMs 2 s the tick alone decides
    // "is this still the same utterance?" up to 2 s late, which would fold a revision that arrived
    // well after the hold window into the previous row. Evaluated per event, the boundary is exactly
    // callerHoldMs since the last revision, whatever the timer is doing.
    this.expireCaller();
    const text = String(event?.text ?? '');
    // Caller transcription arrives as cumulative updates then one final text.
    if (event?.speaker === 'caller') { if (event.final === true) this.holdCaller(text, event.itemId); return; }
    // A standalone AI final (the Doubao greeting) is a row now: its completed may never match its key.
    if (event?.immediate === true) { this.flushCaller(); this.enqueue('ai', text, undefined, this.newHold()); return; }
    const key = event?.responseId ?? '';
    const open = this.buffers.get(key) ?? { text: '', hold: this.newHold() };
    open.text = `${open.text}${text}`.slice(0, MAX_TEXT);
    // S127: more text means more audio to come — a `completed` that belonged to another response
    // must not have closed this one. A cut stays a cut.
    if (open.hold.cut !== true) { open.hold.end = null; open.hold.cut = null; }
    this.buffers.set(key, open);
    while (this.buffers.size > MAX_BUFFERS) this.flushResponse(this.buffers.keys().next().value);
  }

  /**
   * S23 决策 4: xAI reports one caller utterance as several `...transcription.completed` events —
   * the same text three times within a second, or a growing prefix ("呃，那我" → "呃，那我这里还有个
   * 快递"). Each one used to take its own sequence, so a single sentence became three transcript rows.
   * Hold the newest version of the current utterance for callerHoldMs and enqueue only that: a
   * revision replaces what is held, an unrelated sentence posts the held one first. Control keeps
   * UNIQUE(run_id, sequence), which cannot see content, so the whole rule lives here.
   * The window is measured from the LAST accepted revision, not from the first: a caller reading a
   * number aloud keeps extending one utterance, and each extension restarts the hold.
   */
  holdCaller(text, itemId) {
    const value = String(text ?? '').trim().slice(0, MAX_TEXT);
    // An empty final is not an utterance: it must neither close nor become the held one.
    if (!value) return;
    const id = typeof itemId === 'string' && itemId ? itemId : undefined;
    const held = this.callerPending;
    // S120a: when both finals carry the provider item id, it alone decides. xAI rewrote one utterance
    // on one field call as 「I'm」→「你好，请问需要保洁。」→「你好，请问你需要保洁服务吗？」 — not prefixes,
    // so the text rule made three rows. Same id = a revision whose LATEST text is the provider's
    // correction; different ids = different utterances, however alike. Without an id on either side
    // the prefix rule below is unchanged. A same-id final after the hold expired still opens a new
    // row: Control has no update path for a posted one.
    const byId = Boolean(held?.itemId) && Boolean(id);
    const revision = Boolean(held) && (byId ? held.itemId === id : isSameUtterance(held.text, value));
    if (held && !revision) this.flushCaller(); else if (revision) this.merged++;
    // Prefix rule: only the longest version survives, a late repeat must never truncate a sentence.
    const longest = revision && !byId && held.text.length > value.length ? held.text : value;
    // S27: `at` is the FIRST revision's time — when the caller started saying this — not the latest.
    // It used to follow the latest event; with a 3 s hold over several revisions that read seconds
    // after the fact and could sort a long caller utterance after the AI reply it triggered. Rows are
    // ordered by `sequence` in Control, so this only changes the timestamp shown next to the row.
    // `now` is Date.now outside tests, so production timestamps keep their real wall-clock value.
    const at = revision ? held.at : new Date(this.now()).toISOString();
    // heldSince is the last accepted revision: expireCaller measures the window from here.
    this.callerPending = { text: longest, at, heldSince: this.now(), itemId: id ?? (revision ? held.itemId : undefined) };
  }

  flushCaller() {
    const held = this.callerPending;
    if (!held) return;
    this.callerPending = null;
    this.enqueue('caller', held.text, held.at);
  }

  /** Posts the held utterance once the provider has stopped revising it. */
  expireCaller() {
    if (this.callerPending && this.now() - this.callerPending.heldSince >= this.callerHoldMs) this.flushCaller();
  }

  flushResponse(key) {
    if (!this.buffers.has(key)) return;
    const { text, hold } = this.buffers.get(key);
    this.buffers.delete(key);
    // The caller spoke before the reply it triggered: keep the shared sequence in conversation order.
    this.flushCaller();
    this.enqueue('ai', text, undefined, hold);
  }

  /** S127: `cut` null = undecided (held), true/false = frozen verdict; `end` = bytes enqueued when its audio was all in. */
  newHold() { return { cleared0: this.playout().cleared, end: null, cut: null }; }

  holds() { return [...this.buffers.values(), ...this.pending].map(item => item.hold).filter(Boolean); }

  /** S127: any `completed` closes every item that already has text — provider response ids are unreliable. */
  markDone() {
    const { enqueued } = this.playout();
    for (const hold of this.holds()) if (hold.end === null) hold.end = enqueued;
  }

  /**
   * S127: cut is tested first — after a flush "everything left the queue" is trivially true. The
   * played test tolerates one 20 ms frame: `end` is read before the bridge pads the tail, and a
   * turn that never completes leaves a sub-frame remainder queued for good (S27 决策 14).
   * `final` (close) settles whatever is still undecided as played.
   */
  settle(final = false) {
    const { played, cleared } = this.playout();
    for (const hold of this.holds()) {
      if (hold.cut !== null) continue;
      if (cleared - hold.cleared0 >= CUT_MIN_BYTES) hold.cut = true;
      else if (final || (hold.end !== null && played + cleared > hold.end - pcmConstants.PCM16K_20MS_BYTES)) hold.cut = false;
    }
  }

  enqueue(role, text, at = new Date().toISOString(), hold) {
    const value = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!value) return;
    this.pending.push({ role, sequence: this.sequence++, text: value, at, ...(hold ? { hold } : {}) });
    while (this.pending.length > this.maxPending) { this.pending.shift(); this.dropped++; }
    if (this.pending.length >= this.maxBatch) void this.flush();
  }

  flush() {
    this.expireCaller();
    this.settle();
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async drain() {
    for (;;) {
      // S127: only the leading settled rows go out — nothing passes an AI row still held, so Control
      // keeps receiving sequences in order. Recounted every pass: close() settles under a live drain.
      let count = 0;
      while (count < this.pending.length && count < this.maxBatch && this.pending[count].hold?.cut !== null) count++;
      if (!count) return;
      const marked = this.pending.slice(0, count).filter(item => item.hold?.cut).length;
      // Control rejects text over MAX_TEXT, so the marker takes its room from the text.
      const batch = this.pending.splice(0, count).map(({ hold, ...item }) => hold?.cut
        ? { ...item, text: `${item.text.slice(0, MAX_TEXT - CUT_MARKER.length)}${CUT_MARKER}` } : item);
      try { await this.post(batch); this.sent += batch.length; this.cut += marked; }
      catch {
        // Never requeue and never keep retrying: a stalled Control must not
        // delay the run's failure report behind a queue of timing-out posts.
        this.failed += batch.length;
        this.dropped += this.pending.length;
        this.pending.length = 0;
        return;
      }
    }
  }

  async close() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.closed) {
      this.closed = true;
      for (const key of [...this.buffers.keys()]) this.flushResponse(key);
      // The last utterance never gets a following event to close it: the run ending is that event.
      this.flushCaller();
    }
    // S127: nothing stays held past the run — what was not cut by now was played.
    this.settle(true);
    await this.flush();
    // A drain that had just found nothing settled may still be the one `flush()` handed back.
    if (this.pending.length) await this.flush();
  }

  stats() { return { sent: this.sent, dropped: this.dropped, failed: this.failed, pending: this.pending.length, merged: this.merged, cut: this.cut }; }
}
