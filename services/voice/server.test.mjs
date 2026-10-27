import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFactory } from './server.mjs';
import { LEAVE_MESSAGE_GREETING, greetingFor } from './providers/index.mjs';

test('S137: greetingFor maps leave_message per provider and nothing else', () => {
  assert.equal(greetingFor('doubao', 'leave_message'), '不好意思，机主在忙。我是 VoDog AI 助理，请您留言，谢谢');
  assert.equal(greetingFor('xai', 'leave_message'), `请只说这一句话：${LEAVE_MESSAGE_GREETING}`);
  assert.equal(greetingFor('doubao', undefined), undefined);
  assert.equal(greetingFor('xai', 'other'), undefined);
  assert.equal(greetingFor('nobody', 'leave_message'), undefined);
});
test('S137: agentFactory overrides greeting only for leave_message and passes the config untouched otherwise', () => {
  const doubao = { greeting: 'default-d', voice: 'v' }, xai = { greeting: 'default-x' };
  const built = [];
  const create = agentFactory(new Map([['doubao', doubao], ['xai', xai]]), { create: options => { built.push(options); return options; } });
  create({ provider: 'doubao', greetingKind: 'leave_message' });
  create({ provider: 'xai', greetingKind: 'leave_message' });
  create({ provider: 'doubao' });
  assert.deepEqual(built[0], { provider: 'doubao', config: { greeting: LEAVE_MESSAGE_GREETING, voice: 'v' } });
  assert.equal(built[1].config.greeting, `请只说这一句话：${LEAVE_MESSAGE_GREETING}`);
  assert.equal(built[2].config, doubao);
  assert.equal(doubao.greeting, 'default-d', 'the shared startup config is never mutated');
  assert.throws(() => create({ provider: 'missing' }), error => error.code === 'provider_unavailable');
});
