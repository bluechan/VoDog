import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer, type ViteDevServer} from 'vite';
import type {GatewayPowerDto} from '../src/gateway-power.ts';
import type {AdminGateway, AdminSim} from '../src/admin-gateways-model.ts';
import type {ViewState} from '../src/admin-gateways.tsx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: ViteDevServer | undefined;
async function load() {
  if (!server) server = await createServer({root, server: {middlewareMode: true, hmr: false}, appType: 'custom', logLevel: 'error'});
  const model = (await server.ssrLoadModule('/src/admin-gateways-model.ts')) as typeof import('../src/admin-gateways-model.ts');
  const view = (await server.ssrLoadModule('/src/admin-gateways.tsx')) as typeof import('../src/admin-gateways.tsx');
  return {...model, ...view};
}
after(async () => { await server?.close(); server = undefined; });

const NOW = Date.parse('2026-10-12T04:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const gw = (over: Partial<AdminGateway> & {id: string; name: string}): AdminGateway => ({controlEnabled: true, telephonyReady: true, smsReady: true, mediaReady: true, lastSeenAt: ago(2), deviceEpoch: 3, timeZone: 'Asia/Shanghai', kind: 'dji4g', moduleLabel: '628507', ...over});
const sim = (over: Partial<AdminSim> & {id: string; gatewayId: string}): AdminSim => ({slotIndex: 0, label: '主卡', phoneLabel: '+86 138 0000 0001', present: true, ownerUserId: 'u1', version: 1, assignmentPending: false, ...over});

const gateways: AdminGateway[] = [
  gw({id: '7c1e9a42-5b3d-4f0e-9a61-2d8b4c6e1f30', name: 'DJI 4G'}),
  gw({id: '3b8d0f17-2e4c-4a9b-8d15-6f0a7c3e9b21', name: 'DJI 4G 459525', moduleLabel: '459525', lastSeenAt: ago(90), telephonyReady: false, smsReady: false}),
  gw({id: 'e5a27c90-81f3-4d6b-b0c4-9a2d5e7f1c08', name: '待命模组', moduleLabel: '514962', lastSeenAt: ago(6), controlEnabled: false}),
  gw({id: '92f4d6b1-0a7e-4c35-8e29-1b6c3d8f5a74', name: 'Pixel 7 Pro', kind: 'pixel', moduleLabel: null, lastSeenAt: ago(0)}),
];
const [online, offline, standby, pixel] = gateways;
const sims: AdminSim[] = [
  sim({id: 's-a1', gatewayId: online.id}),
  sim({id: 's-a2', gatewayId: online.id, slotIndex: 1, label: '副卡', phoneLabel: '+86 138 0000 0002', ownerUserId: null}),
  sim({id: 's-b1', gatewayId: offline.id, label: '出差卡', phoneLabel: '12', present: false}),
  sim({id: 's-c1', gatewayId: standby.id, label: '家用', phoneLabel: '+86 138 0000 0004', assignmentPending: true, version: 5}),
  sim({id: 's-d1', gatewayId: pixel.id, label: '个人', phoneLabel: '+86 138 0000 0005', version: 12}),
];
const power: GatewayPowerDto[] = [
  {gatewayId: online.id, name: 'DJI 4G', online: true, remotePowerAllowed: true, controlEnabled: true},
  {gatewayId: offline.id, online: false, standbyOnline: false, remotePowerAllowed: true},
  {gatewayId: standby.id, online: false, standbyOnline: true, remotePowerAllowed: true},
  {gatewayId: pixel.id, online: true, occupied: true, remotePowerAllowed: true, controlEnabled: true},
];
const users = [{id: 'u1', username: 'louis'}, {id: 'u2', username: '家人'}];
const base: ViewState = {gateways, sims, users, power, error: null, busy: false, menu: null, panels: {}, rename: null, drafts: {}, adding: null, notice: '', now: NOW};

/** Every scenario the spec lists; also written to static HTML when S132_SSR_OUT is set (visual check only). */
const scenarios: Record<string, Partial<ViewState>> = {
  normal: {},
  'unsupported-power': {power: null},
  loading: {gateways: null, sims: [], users: []},
  empty: {gateways: [], sims: []},
  error: {error: {title: '网关列表暂未刷新', text: '服务连接暂不可用。页面每 5 秒自动重试，下面是上次读取的内容。'}},
  pairing: {panels: {[online.id]: {type: 'pair', code: 'K7Q2M9XA', expiresAt: new Date(NOW + 9 * 60_000).toISOString(), timeZone: 'Asia/Shanghai', replaceModule: false}}},
  'menu-dji': {menu: online.id},
  'menu-pixel': {menu: pixel.id},
  'delete-confirm': {panels: {[offline.id]: {type: 'delete'}}},
  'off-confirm': {panels: {[online.id]: {type: 'off'}}},
  dirty: {drafts: {'s-a2': {value: 'u2', version: 1}}},
  rename: {rename: {id: online.id, value: 'DJI 4G 459525', error: '已有同名网关'}},
};
async function render(name: string) {
  const {AdminGatewaysView} = await load();
  return renderToStaticMarkup(React.createElement(AdminGatewaysView, {state: {...base, ...scenarios[name]}}));
}
const attr = (html: string, name: string) => html.includes(`aria-label="${name}"`);

test('model: join by id — missing power row and unsupported power give 状态未知 and no switch', async () => {
  const {gatewayCards} = await load();
  const cards = gatewayCards(gateways, sims, power.slice(1), NOW);
  assert.equal(cards[0].status.text, '状态未知');
  assert.equal(cards[0].toggle, undefined);
  assert.deepEqual(cards.slice(1).map(c => c.status.text), ['离线', '待命中', '在线 · 通话中']);
  assert.deepEqual(cards.slice(1).map(c => c.status.shape), ['offline', 'pending', 'online']);
  assert.equal(cards[1].toggle?.disabled, true);
  assert.equal(cards[2].toggle?.disabled, false);
  assert.equal(cards[3].toggle?.hint, '通话进行中，暂不可远程关闭。');
  assert.ok(gatewayCards(gateways, sims, null, NOW).every(c => c.status.text === '状态未知' && !c.toggle));
  assert.deepEqual(cards[0].sims.map(s => s.id), ['s-a1', 's-a2']);
});

test('model: summary counts, zero parts dropped, power-unknown drops 在线/待命', async () => {
  const {adminSummary} = await load();
  assert.equal(adminSummary(gateways, sims, power), '4 个网关 · 2 在线 · 1 待命 · 1 张卡待分配 · 1 张卡需确认');
  assert.equal(adminSummary(gateways, sims, null), '4 个网关 · 1 张卡待分配 · 1 张卡需确认');
  assert.equal(adminSummary(gateways.slice(0, 1), [sims[0]], []), '1 个网关 · 0 在线');
  assert.equal(adminSummary([], [], power), '还没有网关');
});

test('model: relative time and pairing countdown', async () => {
  const {relativeTime, pairingRemaining} = await load();
  assert.equal(relativeTime(ago(0.5), NOW), '刚刚');
  assert.equal(relativeTime(ago(2), NOW), '2 分钟前');
  assert.equal(relativeTime(ago(60), NOW), '1 小时前');
  assert.equal(relativeTime(ago(90), NOW), '1 小时 30 分钟前');
  assert.equal(relativeTime(ago(60 * 50), NOW), '2 天前');
  assert.equal(relativeTime('bad', NOW), '');
  assert.equal(pairingRemaining(new Date(NOW + 65_000).toISOString(), NOW), '剩余 1:05');
  assert.equal(pairingRemaining(new Date(NOW - 1).toISOString(), NOW), '已过期，请重新生成');
});

test('model: Pixel or missing kind hides 更换模组配对码', async () => {
  const {gatewayMenuItems} = await load();
  assert.deepEqual(gatewayMenuItems('dji4g'), ['rename', 'replace', 'delete']);
  for (const kind of ['pixel', null, undefined]) assert.deepEqual(gatewayMenuItems(kind), ['rename', 'delete']);
});

test('model: SIM row tail, dirty / pending / unassigned, save visibility', async () => {
  const {simRowView} = await load();
  const plain = simRowView(sims[0], {});
  assert.equal(plain.tail, '0001');
  assert.equal(plain.title, '主卡');
  assert.equal(plain.ariaName, '+86 138 0000 0001');
  assert.equal(plain.canSave, false);
  assert.equal(simRowView(sims[2], {}).tail, undefined);
  const unassigned = simRowView(sims[1], {});
  assert.equal(unassigned.unassigned, true);
  const dirty = simRowView(sims[1], {'s-a2': {value: 'u2', version: 1}});
  assert.deepEqual([dirty.value, dirty.dirty, dirty.unassigned, dirty.canSave], ['u2', true, false, true]);
  const pending = simRowView(sims[3], {});
  assert.deepEqual([pending.pending, pending.dirty, pending.canSave], [true, false, true]);
  // A draft made against an older version no longer applies.
  assert.equal(simRowView(sims[1], {'s-a2': {value: 'u2', version: 0}}).dirty, false);
  // Choosing the saved owner again is not a change.
  assert.equal(simRowView(sims[0], {'s-a1': {value: 'u1', version: 1}}).dirty, false);
});

test('model: a refresh keeps other rows\' drafts and drops only the row whose version changed', async () => {
  const {reconcileDrafts} = await load();
  const drafts = {'s-a1': {value: 'u2', version: 1}, 's-a2': {value: 'u1', version: 1}, gone: {value: 'u1', version: 1}};
  const refreshed = sims.map(s => s.id === 's-a1' ? {...s, version: 2} : s);
  assert.deepEqual(reconcileDrafts(drafts, refreshed), {'s-a2': {value: 'u1', version: 1}});
  assert.deepEqual(reconcileDrafts(drafts, sims), {'s-a1': {value: 'u2', version: 1}, 's-a2': {value: 'u1', version: 1}});
});

test('SSR: online / offline / standby / in-call Pixel cards show status text, switch and ARIA names', async () => {
  const html = await render('normal');
  assert.match(html, /4 个网关 · 2 在线 · 1 待命 · 1 张卡待分配 · 1 张卡需确认/);
  for (const g of gateways) {
    assert.ok(attr(html, `生成配对码 ${g.name}`), g.name);
    assert.ok(attr(html, `网关总控 ${g.name}`), g.name);
    assert.ok(attr(html, `更多操作 ${g.name}`), g.name);
  }
  assert.match(html, /role="switch" aria-checked="true" aria-label="网关总控 DJI 4G"/);
  assert.match(html, /在线 · 通话中/);
  assert.match(html, /待命中/);
  assert.match(html, />离线</);
  assert.match(html, /通话进行中，暂不可远程关闭。/);
  assert.match(html, /网关未在待命，无法远程开启。/);
  assert.match(html, /DJI 4G 模组 · 模组尾号 628507 · 最近联络 <time[^>]*>2 分钟前<\/time>/);
  assert.match(html, />Pixel · 最近联络/);
  assert.match(html, /1 小时 30 分钟前/);
  assert.match(html, /尾号 <!-- -->0001|尾号 0001/);
  assert.match(html, /待分配/);
  assert.match(html, /卡片已变化，需要重新确认账号。/);
  assert.ok(attr(html, '保存分配 +86 138 0000 0004'), 'pending row offers 保存');
  assert.ok(!attr(html, '保存分配 +86 138 0000 0001'), 'unchanged row has no 保存');
  assert.match(html, /未待机，保留归属及历史/);
  // Raw ids only inside the 详情 fold.
  const outsideDetails = html.replace(/<details[\s\S]*?<\/details>/g, '');
  for (const g of gateways) assert.ok(!outsideDetails.replace(/ id="[^"]*"| aria-[a-z]+="gw-[^"]*"/g, '').includes(g.id), g.name);
  assert.match(html, /DJI-7c1e9a42-5b3d-4f0e-9a61-2d8b4c6e1f30/);
  // Menus are closed: their items are not rendered yet.
  assert.ok(!attr(html, `删除网关 ${online.name}`));
});

test('SSR: unsupported power degrades to 状态未知 without switches', async () => {
  const html = await render('unsupported-power');
  assert.equal((html.match(/状态未知/g) || []).length, 4);
  assert.ok(!html.includes('role="switch"'));
  assert.match(html, /总控已开启/);
});

test('SSR: menus — DJI offers 更换模组配对码, Pixel does not', async () => {
  const dji = await render('menu-dji');
  for (const name of ['重命名网关 DJI 4G', '更换模组配对码 DJI 4G', '删除网关 DJI 4G']) assert.ok(attr(dji, name), name);
  assert.match(dji, /aria-expanded="true"/);
  const px = await render('menu-pixel');
  assert.ok(attr(px, '重命名网关 Pixel 7 Pro'));
  assert.ok(attr(px, '删除网关 Pixel 7 Pro'));
  assert.ok(!px.includes('更换模组配对码'));
});

test('SSR: empty, loading and error banner', async () => {
  const empty = await render('empty');
  assert.match(empty, /还没有网关/);
  assert.match(empty, /添加网关/);
  const loading = await render('loading');
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /正在读取网关…/);
  const error = await render('error');
  const banner = error.indexOf('role="alert"'), list = error.indexOf('gw-list');
  assert.ok(banner > 0 && banner < list, 'banner sits above the cards');
  assert.match(error, /网关列表暂未刷新/);
  assert.match(error, />重试</);
  assert.ok(attr(error, '生成配对码 DJI 4G'), 'cards stay visible under the banner');
});

test('SSR: pairing panel keeps the S130/S131 lines, confirms reuse production copy', async () => {
  const html = await render('pairing');
  assert.match(html, /在网关设备上输入此配对码/);
  assert.match(html, />K7Q2M9XA</);
  assert.match(html, /DJI 4G · 模组尾号 628507/);
  assert.match(html, /有效至 <!-- -->12:09<!-- -->，只能使用一次。|有效至 12:09，只能使用一次。/);
  assert.match(html, /剩余 9:00/);
  assert.match(html, />隐藏配对码</);
  const {GATEWAY_DELETE_PROMPT} = (await server!.ssrLoadModule('/src/confirm-copy.ts')) as typeof import('../src/confirm-copy.ts');
  const del = await render('delete-confirm');
  assert.ok(del.includes(GATEWAY_DELETE_PROMPT));
  assert.match(del, />确认删除</);
  const off = await render('off-confirm');
  assert.match(off, /关闭 DJI 4G 的网关总控？网关设备将恢复本地通话。/);
  assert.match(off, />确认关闭</);
});

test('SSR: dirty row and rename error', async () => {
  const dirty = await render('dirty');
  assert.match(dirty, /已修改，未保存/);
  assert.ok(attr(dirty, '保存分配 +86 138 0000 0002'));
  assert.match(dirty, />撤销</);
  const rename = await render('rename');
  assert.match(rename, /已有同名网关/);
  assert.match(rename, /maxLength="120"|maxlength="120"/);
});

test('SSR scenarios to static HTML (only with S132_SSR_OUT)', {skip: !process.env.S132_SSR_OUT}, async () => {
  const out = process.env.S132_SSR_OUT!;
  mkdirSync(out, {recursive: true});
  const css = readFileSync(path.join(root, 'src/style.css'), 'utf8');
  for (const name of Object.keys(scenarios)) {
    const body = await render(name);
    for (const theme of ['light', 'dark']) {
      writeFileSync(path.join(out, `${name}-${theme}.html`), `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>.shell-sim{display:flex;min-height:100vh}.shell-sim aside{width:244px;flex:none;background:var(--chrome);border-right:1px solid var(--line)}@media(max-width:600px){.shell-sim aside{display:none}}</style></head><body><div class="shell-sim"><aside></aside><main class="page">${body}</main></div><script>addEventListener('load',()=>{document.title='overflow='+(document.documentElement.scrollWidth>innerWidth)+' sw='+document.documentElement.scrollWidth+' iw='+innerWidth})</script></body></html>`);
    }
  }
});
