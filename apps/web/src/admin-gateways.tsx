import React, {useEffect, useRef, useState, type KeyboardEvent} from 'react';
import {UiIcon} from './icons';
import {StatusShape, simColorStyle} from './sim-chip';
import {simPaletteColor} from './sim-palette';
import {ConfirmAction} from './confirm-action';
import {GATEWAY_DELETE_PROMPT, GATEWAY_REPLACE_MODULE_PROMPT} from './confirm-copy';
import {formatCompactCallDate, formatCompactClock, gatewayDisplayTimeZone} from './gateway-time';
import {gatewayKindLabel, gatewayModuleText, gatewayNameError, gatewayRenameErrorText, gatewayTag} from './gateway-kind';
import {gatewayPowerErrorMessage, gatewayPowerOffPrompt, gatewayPowerUnsupported, lastPowerResultText, type GatewayPowerDto} from './gateway-power';
import {errorCode} from './media-policy';
import {useReportedError} from './ui-error';
import {useVisibleRefresh} from './visible-refresh';
import type {ApiRequest} from './contacts';
import {
  adminSummary, gatewayCards, gatewayMenuItems, orphanSims, pairingRemaining, reconcileDrafts, relativeTime, simRowView,
  type AdminGateway, type AdminSim, type AdminUser, type GatewayCardView, type OwnerDrafts,
} from './admin-gateways-model';

/**
 * S132 管理员「网关」页：one card per gateway with its SIMs, live status and the 网关总控 switch.
 * `AdminGatewaysView` is stateless (SSR-tested); `AdminGateways` owns fetching, polling and mutations.
 */
export type GatewayPanel =
  | {type: 'pair'; code: string; expiresAt: string; timeZone: string; replaceModule: boolean}
  | {type: 'replace' | 'delete' | 'off'};
export type PageError = {title: string; text: string};
export type ViewState = {
  gateways: AdminGateway[] | null;
  sims: AdminSim[];
  users: AdminUser[];
  power: GatewayPowerDto[] | null;
  error: PageError | null;
  busy: boolean;
  menu: string | null;
  panels: Record<string, GatewayPanel>;
  rename: {id: string; value: string; error: string} | null;
  drafts: OwnerDrafts;
  adding: {value: string; error: string} | null;
  notice: string;
  now: number;
};
export type ViewHandlers = {
  retry: () => void;
  openAdd: () => void;
  cancelAdd: () => void;
  addInput: (value: string) => void;
  submitAdd: () => void;
  toggleMenu: (id: string) => void;
  closeMenu: (id: string) => void;
  startRename: (g: AdminGateway) => void;
  renameInput: (value: string) => void;
  cancelRename: (id: string) => void;
  saveRename: (g: AdminGateway) => void;
  pair: (g: AdminGateway) => void;
  openPanel: (id: string, type: 'replace' | 'delete' | 'off') => void;
  closePanel: (id: string) => void;
  confirmReplace: (g: AdminGateway) => void;
  confirmDelete: (g: AdminGateway) => void;
  power: (card: GatewayCardView) => void;
  confirmOff: (card: GatewayCardView) => void;
  copy: (text: string) => void;
  draft: (sim: AdminSim, value: string) => void;
  undo: (sim: AdminSim) => void;
  saveOwner: (sim: AdminSim, value: string) => void;
};

const noop = () => {};
const ids = {
  menu: (id: string) => `gw-menu-${id}`,
  menuList: (id: string) => `gw-menulist-${id}`,
  pair: (id: string) => `gw-pair-${id}`,
  power: (id: string) => `gw-power-${id}`,
  panel: (id: string) => `gw-panel-${id}`,
  name: (id: string) => `gw-name-${id}`,
  rename: (id: string) => `gw-rename-${id}`,
};

function Steps({done}: {done: number}) {
  return <ol className="gw-steps">{['添加网关', '生成配对码', '在网关设备输入'].map((text, i) => <li key={text} className={i < done ? 'done' : undefined}><span className="gw-step-n" aria-hidden="true">{i < done ? '✓' : i + 1}</span>{text}{i < done && <span className="sr-only">（已完成）</span>}</li>)}</ol>;
}

function PairPanel({card, panel, now, on}: {card: GatewayCardView; panel: Extract<GatewayPanel, {type: 'pair'}>; now: number; on: Partial<ViewHandlers>}) {
  const g = card.gateway;
  return <section className="gw-inline" role="status" aria-labelledby={ids.panel(g.id)}>
    <h3 id={ids.panel(g.id)} tabIndex={-1}>{panel.replaceModule ? '更换模组配对码' : '配对码'}</h3>
    <p>在网关设备上输入此配对码</p>
    <div className="gw-code-row">
      <code className="gw-code" aria-label={`配对码 ${panel.code.split('').join(' ')}`}>{panel.code}</code>
      <button type="button" className="gw-btn" onClick={() => on.copy?.(panel.code)}><UiIcon name="copy" size={18}/>复制</button>
    </div>
    <p className="gateway-module">{g.name} · {gatewayModuleText(g.moduleLabel)}{panel.replaceModule ? ' · 更换模组' : ''}</p>
    <p className="num">有效至 {formatCompactClock(panel.expiresAt, panel.timeZone)}，只能使用一次。 · {pairingRemaining(panel.expiresAt, now)}</p>
    <div className="gw-acts"><button type="button" className="gw-btn" onClick={() => on.closePanel?.(g.id)}>隐藏配对码</button></div>
  </section>;
}

function GatewayCard({card, state, on}: {card: GatewayCardView; state: ViewState; on: Partial<ViewHandlers>}) {
  const g = card.gateway, panel = state.panels[g.id], renaming = state.rename?.id === g.id ? state.rename : null;
  const menuOpen = state.menu === g.id, busy = state.busy, zone = gatewayDisplayTimeZone(g.timeZone);
  const kind = gatewayKindLabel(g.kind);
  const kindText = card.isDji || g.moduleLabel ? `${kind.device} · ${gatewayModuleText(g.moduleLabel)}` : kind.device;
  const allSims = state.sims;
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (menuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      event.preventDefault();
      return;
    }
    if (event.key !== 'Escape') return;
    if (menuOpen) on.closeMenu?.(g.id);
    else if (renaming) on.cancelRename?.(g.id);
    else if (panel) on.closePanel?.(g.id);
    else return;
    event.stopPropagation();
  }
  return <article className="gw-card" aria-labelledby={renaming ? undefined : ids.name(g.id)} aria-label={renaming ? g.name : undefined} onKeyDown={onKeyDown}>
    <div className="gw-head-row">
      <div className="gw-kind" aria-hidden="true"><UiIcon name={card.isDji ? 'module' : 'gateways'} size={22}/></div>
      <div className="gw-title">
        {renaming ? <form className="gw-rename" noValidate onSubmit={e => { e.preventDefault(); on.saveRename?.(g); }}>
          <label className="sr-only" htmlFor={ids.rename(g.id)}>网关名称</label>
          <input id={ids.rename(g.id)} value={renaming.value} maxLength={120} required autoFocus disabled={busy} aria-invalid={renaming.error ? true : undefined} onChange={e => on.renameInput?.(e.target.value)}/>
          {renaming.error && <p className="gw-err" role="alert">{renaming.error}</p>}
          <div className="gw-acts"><button className="gw-btn primary-fill" disabled={busy}>保存</button><button type="button" className="gw-btn" disabled={busy} onClick={() => on.cancelRename?.(g.id)}>取消</button></div>
        </form> : <h2 id={ids.name(g.id)}>{g.name}</h2>}
        {!renaming && <p className="gw-sub">{kindText} · {g.lastSeenAt ? <>最近联络 <time dateTime={g.lastSeenAt} title={formatCompactCallDate(g.lastSeenAt, zone)}>{relativeTime(g.lastSeenAt, state.now)}</time></> : '尚未联络'}</p>}
      </div>
      <div className="gw-side">
        <span className={`gw-pill ${card.status.tone}`}><StatusShape status={card.status.shape}/>{card.status.text}</span>
        <div className="gw-menu-wrap">
          <button type="button" id={ids.menu(g.id)} className="gw-icon-btn" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? ids.menuList(g.id) : undefined} aria-label={`更多操作 ${g.name}`} disabled={busy} onClick={() => on.toggleMenu?.(g.id)}><UiIcon name="more"/></button>
          {menuOpen && <div className="gw-menu" role="menu" id={ids.menuList(g.id)} aria-label={`${g.name} 的操作`}>
            {gatewayMenuItems(g.kind).map(item => item === 'rename'
              ? <button key={item} type="button" role="menuitem" aria-label={`重命名网关 ${g.name}`} onClick={() => on.startRename?.(g)}>重命名</button>
              : item === 'replace'
                ? <button key={item} type="button" role="menuitem" aria-label={`更换模组配对码 ${g.name}`} onClick={() => on.openPanel?.(g.id, 'replace')}>更换模组配对码</button>
                : <React.Fragment key={item}><hr/><button type="button" role="menuitem" className="gw-del" aria-label={`删除网关 ${g.name}`} onClick={() => on.openPanel?.(g.id, 'delete')}>删除网关</button></React.Fragment>)}
          </div>}
        </div>
      </div>
    </div>
    <div className="gw-row2">
      <div className="gw-caps">
        <span className={`gw-cap ${g.telephonyReady && g.mediaReady ? 'ok' : 'no'}`}>{g.telephonyReady && g.mediaReady ? '✓ 通话就绪' : '✕ 通话未就绪'}</span>
        <span className={`gw-cap ${g.smsReady ? 'ok' : 'no'}`}>{g.smsReady ? '✓ 短信就绪' : '✕ 短信未就绪'}</span>
        {!card.power && <span className={`gw-cap ${g.controlEnabled ? 'ok' : 'no'}`}>{g.controlEnabled ? '✓ 总控已开启' : '✕ 总控未开启'}</span>}
      </div>
      <button type="button" id={ids.pair(g.id)} className="gw-btn soft" aria-label={`生成配对码 ${g.name}`} disabled={busy} onClick={() => on.pair?.(g)}><UiIcon name="key" size={18}/>生成配对码</button>
    </div>
    {card.power && card.toggle && <div className="gw-power">
      <div><b>网关总控</b><small id={`gw-power-hint-${g.id}`}>{card.toggle.hint}</small>{lastPowerResultText(card.power.lastPowerResult) && <small>{lastPowerResultText(card.power.lastPowerResult)}</small>}</div>
      <button type="button" id={ids.power(g.id)} className="gw-switch" role="switch" aria-checked={card.toggle.checked} aria-label={`网关总控 ${g.name}`} aria-describedby={`gw-power-hint-${g.id}`} disabled={busy || card.toggle.disabled} onClick={() => on.power?.(card)}/>
    </div>}
    {panel?.type === 'pair' && <PairPanel card={card} panel={panel} now={state.now} on={on}/>}
    {panel && panel.type !== 'pair' && <div className="gw-confirm">
      <ConfirmAction busy={busy}
        prompt={panel.type === 'delete' ? GATEWAY_DELETE_PROMPT : panel.type === 'replace' ? GATEWAY_REPLACE_MODULE_PROMPT : gatewayPowerOffPrompt(g.name)}
        confirmLabel={panel.type === 'delete' ? '确认删除' : panel.type === 'replace' ? '确认生成' : '确认关闭'}
        onConfirm={() => panel.type === 'delete' ? on.confirmDelete?.(g) : panel.type === 'replace' ? on.confirmReplace?.(g) : on.confirmOff?.(card)}
        onCancel={() => on.closePanel?.(g.id)}/>
    </div>}
    {card.sims.length ? <SimList label={`${g.name} 的号码`} sims={card.sims} allSims={allSims} state={state} on={on}/>
      : <div className="gw-nosim"><b>尚未收到 SIM 信息</b>先在网关设备上完成配对并授予电话状态权限。{!g.lastSeenAt && <Steps done={1}/>}</div>}
    <details className="gw-more">
      <summary>详情</summary>
      <dl>
        <dt>设备标签</dt><dd><code className="gateway-tag">{gatewayTag(g.id, g.kind)}</code><button type="button" className="gw-link" aria-label="复制设备标签" onClick={() => on.copy?.(gatewayTag(g.id, g.kind))}><UiIcon name="copy" size={16}/>复制</button></dd>
        {card.isDji && <><dt>模组</dt><dd>{gatewayModuleText(g.moduleLabel)}</dd></>}
        <dt>最近联络</dt><dd className="num">{g.lastSeenAt ? formatCompactCallDate(g.lastSeenAt, zone) : '尚未连接'}</dd>
        <dt>时区</dt><dd>{zone}</dd>
        <dt>连接代次</dt><dd className="num">{g.deviceEpoch ?? 0}</dd>
      </dl>
    </details>
  </article>;
}

function SimList({label, sims, allSims, state, on}: {label: string; sims: AdminSim[]; allSims: AdminSim[]; state: ViewState; on: Partial<ViewHandlers>}) {
  return <>
    <div className="gw-sims-h" aria-hidden="true"><span>号码 · 状态</span><span>分配给</span><span/></div>
    <ul className="gw-sims" aria-label={label}>{sims.map(sim => {
      const row = simRowView(sim, state.drafts);
      return <li className="gw-sim" key={sim.id}>
        <div className="gw-sim-name">
          <span className="sim-swatch" style={simColorStyle(simPaletteColor(sim, allSims))} aria-hidden="true"/>
          <div>
            <div className="gw-sim-t"><b>{row.title}</b>{row.tail && <> · <span className="muted num">尾号 {row.tail}</span></>}</div>
            <div className="gw-sim-st"><StatusShape status={sim.present === false ? 'offline' : 'online'}/>{sim.present === false ? '未待机，保留归属及历史' : '当前已识别'}</div>
            {(row.unassigned || row.pending) && <div className="gw-chips">
              {row.unassigned && <span className="gw-chip plain">待分配</span>}
              {row.pending && <span className="gw-chip warn"><UiIcon name="warning" size={14}/>卡片已变化，需要重新确认账号。</span>}
            </div>}
          </div>
        </div>
        <label className="gw-owner"><span className="gw-owner-lbl">分配给</span>
          <select aria-label={`分配给 ${row.ariaName}`} className={row.dirty ? 'changed' : undefined} value={row.value} disabled={state.busy} onChange={e => on.draft?.(sim, e.target.value)}>
            <option value="">暂不分配</option>{state.users.map(u => <option value={u.id} key={u.id}>{u.username}</option>)}
          </select>
        </label>
        <div className="gw-sim-acts">
          {row.dirty && <><span className="gw-state">已修改，未保存</span><button type="button" className="gw-btn" disabled={state.busy} onClick={() => on.undo?.(sim)}>撤销</button></>}
          {row.canSave && <button type="button" className={`gw-btn ${row.pending ? 'primary-fill' : 'soft'}`} aria-label={`保存分配 ${row.ariaName}`} disabled={state.busy} onClick={() => on.saveOwner?.(sim, row.value)}>保存</button>}
        </div>
      </li>;
    })}</ul>
  </>;
}

function Skeleton() {
  const card = (k: number) => <div className="gw-card gw-skel-card" aria-hidden="true" key={k}><div className="gw-head-row"><div className="gw-kind gw-sk"/><div className="gw-title"><div className="gw-sk" style={{height: 22, width: '40%'}}/><div className="gw-sk" style={{height: 14, width: '62%', marginTop: 8}}/></div></div><div className="gw-sk" style={{height: 44, marginTop: 20}}/></div>;
  return <div className="gw-list" role="status" aria-busy="true"><span className="sr-only">正在读取网关…</span>{card(1)}{card(2)}</div>;
}

export function AdminGatewaysView({state, on = {}}: {state: ViewState; on?: Partial<ViewHandlers>}) {
  const {gateways, sims, power} = state;
  const cards = gateways ? gatewayCards(gateways, sims, power, state.now) : [];
  const orphans = gateways ? orphanSims(gateways, sims) : [];
  return <div className="gw-page">
    <div className="gw-top">
      <p className="gw-summary">{gateways ? adminSummary(gateways, sims, power) : '正在读取网关…'}</p>
      <button type="button" id="gw-add-open" className="gw-btn primary-fill" aria-expanded={Boolean(state.adding)} disabled={state.busy || !gateways} onClick={() => on.openAdd?.()}><UiIcon name="plus" size={18}/>添加网关</button>
    </div>
    {state.error && <div className="gw-banner" role="alert"><UiIcon name="warning"/><div><b>{state.error.title}</b><p>{state.error.text}</p></div><button type="button" className="gw-btn" disabled={state.busy} onClick={() => on.retry?.()}>重试</button></div>}
    {state.adding && <form className="gw-card gw-add" noValidate onSubmit={e => { e.preventDefault(); on.submitAdd?.(); }} onKeyDown={e => { if (e.key === 'Escape') on.cancelAdd?.(); }}>
      <label htmlFor="gw-add-name">设备名称</label>
      <div className="gw-add-row">
        <input id="gw-add-name" value={state.adding.value} maxLength={120} required autoFocus placeholder="例如：家中的网关" autoComplete="off" disabled={state.busy} aria-invalid={state.adding.error ? true : undefined} onChange={e => on.addInput?.(e.target.value)}/>
        <button className="gw-btn primary-fill" disabled={state.busy}>添加</button>
        <button type="button" className="gw-btn" disabled={state.busy} onClick={() => on.cancelAdd?.()}>取消</button>
      </div>
      {state.adding.error && <p className="gw-err" role="alert">{state.adding.error}</p>}
    </form>}
    {!gateways ? (!state.error && <Skeleton/>)
      : !gateways.length ? <div className="gw-card gw-empty"><div className="gw-kind" aria-hidden="true"><UiIcon name="gateways" size={26}/></div><h2>还没有网关</h2><p>网关是插着 SIM 卡的 Pixel 手机或 DJI 4G 模组。添加后在网关设备上输入配对码，号码就会出现在这里。</p><Steps done={0}/></div>
        : <div className="gw-list">{cards.map(card => <GatewayCard key={card.gateway.id} card={card} state={state} on={on}/>)}</div>}
    {orphans.length > 0 && <section className="gw-card" aria-labelledby="gw-orphans"><h2 id="gw-orphans" className="gw-orphans-title">未关联网关的号码</h2><SimList label="未关联网关的号码" sims={orphans} allSims={sims} state={state} on={on}/></section>}
    <div className="gw-toast" role="status" aria-live="polite">{state.notice}</div>
  </div>;
}

export function AdminGateways({request}: {request: ApiRequest}) {
  const [state, setState] = useState<ViewState>({gateways: null, sims: [], users: [], power: null, error: null, busy: false, menu: null, panels: {}, rename: null, drafts: {}, adding: null, notice: '', now: Date.now()});
  const patch = (update: Partial<ViewState> | ((s: ViewState) => Partial<ViewState>)) => setState(s => ({...s, ...(typeof update === 'function' ? update(s) : update)}));
  const epoch = useRef(0), powerEpoch = useRef(0), powerPending = useRef(false), mounted = useRef(true);
  const [focus, setFocus] = useState<{id: string; firstItem?: boolean} | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const api = <T,>(path: string, body?: unknown, method?: string) => requestRef.current<T>(path, body, method);
  useReportedError('网关', 'banner', state.error?.text);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; powerEpoch.current++; }; }, []);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(focus.id);
    (focus.firstItem ? el?.querySelector<HTMLElement>('[role=menuitem]') : el)?.focus();
    setFocus(null);
  }, [focus]);
  const hasPair = Object.values(state.panels).some(p => p.type === 'pair');
  useEffect(() => { if (!hasPair) return; const t = setInterval(() => patch({now: Date.now()}), 1000); return () => clearInterval(t); }, [hasPair]);
  useEffect(() => {
    if (!state.menu) return;
    const close = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.('.gw-menu-wrap')) patch({menu: null}); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [state.menu]);

  async function refreshAdmin() {
    const captured = epoch.current;
    const [g, u, s] = await Promise.all([api<{items: AdminGateway[]}>('/admin/gateways'), api<{items: AdminUser[]}>('/admin/users'), api<{items: AdminSim[]}>('/admin/sims')]);
    if (!mounted.current || captured !== epoch.current) return;
    patch(cur => ({gateways: g.items, users: u.items, sims: s.items, drafts: reconcileDrafts(cur.drafts, s.items), now: Date.now()}));
  }
  /** Never throws: 404 = unsupported (no status, no switch); other failures keep the last known rows. */
  async function refreshPower() {
    if (powerPending.current) return;
    const captured = powerEpoch.current;
    try {
      const r = await api<{items: GatewayPowerDto[]}>('/gateways/power');
      if (mounted.current && captured === powerEpoch.current) patch({power: r.items || []});
    } catch (caught) {
      if (mounted.current && captured === powerEpoch.current && gatewayPowerUnsupported(caught)) patch({power: null});
    }
  }
  async function refresh() {
    try { await Promise.all([refreshAdmin(), refreshPower()]); if (mounted.current) patch(cur => cur.error?.title === '网关列表暂未刷新' ? {error: null} : {}); }
    catch (e) { if (mounted.current) patch({error: {title: '网关列表暂未刷新', text: `${e instanceof Error ? e.message : '刷新失败'}。页面每 5 秒自动重试，下面是上次读取的内容。`}}); }
  }
  useVisibleRefresh(refresh, 5000, true);
  async function act(fn: () => Promise<void>) {
    patch({busy: true, error: null});
    try { await fn(); await refreshAdmin(); }
    catch (e) { patch({error: {title: '操作未完成', text: e instanceof Error ? e.message : '操作失败'}}); }
    finally { if (mounted.current) patch({busy: false}); }
  }
  function announce(notice: string) { patch({notice}); setTimeout(() => { if (mounted.current) patch(s => s.notice === notice ? {notice: ''} : {}); }, 2600); }
  const closePanelState = (id: string) => (s: ViewState) => { const panels = {...s.panels}; delete panels[id]; return {panels}; };
  async function createPairingCode(g: AdminGateway, replaceModule: boolean) {
    const r = await api<{pairingCode: {code: string; expiresAt: string}}>(`/admin/gateways/${g.id}/pairing-codes`, {replaceModule});
    patch(s => ({panels: {...s.panels, [g.id]: {type: 'pair', ...r.pairingCode, timeZone: gatewayDisplayTimeZone(g.timeZone), replaceModule}}, now: Date.now()}));
    setFocus({id: ids.panel(g.id)});
  }
  function setPower(card: GatewayCardView, desired: 'on' | 'off') {
    const id = card.gateway.id;
    void act(async () => {
      powerPending.current = true;
      const captured = ++powerEpoch.current;
      try {
        const r = await api<{item: GatewayPowerDto}>(`/gateways/${encodeURIComponent(id)}/power`, {desired});
        if (captured === powerEpoch.current) patch(s => ({power: s.power?.map(p => p.gatewayId === id ? r.item : p) || [r.item], ...closePanelState(id)(s)}));
      } catch (caught) {
        throw new Error(gatewayPowerErrorMessage(errorCode(caught), caught instanceof Error ? caught.message : '操作失败'));
      } finally {
        powerPending.current = false;
      }
      await refreshPower();
      setFocus({id: ids.power(id)});
    });
  }
  const on: ViewHandlers = {
    retry: () => void refresh(),
    openAdd: () => patch(s => ({adding: s.adding || {value: '', error: ''}})),
    cancelAdd: () => { patch({adding: null}); setFocus({id: 'gw-add-open'}); },
    addInput: value => patch({adding: {value, error: ''}}),
    submitAdd: () => {
      const value = state.adding?.value || '', invalid = gatewayNameError(value);
      if (invalid) { patch({adding: {value, error: invalid}}); return; }
      void act(async () => { await api('/admin/gateways', {name: value.trim()}); patch({adding: null}); announce(`已添加网关 ${value.trim()}`); });
    },
    toggleMenu: id => { patch(s => ({menu: s.menu === id ? null : id})); if (state.menu !== id) setFocus({id: ids.menuList(id), firstItem: true}); },
    closeMenu: id => { patch({menu: null}); setFocus({id: ids.menu(id)}); },
    startRename: g => patch(s => ({menu: null, rename: {id: g.id, value: g.name, error: ''}, ...closePanelState(g.id)(s)})),
    renameInput: value => patch(s => ({rename: s.rename && {...s.rename, value, error: ''}})),
    cancelRename: id => { patch({rename: null}); setFocus({id: ids.menu(id)}); },
    // S131: rename patches the list in place; epoch++ drops a refresh already in flight with the old name.
    saveRename: g => {
      const current = state.rename;
      if (!current) return;
      const invalid = gatewayNameError(current.value);
      if (invalid) { patch({rename: {...current, error: invalid}}); return; }
      patch({busy: true});
      void (async () => {
        try {
          const r = await api<{gateway: AdminGateway}>(`/admin/gateways/${g.id}`, {name: current.value.trim()}, 'PATCH');
          epoch.current++;
          patch(s => ({gateways: s.gateways?.map(x => x.id === g.id ? r.gateway : x) || null, rename: null}));
          setFocus({id: ids.menu(g.id)});
        } catch (e) {
          patch(s => ({rename: s.rename && {...s.rename, error: gatewayRenameErrorText(errorCode(e), e instanceof Error ? e.message : '重命名失败')}}));
        } finally { if (mounted.current) patch({busy: false}); }
      })();
    },
    pair: g => void act(() => createPairingCode(g, false)),
    openPanel: (id, type) => patch(s => ({menu: null, panels: {...s.panels, [id]: {type}}})),
    closePanel: id => {
      const type = state.panels[id]?.type;
      patch(closePanelState(id));
      setFocus({id: type === 'off' ? ids.power(id) : type === 'pair' ? ids.pair(id) : ids.menu(id)});
    },
    confirmReplace: g => void act(() => createPairingCode(g, true)),
    confirmDelete: g => void act(async () => { await api(`/admin/gateways/${g.id}`, undefined, 'DELETE'); patch(closePanelState(g.id)); announce(`已删除网关 ${g.name}`); setFocus({id: 'gw-add-open'}); }),
    power: card => card.toggle?.checked ? patch(s => ({panels: {...s.panels, [card.gateway.id]: {type: 'off'}}})) : card.toggle && setPower(card, card.toggle.desired),
    confirmOff: card => setPower(card, 'off'),
    copy: text => {
      try { void navigator.clipboard.writeText(text).then(() => announce('已复制'), () => announce('无法自动复制，请手动选择后复制')); } catch { announce('无法自动复制，请手动选择后复制'); }
    },
    draft: (sim, value) => patch(s => ({drafts: {...s.drafts, [sim.id]: {value, version: sim.version}}})),
    undo: sim => patch(s => { const drafts = {...s.drafts}; delete drafts[sim.id]; return {drafts}; }),
    saveOwner: (sim, value) => void act(async () => {
      await api(`/admin/sims/${sim.id}/owner`, {ownerUserId: value || null, expectedVersion: sim.version}, 'PUT');
      patch(s => { const drafts = {...s.drafts}; delete drafts[sim.id]; return {drafts}; });
      announce(`已保存分配 ${sim.phoneLabel || sim.label || '未命名号码'}`);
    }),
  };
  return <AdminGatewaysView state={state} on={on}/>;
}
