/**
 * S132 admin 网关 page — pure view logic.
 *
 * Management data comes from `/admin/gateways` + `/admin/sims`; live state (在线 / 待命中 / 通话中, remote power)
 * comes from `/gateways/power` and is joined here by gateway id. `power === null` means that read is unsupported or
 * has not succeeded yet: cards then say 「状态未知」 and offer no switch.
 */
import {gatewayPowerStatus, gatewayPowerToggle, type GatewayPowerDto, type GatewayPowerToggle} from './gateway-power';
import {simTail} from './shell';

export type AdminGateway = {id: string; name: string; controlEnabled: boolean; telephonyReady: boolean; smsReady: boolean; mediaReady: boolean; lastSeenAt?: string; deviceEpoch?: number; timeZone?: string | null; kind?: string | null; moduleLabel?: string | null};
export type AdminSim = {id: string; gatewayId: string; slotIndex: number | null; label: string; phoneLabel?: string; present?: boolean; ownerUserId: string | null; version: number; assignmentPending: boolean};
export type AdminUser = {id: string; username: string};
/** Unsaved 分配给 choice, bound to the SIM version it was made against. */
export type OwnerDraft = {value: string; version: number};
export type OwnerDrafts = Record<string, OwnerDraft>;

export type CardTone = 'online' | 'call' | 'standby' | 'offline' | 'unknown';
export type CardStatus = {tone: CardTone; shape: 'online' | 'pending' | 'offline'; text: string};

export function gatewayCardStatus(power: GatewayPowerDto | undefined): CardStatus {
  if (!power) return {tone: 'unknown', shape: 'offline', text: '状态未知'};
  const status = gatewayPowerStatus(power);
  if (status === 'online') return power.occupied ? {tone: 'call', shape: 'online', text: '在线 · 通话中'} : {tone: 'online', shape: 'online', text: '在线'};
  if (status === 'standby') return {tone: 'standby', shape: 'pending', text: '待命中'};
  return {tone: 'offline', shape: 'offline', text: '离线'};
}

export type GatewayCardView = {
  gateway: AdminGateway;
  isDji: boolean;
  status: CardStatus;
  /** Present only when the power row exists; the 网关总控 switch is hidden otherwise. */
  power?: GatewayPowerDto;
  toggle?: GatewayPowerToggle;
  /** 生成配对码 is the solid primary only when the gateway is offline / unknown / never seen. */
  sims: AdminSim[];
};

export function powerById(power: GatewayPowerDto[] | null): Map<string, GatewayPowerDto> {
  return new Map((power || []).map(item => [item.gatewayId, item]));
}

export function gatewayCards(gateways: AdminGateway[], sims: AdminSim[], power: GatewayPowerDto[] | null, now = Date.now()): GatewayCardView[] {
  const byId = powerById(power);
  return gateways.map(gateway => {
    const row = byId.get(gateway.id);
    const status = gatewayCardStatus(row);
    return {
      gateway,
      isDji: gateway.kind === 'dji4g',
      status,
      power: row,
      toggle: row ? gatewayPowerToggle(row, now) : undefined,
      sims: sims.filter(s => s.gatewayId === gateway.id).sort((a, b) => (a.slotIndex ?? 99) - (b.slotIndex ?? 99) || (a.id < b.id ? -1 : 1)),
    };
  });
}

/** SIMs whose gateway is not in the list (kept visible so nothing silently disappears from 分配). */
export function orphanSims(gateways: AdminGateway[], sims: AdminSim[]): AdminSim[] {
  const ids = new Set(gateways.map(g => g.id));
  return sims.filter(s => !ids.has(s.gatewayId));
}

/** 「N 个网关 · X 在线 · Y 待命 · Z 张卡待分配 · W 张卡需确认」; zero optional parts and unknown power counts are left out. */
export function adminSummary(gateways: AdminGateway[], sims: AdminSim[], power: GatewayPowerDto[] | null): string {
  if (!gateways.length) return '还没有网关';
  const parts = [`${gateways.length} 个网关`];
  if (power) {
    const byId = powerById(power);
    const states = gateways.map(g => byId.get(g.id)).filter((p): p is GatewayPowerDto => Boolean(p)).map(gatewayPowerStatus);
    parts.push(`${states.filter(s => s === 'online').length} 在线`);
    const standby = states.filter(s => s === 'standby').length;
    if (standby) parts.push(`${standby} 待命`);
  }
  const unassigned = sims.filter(s => !s.ownerUserId).length;
  const pending = sims.filter(s => s.assignmentPending).length;
  if (unassigned) parts.push(`${unassigned} 张卡待分配`);
  if (pending) parts.push(`${pending} 张卡需确认`);
  return parts.join(' · ');
}

/** 「刚刚 / 2 分钟前 / 1 小时 30 分钟前 / 3 天前」. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** Pairing countdown: 「剩余 9:05」 or the expired hint. */
export function pairingRemaining(expiresAt: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(expiresAt) - now) / 1000);
  if (!(seconds > 0)) return '已过期，请重新生成';
  return `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export type GatewayMenuItem = 'rename' | 'replace' | 'delete';
/** Pixel (or a missing kind) has no module, so 更换模组配对码 is DJI-only. */
export function gatewayMenuItems(kind?: string | null): GatewayMenuItem[] {
  return kind === 'dji4g' ? ['rename', 'replace', 'delete'] : ['rename', 'delete'];
}

export type SimRowView = {
  sim: AdminSim;
  /** Title: the SIM's name, then its number. */
  title: string;
  /** Accessible name source kept from the pre-S132 page: 「保存分配 {ariaName}」. */
  ariaName: string;
  tail?: string;
  value: string;
  dirty: boolean;
  pending: boolean;
  unassigned: boolean;
  /** 保存 only appears when there is something to send (a change, or a pending re-confirmation). */
  canSave: boolean;
};

export function simRowView(sim: AdminSim, drafts: OwnerDrafts): SimRowView {
  const saved = sim.ownerUserId || '';
  const draft = drafts[sim.id];
  const value = draft && draft.version === sim.version ? draft.value : saved;
  const dirty = value !== saved;
  return {
    sim,
    title: sim.label || sim.phoneLabel || '未命名号码',
    ariaName: sim.phoneLabel || sim.label || '未命名号码',
    tail: simTail(sim),
    value,
    dirty,
    pending: sim.assignmentPending,
    unassigned: !saved && !dirty,
    canSave: dirty || sim.assignmentPending,
  };
}

/** After a refresh: keep drafts whose SIM still exists at the same version; a changed version discards that row's draft only. */
export function reconcileDrafts(drafts: OwnerDrafts, sims: AdminSim[]): OwnerDrafts {
  const versions = new Map(sims.map(s => [s.id, s.version]));
  const next: OwnerDrafts = {};
  for (const [id, draft] of Object.entries(drafts)) if (versions.get(id) === draft.version) next[id] = draft;
  return next;
}
