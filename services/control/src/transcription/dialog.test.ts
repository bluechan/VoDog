import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {buildDialog, markUnplayed, UNPLAYED_MARKER} from './dialog.js';

const fixture = JSON.parse(await readFile(new URL('../../test/fixtures/s101-dialog.json', import.meta.url), 'utf8'));

for (const name of ['humanCall', 'aiCallRealtime', 'aiCallWithoutRealtime', 'noSegments']) {
  test(`S101 buildDialog fixture: ${name}`, () => {
    const {call, manifest, result, aiLines, expected} = fixture[name];
    assert.deepEqual(buildDialog({call, manifest, result, aiLines}), expected);
  });
}

test('S101 buildDialog: a track without bytes is not shifted, an untimed segment closes its track, Latin text joins with a space', () => {
  const dialog = buildDialog({
    call: {answeredBy: 'device', answeredAt: null},
    manifest: {tracks: [{track: 'remote_original', bytes: 64000}]},
    result: {segments: [
      {track: 'remote_original', speaker: 'remote', text: 'hello', startMs: 0, endMs: 500},
      {track: 'remote_original', speaker: 'remote', text: 'there', startMs: 1000, endMs: 1500},
      {track: 'remote_original', speaker: 'remote', text: 'tail'},
      {track: 'caller_original', speaker: 'vodog_user', text: 'hi', startMs: 600, endMs: 900},
    ]},
  });
  assert.deepEqual(dialog, {timebase: 'end_aligned', maxSkewMs: 0, turns: [
    {role: 'remote', text: 'hello', atMs: 0, endAtMs: 500, source: 'asr', track: 'remote_original'},
    {role: 'me', text: 'hi', atMs: 600, endAtMs: 900, source: 'asr', track: 'caller_original'},
    {role: 'remote', text: 'there tail', atMs: 1000, endAtMs: 1500, source: 'asr', track: 'remote_original'},
  ]});
});

test('S102 buildDialog: timebase mix uses startMs directly, ignores track bytes and reports no skew', () => {
  const dialog = buildDialog({
    call: {answeredBy: 'device', answeredAt: null},
    manifest: {tracks: [{track: 'remote_original', bytes: 320000, droppedFrames: 9}, {track: 'caller_original', bytes: 64000, droppedFrames: 9}]},
    result: {recording: {timebase: 'mix'}, segments: [
      {track: 'mix', speaker: 'remote', text: '喂', startMs: 500, endMs: 1500, attribution: 'energy', energyRatio: 9.5},
      {track: 'mix', speaker: 'vodog_user', text: '你好', startMs: 1200, endMs: 2000, attribution: 'label', energyRatio: 1.2},
      {track: 'mix', speaker: 'remote', text: '再见', startMs: 4000, endMs: 4500, attribution: 'energy', energyRatio: 3},
    ]},
  });
  assert.deepEqual(dialog, {timebase: 'mix', maxSkewMs: 0, turns: [
    {role: 'remote', text: '喂', atMs: 500, endAtMs: 1500, source: 'asr', track: 'mix'},
    {role: 'me', text: '你好', atMs: 1200, endAtMs: 2000, source: 'asr', track: 'mix'},
    {role: 'remote', text: '再见', atMs: 4000, endAtMs: 4500, source: 'asr', track: 'mix'},
  ]});
});

test('S128 buildDialog: speech at the end of the caller-side track marks the last AI line as cut off', () => {
  const {call, manifest, result, aiLines, expected} = fixture.aiCallRealtime;
  const texts = (input: Parameters<typeof buildDialog>[0]) => buildDialog(input)!.turns.map((turn) => turn.text);
  const plain = expected.turns.map((turn: {text: string}) => turn.text);
  const cut = {...result, recording: {callerTailActive: true}};
  assert.equal(UNPLAYED_MARKER, '（未播完）');
  assert.deepEqual(texts({call, manifest, result: cut, aiLines}), [plain[0], plain[1], `${plain[2]}（未播完）`]);
  // Everything but the text is the plain dialog.
  assert.deepEqual(buildDialog({call, manifest, result: cut, aiLines})!.turns.map((turn) => ({...turn, text: ''})),
    expected.turns.map((turn: object) => ({...turn, text: ''})));
  // The Voice worker already marked the line (trailing whitespace is trimmed first): never doubled.
  const marked = aiLines.map((line: {text: string}, index: number) => index === 2 ? {...line, text: `${line.text}（未播完） `} : line);
  assert.deepEqual(texts({call, manifest, result: cut, aiLines: marked}), [plain[0], plain[1], `${plain[2]}（未播完）`]);
  // Flag false or absent, or the owner took the call over (S94): unchanged.
  assert.deepEqual(texts({call, manifest, result: {...result, recording: {callerTailActive: false}}, aiLines}), plain);
  assert.deepEqual(texts({call, manifest, result: {...result, recording: {}}, aiLines}), plain);
  assert.deepEqual(texts({call: {...call, ownerJoinedLocal: true}, manifest, result: cut, aiLines}), plain);
  // The marker goes on the LAST AI line even when a caller line follows it; earlier AI lines are untouched.
  const callerLast = [...aiLines, {role: 'caller', text: '喂？', at: '2026-10-06T02:16:41.000Z'}];
  assert.deepEqual(texts({call, manifest, result: cut, aiLines: callerLast}), [plain[0], plain[1], `${plain[2]}（未播完）`, '喂？']);
  // No AI line at all: nothing to mark.
  assert.deepEqual(texts({call, manifest, result: cut, aiLines: [aiLines[1]]}), [plain[1]]);
});

// The AI-conversation view passes raw `ai_run_transcripts` rows, which `buildDialog` would have trimmed and filtered.
test('S128 markUnplayed: raw rows get the marker on the same line the dialog picks', () => {
  const rows = (...texts: string[]) => texts.map((text, index) => ({role: index % 2 ? 'caller' : 'ai', text}));
  assert.deepEqual(markUnplayed(rows('一', '二', '三 ', '四', '  ')).map((row) => row.text), ['一', '二', '三（未播完）', '四', '  ']);
  assert.deepEqual(markUnplayed(rows('一', '二', '三（未播完） ')).map((row) => row.text), ['一', '二', '三（未播完） ']);
  assert.deepEqual(markUnplayed(rows()), []);
});

test('S128 buildDialog: the ASR fallback branch never gets the marker', () => {
  const {call, manifest, result, expected} = fixture.aiCallWithoutRealtime;
  assert.deepEqual(buildDialog({call, manifest, result: {...result, recording: {...result.recording, callerTailActive: true}}, aiLines: []}), expected);
});
