import {createHash} from 'node:crypto';

export const AUTH_ATTEMPT_LIMIT = 5;
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60_000;

export type AuthFailType = 'password' | 'passkey';

export function usernameHashForLog(username: string): string {
  return createHash('sha256').update(username.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function sanitizeClientIp(ip: string | undefined): string {
  const value = (ip ?? '').trim();
  if (value.length >= 3 && value.length <= 64 && /^[0-9a-fA-F:.]+$/.test(value)) return value;
  return 'unknown';
}

export function crowdsecAuthFailLine(input: {
  ip?: string;
  type: AuthFailType;
  username?: string;
}): string {
  const ip = sanitizeClientIp(input.ip);
  const usernameHash = input.username ? usernameHashForLog(input.username) : 'none';
  return `crowdsec_auth_fail service=vodog-auth type=${input.type} ip=${ip} username_hash=${usernameHash}\n`;
}

export function emitCrowdsecAuthFail(
  input: {ip?: string; type: AuthFailType; username?: string},
  write: (chunk: string) => void = (chunk) => process.stderr.write(chunk),
): void {
  write(crowdsecAuthFailLine(input));
}

export class AuthAttemptLimiter {
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly attempts = new Map<string, {count: number; reset: number}>(),
    private readonly now = () => Date.now(),
    private readonly limit = AUTH_ATTEMPT_LIMIT,
    private readonly windowMs = AUTH_ATTEMPT_WINDOW_MS,
  ) {}

  key(ip: string | undefined, username: string): string {
    return `${sanitizeClientIp(ip)}:${username.trim().toLowerCase()}`;
  }

  blocked(ip: string | undefined, username: string): boolean {
    const now = this.now();
    this.sweep(now);
    const bucket = this.attempts.get(this.key(ip, username));
    return !!bucket && bucket.reset > now && bucket.count >= this.limit;
  }

  recordFailure(ip: string | undefined, username: string): number {
    const key = this.key(ip, username);
    const now = this.now();
    this.sweep(now);
    const current = this.attempts.get(key);
    const bucket = current && current.reset > now ? current : {count: 0, reset: now + this.windowMs};
    bucket.count++;
    this.attempts.set(key, bucket);
    return bucket.count;
  }

  clear(ip: string | undefined, username: string): void {
    this.attempts.delete(this.key(ip, username));
  }

  /** Drops expired buckets at most once per window, so failed attempts cannot grow the map forever. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.attempts) if (bucket.reset <= now) this.attempts.delete(key);
  }
}
