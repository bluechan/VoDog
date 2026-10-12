import assert from 'node:assert/strict';
import test from 'node:test';
import {attributeSegments} from './attribution.js';

/** 10 ms RMS envelope of `ms` on the mix timeline, with `voiced` [fromMs, toMs) windows at RMS 8000. */
function envelope(ms: number, voiced: Array<[number, number]>) {
  const values = new Float32Array(ms / 10);
  for (const [from, to] of voiced) values.fill(8000, from / 10, to / 10);
  return values;
}

test('S102 attribution: a clearly louder track decides the speaker regardless of the label', () => {
  // The caller track starts 1 s into the mix, so its speech sits at 2–3 s on the mix timeline.
  const tracks = {remote: envelope(4000, [[0, 1000]]), caller: envelope(4000, [[2000, 3000]])};
  const result = attributeSegments([{startMs: 0, endMs: 1000, label: 'B'}, {startMs: 2000, endMs: 3000, label: 'B'}], tracks);
  assert.deepEqual(result.map((item) => [item.speaker, item.attribution]), [['remote', 'energy'], ['vodog_user', 'energy']]);
  assert.ok(result[0]!.energyRatio >= 2);
});

test('S102 attribution: simultaneous speech maps A/B by the majority of energy-certain segments', () => {
  const tracks = {remote: envelope(5000, [[0, 1000], [2000, 3000], [4000, 5000]]), caller: envelope(5000, [[1000, 2000], [4000, 5000]])};
  const result = attributeSegments([
    {startMs: 0, endMs: 1000, label: 'B'},
    {startMs: 1000, endMs: 2000, label: 'A'},
    {startMs: 2000, endMs: 3000, label: 'B'},
    {startMs: 4000, endMs: 5000, label: 'A'},
    {startMs: 4000, endMs: 5000},
  ], tracks);
  // Three certain votes say B = remote, so the overlapping A segment is the VoDog user.
  assert.deepEqual(result.slice(3).map((item) => [item.speaker, item.attribution, item.energyRatio]),
    [['vodog_user', 'label', 1], ['remote', 'unknown', 1]]);
});

test('S102 attribution: without certain segments A is the louder side of the first segment; empty windows widen by 300 ms', () => {
  const tracks = {remote: envelope(2000, [[0, 2000]]), caller: envelope(2000, [[0, 2000]])};
  tracks.remote[0] = 9000;
  const result = attributeSegments([{startMs: 0, endMs: 0, label: 'A'}, {startMs: 500, endMs: 1500, label: 'B'}], tracks);
  assert.deepEqual(result.map((item) => [item.speaker, item.attribution]), [['remote', 'label'], ['vodog_user', 'label']]);
});
