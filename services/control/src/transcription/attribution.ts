/**
 * S102: who spoke a segment of the mixed transcript. The provider's A/B labels are consistent but not
 * tied to a channel, so the two original tracks decide: inside the segment's window the one with at
 * least twice the RMS of the other is the speaker. Overlapping or quiet segments fall back to the
 * labels, mapped to roles by the majority of this job's energy-certain segments.
 */
export type SpeakerRole = 'remote' | 'vodog_user';
export type SegmentAttribution = {speaker: SpeakerRole; attribution: 'energy' | 'label' | 'unknown'; energyRatio: number};
/** S102b: 10 ms RMS envelopes on the mix timeline (mix.ts), so the PCM tracks need not stay resident. */
export type AttributionTracks = {remote: Float32Array; caller: Float32Array};

const ENERGY_RATIO = 2;
const EMPTY_WINDOW_MS = 300;
const FRAME_MS = 10;

/** RMS over a mix-timeline window: sqrt of the mean of the squared 10 ms frame RMS values it covers. */
function rms(envelope: Float32Array, startMs: number, endMs: number) {
  const from = Math.max(0, Math.floor(startMs / FRAME_MS));
  const to = Math.min(envelope.length, Math.ceil(endMs / FRAME_MS));
  if (to <= from) return 0;
  let sum = 0;
  for (let index = from; index < to; index++) sum += envelope[index]! * envelope[index]!;
  return Math.sqrt(sum / (to - from));
}

export function attributeSegments(segments: Array<{startMs: number; endMs: number; label?: unknown}>, tracks: AttributionTracks): SegmentAttribution[] {
  const measured = segments.map((segment) => {
    const [start, end] = segment.endMs > segment.startMs ? [segment.startMs, segment.endMs]
      : [segment.startMs - EMPTY_WINDOW_MS, segment.startMs + EMPTY_WINDOW_MS];
    // A 1-LSB floor keeps the ratio finite (Infinity would be stored as null) and makes two silences 1.0.
    const remote = Math.max(1, rms(tracks.remote, start, end));
    const caller = Math.max(1, rms(tracks.caller, start, end));
    const louder: SpeakerRole = remote >= caller ? 'remote' : 'vodog_user';
    const ratio = Math.max(remote, caller) / Math.min(remote, caller);
    const label = segment.label === 'A' || segment.label === 'B' ? segment.label : undefined;
    return {louder, ratio, certain: ratio >= ENERGY_RATIO, label};
  });
  let votes = 0; // > 0: A is the remote party
  for (const item of measured) if (item.certain && item.label) votes += (item.label === 'A') === (item.louder === 'remote') ? 1 : -1;
  // No (or a tied) vote: A spoke first, so A is whoever was louder in the first segment.
  const aIsRemote = votes === 0 ? (measured[0]?.louder ?? 'remote') === 'remote' : votes > 0;
  return measured.map((item) => ({
    speaker: item.certain || !item.label ? item.louder : (item.label === 'A') === aIsRemote ? 'remote' : 'vodog_user',
    attribution: item.certain ? 'energy' : item.label ? 'label' : 'unknown',
    energyRatio: Math.round(item.ratio * 100) / 100,
  }));
}
