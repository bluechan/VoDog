import assert from 'node:assert/strict';
import test from 'node:test';
import {validTranscriptionAudio} from './audio-format.js';
import {mixTracks} from './mix.js';
import {canonicalWav} from './wav-chunks.js';

const track = (samples: number[]) => {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  return canonicalWav(pcm);
};
const samples = (wav: Buffer) => Array.from({length: (wav.length - 44) / 2}, (_, index) => wav.readInt16LE(44 + index * 2));

test('S102 mixTracks aligns both tracks by their end and reports the front padding as offsets', () => {
  const remote = track(Array.from({length: 64}, () => 100));
  const caller = track(Array.from({length: 32}, () => 7));
  const mixed = mixTracks({remote, caller})!;
  assert.ok(validTranscriptionAudio(mixed.wav, 'audio/wav', 3));
  assert.deepEqual(mixed.offsets, {remoteMs: 0, callerMs: 2});
  assert.equal(mixed.durationMs, 4);
  assert.deepEqual(samples(mixed.wav), [...Array(32).fill(100), ...Array(32).fill(107)]);
  // S102b: one 10 ms frame here; the caller's front padding counts as silence in its envelope.
  assert.deepEqual([...mixed.envelopes.remote], [100]);
  assert.ok(Math.abs(mixed.envelopes.caller[0]! - Math.sqrt(32 * 49 / 64)) < 1e-4);
});

test('S102 mixTracks clips the sum to PCM16 instead of wrapping', () => {
  const mixed = mixTracks({remote: track([30_000, -30_000, 1]), caller: track([10_000, -10_000, -1])})!;
  assert.deepEqual(samples(mixed.wav), [32_767, -32_768, 0]);
});

test('S102 mixTracks returns null when either track is missing', () => {
  assert.equal(mixTracks({remote: track([1]), caller: null}), null);
  assert.equal(mixTracks({remote: undefined, caller: track([1])}), null);
});
