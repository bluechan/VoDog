/** Poll cadence while a call of this account is still being set up (S20 D5). */
export const SETTLING_DASHBOARD_REFRESH_MS = 1000;
/** Poll cadence when nothing is being set up: idle, talking, or only finished calls. */
export const IDLE_DASHBOARD_REFRESH_MS = 2000;
/**
 * Non-terminal, non-`active` call states: dialing, ringing, being answered, ending, or still connecting media.
 * `active` stays on the slow cadence because a talking call changes nothing until it ends, and `unknown`
 * is excluded on purpose so one unresolved record cannot pin the dashboard to the fast cadence forever.
 */
const SETTLING_CALL_STATES = ['outgoing_pending', 'incoming_ringing', 'connecting', 'ending'];

/**
 * Refresh interval for the dashboard poll loop.
 *
 * `/calls` is already filtered to this account, so every settling call in the list is one this user is waiting on.
 */
export function dashboardRefreshIntervalMs(calls: readonly {state: string}[]): number {
  return calls.some(call => SETTLING_CALL_STATES.includes(call.state))
    ? SETTLING_DASHBOARD_REFRESH_MS
    : IDLE_DASHBOARD_REFRESH_MS;
}

/** S32：短信与角标的独立刷新节奏（前台每 5 s 内发起一次）；通话与 SIM 仍走 1 s / 2 s。 */
export const MESSAGES_REFRESH_MS = 5000;

export type DashboardRefreshSources<S, C, M> = {
  epoch: () => number;
  loadSims: () => Promise<S>;
  loadCalls: () => Promise<C>;
  loadMessages: () => Promise<M>;
  applySims: (value: S) => void;
  applyCalls: (value: C) => void;
  applyMessages: (value: M) => void;
};

type Resource = 'sims' | 'calls' | 'messages';
/**
 * Resources whose apply is skipped while the JSON body is unchanged. Sims always apply: every read advances the
 * S80 settings-freshness observation and restores the SIM load status.
 */
const SKIP_UNCHANGED: ReadonlySet<Resource> = new Set(['calls', 'messages']);

/** One coalescing refresh queue over a fixed set of resources. */
class Lane {
  sequence = 0;
  queued = false;
  inFlight: Promise<boolean> | null = null;
  readonly resources: readonly Resource[];
  constructor(resources: readonly Resource[]) { this.resources = resources; }
}

/**
 * Applies successful dashboard resources independently and coalesces refresh bursts.
 *
 * `request()` reads all three resources (actions, focus, reconnect). The poll uses `requestLive()` (sims + calls)
 * and `requestMessages()` on separate timers, so a slow SMS paging read never delays the next `/calls` poll.
 * An older response never overwrites a newer one of the same resource, whichever queue loaded it.
 */
export class DashboardRefreshCoordinator<S, C, M> {
  private readonly sources: DashboardRefreshSources<S, C, M>;
  private readonly all = new Lane(['sims', 'calls', 'messages']);
  private readonly live = new Lane(['sims', 'calls']);
  private readonly messages = new Lane(['messages']);
  private readonly started: Record<Resource, number> = {sims: 0, calls: 0, messages: 0};
  private readonly applied: Record<Resource, number> = {sims: 0, calls: 0, messages: 0};
  private readonly signatures = new Map<Resource, string>();

  constructor(sources: DashboardRefreshSources<S, C, M>) { this.sources = sources; }

  invalidate() {
    for (const lane of [this.all, this.live, this.messages]) {
      lane.sequence++;
      lane.queued = false;
    }
    this.signatures.clear();
  }

  request(): Promise<boolean> { return this.enqueue(this.all); }
  requestLive(): Promise<boolean> { return this.enqueue(this.live); }
  requestMessages(): Promise<boolean> { return this.enqueue(this.messages); }

  private enqueue(lane: Lane): Promise<boolean> {
    if (lane.inFlight) {
      lane.queued = true;
      return lane.inFlight;
    }
    const operation = this.drain(lane);
    const tracked = operation.finally(() => {
      if (lane.inFlight === tracked) lane.inFlight = null;
    });
    lane.inFlight = tracked;
    return tracked;
  }

  private async drain(lane: Lane): Promise<boolean> {
    let applied = false;
    let lastError: unknown;
    do {
      lane.queued = false;
      try {
        applied = (await this.once(lane)) || applied;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
    } while (lane.queued);
    if (lastError !== undefined) throw lastError;
    return applied;
  }

  private load(resource: Resource): Promise<unknown> {
    return resource === 'sims' ? this.sources.loadSims() : resource === 'calls' ? this.sources.loadCalls() : this.sources.loadMessages();
  }

  private commit(resource: Resource, value: unknown) {
    if (resource === 'sims') this.sources.applySims(value as S);
    else if (resource === 'calls') this.sources.applyCalls(value as C);
    else this.sources.applyMessages(value as M);
  }

  private async once(lane: Lane): Promise<boolean> {
    const epoch = this.sources.epoch();
    const sequence = ++lane.sequence;
    const current = () => epoch === this.sources.epoch() && sequence === lane.sequence;
    const apply = async (resource: Resource) => {
      const ticket = ++this.started[resource];
      let value: unknown;
      try {
        value = await this.load(resource);
      } catch (error) {
        if (current()) this.signatures.delete(resource);
        throw error;
      }
      if (!current() || ticket < this.applied[resource]) return false;
      this.applied[resource] = ticket;
      if (SKIP_UNCHANGED.has(resource)) {
        const signature = JSON.stringify(value);
        if (signature === this.signatures.get(resource)) return true;
        this.signatures.set(resource, signature);
      }
      this.commit(resource, value);
      return true;
    };
    const results = await Promise.allSettled(lane.resources.map(apply));
    if (epoch !== this.sources.epoch() || sequence !== lane.sequence) return false;
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return results.some(result => result.status === 'fulfilled' && result.value);
  }
}
