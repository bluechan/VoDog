import { createHmac, randomBytes } from 'node:crypto';

/**
 * Control → media node request signature, HMAC-SHA256 with the node's media secret over
 * `{METHOD}\n{path}\n{timestamp}\n{nonce}\n{Range}`. Shared with `services/media`
 * `recordingCanonicalString` (recording reads/deletes and `/close/`) and `infra/retention.py`
 * `recording_delete_canonical`. The method is signed, so a GET signature can never authorize a DELETE
 * or a POST; the Range line is always present and is empty for every request without a Range header.
 * The media secret itself is never sent.
 */
export function signedMediaRequestHeaders(secret: string, method: 'GET' | 'DELETE' | 'POST', path: string, range = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString(), nonce = randomBytes(18).toString('base64url');
  const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${range}`;
  return {'X-CC-Timestamp': timestamp, 'X-CC-Nonce': nonce, 'X-CC-Signature': createHmac('sha256', secret).update(canonical).digest('base64url'), ...(range ? {Range: range} : {})};
}
