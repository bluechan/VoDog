import assert from 'node:assert/strict';
import test from 'node:test';
import {hashPassword, verifyPasswordOrDecoy} from '../src/security.js';

test('verifyPasswordOrDecoy accepts only the right password and never an unknown or unusable account', async () => {
  const encoded = await hashPassword('correct horse');
  assert.equal(await verifyPasswordOrDecoy('correct horse', encoded), true);
  assert.equal(await verifyPasswordOrDecoy('wrong', encoded), false);
  // Unknown username, passkey-only account, malformed hash: all run the decoy and fail.
  for (const missing of [undefined, null, '', 'not-a-hash', 'scrypt$1$2']) {
    assert.equal(await verifyPasswordOrDecoy('correct horse', missing), false, String(missing));
  }
});
