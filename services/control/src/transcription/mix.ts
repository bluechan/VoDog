import {canonicalWav} from './wav-chunks.js';

/** S102: a mixed call goes to the provider in pieces of at most 3 min; the probe saw a 150 s window
 * squeeze its last 28 s of speech into 7 s, so the pieces stay well short of that. */
export const MIX_CHUNK_MS = 3 * 60_000;
const HEADER_BYTES = 44;
const BYTES_PER_MS = 32;

/** S102b: one RMS value per 10 ms of the mix timeline (offsets applied, padding counts as silence). */
export const ENVELOPE_FRAME_MS = 10;
const ENVELOPE_FRAME_SAMPLES = ENVELOPE_FRAME_MS * 16;

export type MixedTracks = {wav: Buffer; offsets: {remoteMs: number; callerMs: number}; durationMs: number;
  envelopes: {remote: Float32Array; caller: Float32Array}};

/**
 * S102: both canonical 16 kHz mono PCM16 tracks end at hangup, so they are aligned by their end: the
 * shorter one is padded with silence at the front (that padding is its `offsetMs`), the samples are
 * summed and clipped to PCM16, and the result is one canonical WAV on the call's own timeline.
 * `null` when either track is missing — the caller then keeps the per-track path.
 */
export function mixTracks({remote, caller}: {remote?: Buffer | null; caller?: Buffer | null}): MixedTracks | null {
  if (!remote || !caller) return null;
  const a = remote.subarray(HEADER_BYTES), b = caller.subarray(HEADER_BYTES);
  const length = Math.max(a.length, b.length);
  const padA = length - a.length, padB = length - b.length;
  const out = Buffer.alloc(length);
  const samples = length >> 1;
  const frames = Math.ceil(samples / ENVELOPE_FRAME_SAMPLES);
  const remoteEnvelope = new Float32Array(frames), callerEnvelope = new Float32Array(frames);
  let remoteSquares = 0, callerSquares = 0;
  for (let sample = 0; sample < samples; sample++) {
    const offset = sample * 2;
    const x = offset >= padA ? a.readInt16LE(offset - padA) : 0, y = offset >= padB ? b.readInt16LE(offset - padB) : 0;
    const sum = x + y;
    out.writeInt16LE(sum > 32_767 ? 32_767 : sum < -32_768 ? -32_768 : sum, offset);
    remoteSquares += x * x; callerSquares += y * y;
    if ((sample + 1) % ENVELOPE_FRAME_SAMPLES === 0 || sample + 1 === samples) {
      const frame = Math.floor(sample / ENVELOPE_FRAME_SAMPLES), count = sample - frame * ENVELOPE_FRAME_SAMPLES + 1;
      remoteEnvelope[frame] = Math.sqrt(remoteSquares / count); callerEnvelope[frame] = Math.sqrt(callerSquares / count);
      remoteSquares = 0; callerSquares = 0;
    }
  }
  return {wav: canonicalWav(out), offsets: {remoteMs: padA / BYTES_PER_MS, callerMs: padB / BYTES_PER_MS}, durationMs: length / BYTES_PER_MS,
    envelopes: {remote: remoteEnvelope, caller: callerEnvelope}};
}
