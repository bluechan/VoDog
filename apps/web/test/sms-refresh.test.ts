import assert from 'node:assert/strict';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import {createServer, type ViteDevServer} from 'vite';
import type {ThreadMessage} from '../src/message-threads.ts';

function textOf(node: ReactTestRenderer['root'] | ReturnType<ReactTestRenderer['root']['findAll']>[number]): string {
  const children = node.props.children;
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (!Array.isArray(children)) return children ? String(children) : '';
  return children.map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return child?.props ? textOf(child) : '';
  }).join('');
}

let server: ViteDevServer | undefined;
async function loadMessages() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  server ||= await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom'});
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  return (await server.ssrLoadModule('/src/messages.tsx')) as typeof import('../src/messages.tsx');
}

after(async () => {
  await server?.close();
  server = undefined;
});

test('a refreshed outgoing sent row appears in the correct SIM thread without a local send callback', async () => {
  const {Messages} = await loadMessages();
  const incoming: ThreadMessage = {
    id: 'incoming-before-refresh', simId: 'sim-a', direction: 'incoming', remoteNumber: '1001298',
    conversationAddress: '1001298', body: '旧消息', state: 'received', createdAt: '2026-09-21T06:40:00.000Z',
  };
  const otherSim: ThreadMessage = {
    id: 'other-sim', simId: 'sim-b', direction: 'outgoing', remoteNumber: '1001298',
    conversationAddress: '1001298', body: '错误 SIM', state: 'sent', createdAt: '2026-09-21T06:50:00.000Z',
  };
  const refreshed: ThreadMessage & {sentAt: string} = {
    id: 'pixel-observed', simId: 'sim-a', direction: 'outgoing', remoteNumber: '1001298',
    conversationAddress: '1001298', body: '1', state: 'sent',
    createdAt: '2026-09-21T06:41:42.544Z', sentAt: '2026-09-21T06:41:42.544Z',
  };
  let localSendCallbacks = 0;
  const props = (messages: ThreadMessage[]) => ({
    messages, simId: 'sim-a', simLabel: '号码 A', online: true, busy: false, timeZone: 'UTC', account: 'refresh-test',
    onSend: async () => { localSendCallbacks++; },
    onSent: async () => { localSendCallbacks++; },
  });

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Messages, props([incoming, otherSim]))); });
    const threadRow = renderer!.root.findAll(node => node.type === 'button' && String(node.props.className || '').includes('thread-row'))[0]!;
    assert.doesNotMatch(textOf(threadRow), /错误 SIM/, 'the selected SIM must own the visible thread');
    await act(async () => { threadRow.props.onClick(); });

    await act(async () => {
      renderer!.update(React.createElement(Messages, props([incoming, otherSim, refreshed])));
    });

    assert.equal(localSendCallbacks, 0, 'prop refresh alone must surface the server row');
    const rows = renderer!.root.findAll(node => node.type === 'button' && String(node.props.className || '').includes('thread-row'));
    assert.equal(rows.length, 1);
    assert.match(textOf(rows[0]!), /1/);
    assert.match(textOf(rows[0]!), /已发送/);
    assert.doesNotMatch(textOf(rows[0]!), /错误 SIM/);

    const bubbles = renderer!.root.findAll(node => node.type === 'article' && String(node.props.className || '').includes('message-bubble'));
    assert.deepEqual(bubbles.map(bubble => bubble.findByType('p').props.children), ['旧消息', '1'], 'the refreshed row follows chronological order');
    assert.match(bubbles[0]!.props.className, /incoming/);
    assert.match(bubbles[1]!.props.className, /outgoing/);
    assert.match(textOf(bubbles[1]!), /已发送/);
    assert.equal(bubbles[1]!.findByType('small').props.children[0], '2026-09-21 06:41');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
  }
});

test('S97: copying a verification code from a list row marks only that incoming message read', async () => {
  const {Messages} = await loadMessages();
  const older: ThreadMessage = {
    id: 'older-unread', simId: 'sim-a', direction: 'incoming', remoteNumber: '10690000',
    body: '旧消息', state: 'received', createdAt: '2026-10-01T06:40:00.000Z', unread: true,
  };
  const codeSms: ThreadMessage = {
    id: 'code-sms', simId: 'sim-a', direction: 'incoming', remoteNumber: '10690000',
    body: '您的验证码是 482913，5 分钟内有效。', state: 'received', createdAt: '2026-10-01T06:41:00.000Z', unread: true,
  };
  const reads: string[][] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(Messages, {
        messages: [older, codeSms], simId: 'sim-a', simLabel: '号码 A', online: true, busy: false, timeZone: 'UTC',
        account: 'copy-code-test', onSend: async () => {}, onReadIncoming: (ids: string[]) => { reads.push(ids); },
      }));
    });
    const copy = renderer!.root.findAll(node => node.type === 'button' && node.props.className === 'code-copy')[0]!;
    await act(async () => { copy.props.onClick(); });
    assert.deepEqual(reads, [['code-sms']]);
    // The older message is still unread, so the dot stays; only the copied message was marked.
    const dot = () => renderer!.root.findAll(node => node.type === 'span' && String(node.props.className || '').includes('thread-unread-dot'))[0]!;
    assert.equal(dot().props['data-on'], true);
    await act(async () => { copy.props.onClick(); });
    assert.deepEqual(reads, [['code-sms']], 'a second copy does not resend');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
  }
});

test('S97: copying the code clears the row dot when it was the only unread message', async () => {
  const {Messages} = await loadMessages();
  const codeSms: ThreadMessage = {
    id: 'only-code', simId: 'sim-a', direction: 'incoming', remoteNumber: '10690001',
    body: '验证码 7731，请勿泄露。', state: 'received', createdAt: '2026-10-01T06:41:00.000Z', unread: true,
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(Messages, {
        messages: [codeSms], simId: 'sim-a', simLabel: '号码 A', online: true, busy: false, timeZone: 'UTC',
        account: 'copy-code-dot-test', onSend: async () => {}, onReadIncoming: () => {},
      }));
    });
    const dot = () => renderer!.root.findAll(node => node.type === 'span' && String(node.props.className || '').includes('thread-unread-dot'))[0]!;
    assert.equal(dot().props['data-on'], true);
    const copy = renderer!.root.findAll(node => node.type === 'button' && node.props.className === 'code-copy')[0]!;
    await act(async () => { copy.props.onClick(); });
    assert.equal(dot().props['data-on'], undefined);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
  }
});
