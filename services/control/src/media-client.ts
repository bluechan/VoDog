import { createHmac, randomBytes } from 'node:crypto';

export type MediaTransport = 'udp' | 'tls';
export type MediaBridgeClientOptions = { controlBaseUrl?: string; turnUdpUrl?: string; turnTlsUrl?: string };

/** Internal bridge connector. Every destination comes from startup configuration. */
export class MediaBridgeClient {
  private readonly controlBaseUrl: string;
  private readonly turnUdpUrl: string;
  private readonly turnTlsUrl: string;
  constructor(private readonly secret: string, private readonly turnSecret: string, options: MediaBridgeClientOptions = {}) {
    if (secret.length < 32 || turnSecret.length < 32) throw new Error('Media secrets are not configured');
    this.controlBaseUrl = validatedControlBaseUrl(options.controlBaseUrl ?? 'http://127.0.0.1:16881');
    this.turnUdpUrl = validatedTurnUrl(options.turnUdpUrl ?? 'turn:relay-secondary.example.com:16801?transport=udp', 'udp');
    this.turnTlsUrl = validatedTurnUrl(options.turnTlsUrl ?? 'turns:relay-secondary.example.com:16802?transport=tcp', 'tls');
  }
  private grant(callId: string, role: 'client' | 'gateway', mediaEpoch: number, replace: boolean): string {
    assertCallId(callId);
    if (!Number.isSafeInteger(mediaEpoch) || mediaEpoch < 1) throw new Error('Invalid media epoch');
    const body = Buffer.from(JSON.stringify({callId,role,mediaEpoch,exp:Math.floor(Date.now()/1000)+30,nonce:randomBytes(24).toString('base64url'),...(replace?{replace:true}:{})})).toString('base64url');
    return body+'.'+createHmac('sha256',this.secret).update(body).digest('base64url');
  }
  iceServers(transport: MediaTransport = 'udp') {
    const username = `${Math.floor(Date.now()/1000)+3600}:vodog-${randomBytes(8).toString('hex')}`;
    return [{urls:[transport === 'tls' ? this.turnTlsUrl : this.turnUdpUrl],username,credential:createHmac('sha1',this.turnSecret).update(username).digest('base64')}];
  }
  /** S75c: `replace` only for the leg's owner — the bridge then replaces the role's leg even if it still looks Connected. */
  async offer(callId: string, role: 'client' | 'gateway', offer: {type:'offer';sdp:string}, mediaEpoch = 1, replace = false) {
    if (offer.type !== 'offer' || Buffer.byteLength(offer.sdp)>120*1024) throw new Error('Invalid media offer');
    // Every attempt carries a fresh single-use grant.
    const send = () => fetch(`${this.controlBaseUrl}/offer`, {method:'POST',headers:{Authorization:'Bearer '+this.grant(callId,role,mediaEpoch,replace),'Content-Type':'application/json'},body:JSON.stringify(offer),signal:AbortSignal.timeout(15000),redirect:'error'});
    let response: Response;
    try { response = await send(); }
    catch (error) {
      // One resend after a connection-level failure (a reset keep-alive socket, a refused connect),
      // only for a replacing leg: the bridge swaps that role's leg anyway (S75c). Never after an HTTP
      // answer or a timeout, and never for the AI leg, which stays single-attempt (S22).
      if (!replace || !isConnectionError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, OFFER_RETRY_DELAY_MS));
      response = await send();
    }
    if (!response.ok) throw new MediaBridgeError(response.status);
    const answer = await response.json() as {type:string;sdp:string};
    if(answer.type!=='answer'||typeof answer.sdp!=='string'||answer.sdp.length>128*1024)throw new Error('Invalid bridge answer');
    return answer as {type:'answer';sdp:string};
  }
  async close(callId:string, mediaEpoch = 1) {
    assertCallId(callId);
    if (!Number.isSafeInteger(mediaEpoch) || mediaEpoch < 1) throw new Error('Invalid media epoch');
    const response=await fetch(`${this.controlBaseUrl}/close/${callId}`,{method:'POST',headers:{Authorization:'Bearer '+this.secret,'X-Media-Epoch':String(mediaEpoch)},signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw new MediaBridgeError(response.status);
  }
}
const OFFER_RETRY_DELAY_MS = 150;
const CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
/** fetch reports network failures as `TypeError('fetch failed')` with the socket error as `cause`; a timeout is a DOMException and never matches. */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as { cause?: { code?: unknown; errors?: { code?: unknown }[] } }).cause;
  const codes = [cause?.code, ...(Array.isArray(cause?.errors) ? cause.errors.map(item => item?.code) : [])];
  return codes.some(code => typeof code === 'string' && CONNECTION_ERROR_CODES.has(code));
}
export class MediaBridgeError extends Error { constructor(public readonly status:number){super('Media bridge request failed');} }
export function validatedControlBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) throw new Error('Media node URL must be an origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isAllowedPlainHttpHost(url.hostname))) throw new Error('Media node URL requires trusted HTTPS or an explicit loopback/Tailscale address');
  return url.origin;
}
function isAllowedPlainHttpHost(host: string) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}
function validatedTurnUrl(value: string, transport: MediaTransport) {
  const expected = transport === 'tls' ? /^turns:[A-Za-z0-9.-]+:\d+\?transport=tcp$/ : /^turn:[A-Za-z0-9.-]+:\d+\?transport=udp$/;
  if (!expected.test(value)) throw new Error(`Invalid ${transport} TURN URL`);
  return value;
}
function assertCallId(callId: string) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(callId)) throw new Error('Invalid call ID');
}
