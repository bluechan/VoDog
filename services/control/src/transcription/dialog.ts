/**
 * S101: a read-only conversation view of a stored transcript. Each ASR track starts at its own capture
 * start, but every track ends at hangup, so tracks are aligned by their end (PCM bytes → ms). An AI-answered
 * call prefers the realtime `ai_run_transcripts` lines, whose text and wall-clock times are exact.
 * Fixture: services/control/test/fixtures/s101-dialog.json.
 */
export type Turn = {role: 'remote' | 'me' | 'ai'; text: string; atMs: number; endAtMs?: number; source: 'asr' | 'ai_realtime'; track?: string};
export type Dialog = {timebase: 'end_aligned' | 'ai_realtime' | 'mix'; maxSkewMs: number; turns: Turn[]};
type ManifestTrack = {track?: unknown; bytes?: unknown; droppedFrames?: unknown};
type Segment = {track?: unknown; speaker?: unknown; text?: unknown; startMs?: unknown; endMs?: unknown};
export type DialogInput = {
  result: unknown;
  manifest: unknown;
  /** S128: `ownerJoinedLocal` = the AI run ended as `owner_joined` (S94), after which the caller-side track is the owner's voice. */
  call: {answeredBy?: string | null; answeredAt?: string | Date | null; ownerJoinedLocal?: boolean};
  aiLines?: Array<{role: string; text: string; at: string | Date}>;
};

const MERGE_GAP_MS = 1500;
/** S128: must equal `CUT_MARKER` in services/voice/transcript-log.mjs — the Voice worker appends the same literal. */
export const UNPLAYED_MARKER = '（未播完）';
/**
 * S128: the one place the marker is applied — the dialog (`buildDialog`) and the AI-conversation view
 * (`readCallTranscript`) both call this once they know the AI was cut off. Marks the last non-blank AI item
 * in place unless it already ends with the marker.
 */
export function markUnplayed<T extends {role: string; text: string}>(items: T[]): T[] {
  const last = items.findLast((item) => item.role === 'ai' && item.text.trim());
  if (last && !last.text.trimEnd().endsWith(UNPLAYED_MARKER)) last.text = last.text.trimEnd() + UNPLAYED_MARKER;
  return items;
}
const CJK = /[⺀-〿぀-ヿ㐀-鿿豈-﫿＀-￯]/u;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function join(previous: string, next: string) {
  return CJK.test(previous.slice(-1)) && CJK.test(next[0] ?? '') ? previous + next : `${previous} ${next}`;
}

export function buildDialog({result, manifest, call, aiLines = []}: DialogInput): Dialog | null {
  const ai = call.answeredBy === 'ai';
  const answeredAt = call.answeredAt == null ? NaN : new Date(call.answeredAt).getTime();
  if (ai && aiLines.length && Number.isFinite(answeredAt)) {
    const turns = aiLines.filter((line) => typeof line.text === 'string' && line.text.trim()).map((line): Turn => ({
      role: line.role === 'ai' ? 'ai' : 'remote', text: line.text.trim(),
      atMs: Math.max(0, new Date(line.at).getTime() - answeredAt), source: 'ai_realtime',
    }));
    // S128: the Voice worker cannot see a hangup in the last ~2 s of an AI line. The recording can: speech in the
    // caller-side track's final 500 ms (`recording.callerTailActive`, worker.ts) means the AI was cut off, so its
    // last line is marked here, at read time, unless Voice already marked it or the owner took the call over.
    if (!call.ownerJoinedLocal && (result as {recording?: {callerTailActive?: unknown}})?.recording?.callerTailActive === true) markUnplayed(turns);
    if (turns.length) return {timebase: 'ai_realtime', maxSkewMs: 0, turns};
  }

  const m = (manifest ?? {}) as {pcm?: {sampleRate?: unknown; channels?: unknown; bitsPerSample?: unknown}; tracks?: unknown; uplinkTracks?: unknown};
  const bytesPerMs = (num(m.pcm?.sampleRate) ?? 16000) * (num(m.pcm?.channels) ?? 1) * (num(m.pcm?.bitsPerSample) ?? 16) / 8 / 1000 || 32;
  const tracks = new Map<string, ManifestTrack>();
  for (const item of [m.tracks, m.uplinkTracks].flatMap((list) => Array.isArray(list) ? list as ManifestTrack[] : [])) {
    if (typeof item?.track === 'string') tracks.set(item.track, item);
  }
  const maxBytes = Math.max(0, ...[...tracks.values()].map((item) => num(item.bytes) ?? 0));
  // S102: a mixed transcript is already on the call timeline — no end alignment, no skew.
  const mixed = (result as {recording?: {timebase?: unknown}})?.recording?.timebase === 'mix';
  const offsetMs = (track: string) => {
    if (mixed) return 0;
    const bytes = num(tracks.get(track)?.bytes);
    return bytes === undefined ? 0 : (maxBytes - bytes) / bytesPerMs;
  };

  const segments = (result as {segments?: unknown})?.segments;
  const timed: Turn[] = [];
  const untimed: Turn[] = [];
  const trackEnd = new Map<string, number>();
  const skewTracks = new Set<string>();
  for (const segment of Array.isArray(segments) ? segments as Segment[] : []) {
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!text || typeof segment.track !== 'string') continue;
    const track = segment.track;
    const role = segment.speaker === 'remote' ? 'remote' : ai ? 'ai' : 'me';
    skewTracks.add(track);
    const start = num(segment.startMs), end = num(segment.endMs), offset = offsetMs(track);
    if (start === undefined) {
      // No timing: it stays at the end of its own track and never reorders anything else.
      untimed.push({role, text, atMs: offset, source: 'asr', track});
      continue;
    }
    const turn: Turn = {role, text, atMs: start + offset, ...(end === undefined ? {} : {endAtMs: end + offset}), source: 'asr', track};
    trackEnd.set(track, Math.max(trackEnd.get(track) ?? 0, turn.endAtMs ?? turn.atMs));
    timed.push(turn);
  }
  for (const turn of untimed) turn.atMs = Math.max(turn.atMs, trackEnd.get(turn.track!) ?? 0);
  // Array.prototype.sort is stable, so equal times keep the stored segment order.
  const sorted = [...timed, ...untimed].sort((a, b) => a.atMs - b.atMs);
  if (!sorted.length) return null;

  const turns: Turn[] = [];
  for (const turn of sorted) {
    const previous = turns[turns.length - 1];
    if (previous && previous.role === turn.role && turn.atMs - (previous.endAtMs ?? previous.atMs) <= MERGE_GAP_MS) {
      previous.text = join(previous.text, turn.text);
      if (turn.endAtMs !== undefined) previous.endAtMs = Math.max(previous.endAtMs ?? 0, turn.endAtMs);
      continue;
    }
    turns.push({...turn});
  }
  if (mixed) return {timebase: 'mix', maxSkewMs: 0, turns};
  const maxSkewMs = Math.max(0, ...[...skewTracks].map((track) => (num(tracks.get(track)?.droppedFrames) ?? 0) * 20));
  return {timebase: 'end_aligned', maxSkewMs, turns};
}
