/** S58：网关类型只决定文字，不参与能力判断；Control 缺字段（旧版本）按 Pixel 处理。 */
export type GatewayKind='pixel'|'dji4g';

const LABELS={
 pixel:{device:'Pixel',tag:'PX',short:'Pixel',deviceDial:'通过手机拨打',occupied:'手机通话中'},
 dji4g:{device:'DJI 4G 模组',tag:'DJI',short:'DJI 4G',deviceDial:'通过 DJI 4G 模组拨打',occupied:'DJI 4G 模组通话中'},
} as const;

export function gatewayKindLabel(kind?:string|null){return LABELS[kind==='dji4g'?'dji4g':'pixel'];}
/** 长标签：`PX-<id>` / `DJI-<id>`。 */
export function gatewayTag(gatewayId:string,kind?:string|null){return `${gatewayKindLabel(kind).tag}-${gatewayId}`;}
/** 短标签：S91 有网关名时显示名字，否则 `Pixel · <8 位>` / `DJI 4G · <8 位>`。 */
export function gatewayShortLabel(gatewayId:string,kind?:string|null,name?:string|null){return name?.trim()||`${gatewayKindLabel(kind).short} · ${gatewayId.slice(0,8)}`;}
/** 录音来源按钮：`Pixel 原始归档` / `DJI 4G 原始归档`。 */
export function gatewayArchiveLabel(kind?:string|null){return `${gatewayKindLabel(kind).short} 原始归档`;}
/** S130/S131：网关行绑定的模组（IMEI 后 6 位），作为名称下方的次要行；Pixel 与旧行无绑定。 */
export function gatewayModuleText(moduleLabel?:string|null){return moduleLabel?`模组尾号 ${moduleLabel}`:'未绑定模组';}
/** S131：改名先去首尾空白，1–120 字；合法返回空串。 */
export function gatewayNameError(name:string){const t=name.trim();return !t?'请输入网关名称':t.length>120?'网关名称最多 120 个字':'';}
/** S131：409 GATEWAY_NAME_TAKEN →「已有同名网关」，其余沿用请求错误文案。 */
export function gatewayRenameErrorText(code:string|undefined,fallback:string){return code==='GATEWAY_NAME_TAKEN'?'已有同名网关':fallback;}
