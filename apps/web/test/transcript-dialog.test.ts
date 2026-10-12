import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestInstance, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.resolve(here, 'fixtures/s101-dialog.json'), 'utf8'));

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (!node || typeof node !== 'object') return '';
  const record = node as {children?: unknown[]; props?: {children?: unknown}};
  return collectText(record.children ?? record.props?.children);
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const classes = (node: ReactTestInstance) => String(node.props.className || '').split(' ');

let server: ViteDevServer | undefined;
async function harness() {
  if (!server) server = await createServer({root: path.resolve(here, '..'), server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await server.ssrLoadModule('/src/reports.tsx')) as typeof import('../src/reports.tsx');
}
after(async () => {
  await server?.close();
  server = undefined;
});

/** Opens 转录 for one call whose `/transcript` response carries `dialog` (or not). */
async function renderTranscript(sample: {result: unknown}, dialog: unknown) {
  const {CallTranscript} = await harness();
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({transcript: {status: 'succeeded', result: {text: 'x', summary: '摘要内容', actionItems: ['回电'], ...(sample.result as object)}, dialog}}), {status: 200});
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(CallTranscript, {callId: 'call-1', initialOpen: true}));
    });
    await act(async () => {
      await flush();
    });
    const bubbles = renderer!.root.findAll(node => node.type === 'article' && classes(node).includes('message-bubble'));
    return {renderer: renderer!, bubbles, text: collectText(renderer!.toJSON())};
  } finally {
    globalThis.fetch = previous;
  }
}

test('S101 human call: 对方 left (incoming), 我 right (outgoing), mm:ss under each bubble, 4/12 px gap classes', async () => {
  const {renderer, bubbles, text} = await renderTranscript(fixture.humanCall, fixture.humanCall.expected);
  try {
    assert.deepEqual(bubbles.map(node => classes(node).includes('incoming') ? 'L' : 'R'), ['L', 'R', 'L', 'R']);
    assert.ok(bubbles.every(node => !classes(node).includes('ai')));
    assert.deepEqual(bubbles.map(node => collectText(node.findByType('small'))), ['00:00', '00:02', '00:08', '00:08']);
    assert.deepEqual(bubbles.map(node => collectText(node.findByType('p'))), fixture.humanCall.expected.turns.map((turn: {text: string}) => turn.text));
    assert.equal(bubbles.filter(node => classes(node).includes('turn-follow')).length, 0, 'roles alternate: every gap is 12 px');
    assert.doesNotMatch(text, /时间为估算/, 'maxSkewMs 600 is not an estimate');
    assert.match(text, /摘要摘要内容/);
    assert.match(text, /回电/, 'action items stay above the conversation');
    assert.equal(renderer.root.findAll(node => classes(node).includes('transcript-line')).length, 0);
  } finally {
    renderer.unmount();
  }
});

test('S101 AI call: AI bubbles sit right on aiSoft with a ✦ AI label; 2753 → 00:02, 12231 → 00:12', async () => {
  const {renderer, bubbles} = await renderTranscript(fixture.aiCallRealtime, fixture.aiCallRealtime.expected);
  try {
    assert.deepEqual(bubbles.map(node => classes(node).filter(name => ['incoming', 'outgoing', 'ai'].includes(name)).join(' ')), ['outgoing ai', 'incoming', 'outgoing ai']);
    const ai = bubbles.filter(node => classes(node).includes('ai'));
    assert.ok(ai.every(node => collectText(node.find(child => classes(child).includes('ai-badge'))) === '✦AI'));
    assert.equal(bubbles[1]!.findAll(node => classes(node).includes('ai-badge')).length, 0);
    assert.deepEqual(bubbles.map(node => collectText(node.findByType('small'))), ['00:02', '00:12', '00:12']);
  } finally {
    renderer.unmount();
  }
});

test('S101 same-role neighbours get the 4 px follow class, 83000 → 01:23, and maxSkewMs > 1500 shows 时间为估算', async () => {
  const dialog = {timebase: 'end_aligned', maxSkewMs: 1600, turns: [
    {role: 'me', text: '一', atMs: 0, source: 'asr'},
    {role: 'me', text: '二', atMs: 83000, source: 'asr'},
    {role: 'remote', text: '三', atMs: 90000, source: 'asr'},
  ]};
  const {renderer, bubbles, text} = await renderTranscript(fixture.humanCall, dialog);
  try {
    assert.deepEqual(bubbles.map(node => classes(node).includes('turn-follow')), [false, true, false]);
    assert.equal(collectText(bubbles[1]!.findByType('small')), '01:23');
    assert.match(text, /时间为估算/);
  } finally {
    renderer.unmount();
  }
});

test('S101 dialog null (older Control) keeps today\'s flat lines', async () => {
  const {renderer, bubbles} = await renderTranscript(fixture.humanCall, null);
  try {
    assert.equal(bubbles.length, 0);
    const lines = renderer.root.findAll(node => node.type === 'p' && classes(node).includes('transcript-line'));
    assert.equal(lines.length, 2, 'the merged per-track blocks of today');
    assert.match(collectText(lines[0]), /^00:00对方/);
  } finally {
    renderer.unmount();
  }
});
