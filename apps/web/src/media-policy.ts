type MediaRequestOptions={signal?:AbortSignal;timeoutMs?:number};
type MediaAPI=<T>(path:string,body?:unknown,method?:string,options?:MediaRequestOptions)=>Promise<T>;
type RelayOptions={iceServers:RTCIceServer[];iceTransportPolicy:'relay'};
type Transport='udp'|'tls';
type Measure=(api:MediaAPI,signal:AbortSignal)=>Promise<string>;

export function errorCode(error:unknown):string|undefined{return typeof error==='object'&&error!==null&&'code' in error?String(error.code):undefined;}

/**
 * iOS MediaRetryPolicy.shouldRetryTLS 的 Web 对应：只有 UDP 下中继候选缺失 / ICE 失败 / ICE 超时才换 TLS 重试一次。
 * offer 之前：NO_RELAY_CANDIDATE / ICE_FAILED / ICE_TIMEOUT；offer 之后：ICE_CONNECT_TIMEOUT / ICE_CONNECT_FAILED（与 iOS
 * iceConnectTimedOut / iceConnectionFailed 相同）——腿从未 Connected，桥按 S52 同角色替换（Control 对本人的腿还带 S75c replace），不会 409。
 * 桥拒绝（MEDIA_BRIDGE_UNAVAILABLE）、TLS 失败、API 错误、鉴权、麦克风、取消都不重试。
 */
export function shouldRetryTls(error:unknown,transport:Transport):boolean{
 return transport==='udp'&&['NO_RELAY_CANDIDATE','ICE_FAILED','ICE_TIMEOUT','ICE_CONNECT_TIMEOUT','ICE_CONNECT_FAILED'].includes(errorCode(error)??'');
}

export type NetworkSnapshot={type?:string;onLine?:boolean};
/** `connection.type`（有此属性的浏览器）与 `navigator.onLine`；不含 effectiveType/rtt/downlink 这些估算值。 */
export function networkSnapshot(connection?:EventTarget|null):NetworkSnapshot{
 const type=(connection as {type?:unknown}|null|undefined)?.type,onLine=(globalThis.navigator as Navigator|undefined)?.onLine;
 return {type:typeof type==='string'?type:undefined,onLine:typeof onLine==='boolean'?onLine:undefined};
}
/** Chrome 在 effectiveType/rtt/downlink 估算变化时也发 `change`：只有 `type` 真的变了（浏览器提供时）或 onLine 翻转才算换网。 */
export function networkSwitched(before:NetworkSnapshot,after:NetworkSnapshot):boolean{
 return before.onLine!==after.onLine||((before.type!==undefined||after.type!==undefined)&&before.type!==after.type);
}

let networkEpoch=0;
const watchedNetworkTargets=new WeakSet<object>();
/** 本页的网络代：online/offline 或换网（见 networkSwitched）时加一。测节点缓存与记住的传输都只在同一代内复用。 */
export const currentNetworkEpoch=()=>networkEpoch;
/** 默认监听本页 window 与 navigator.connection（Node 测试里两者都没有）；每个目标只装一次。 */
export function watchNetworkEpoch(
 target:Pick<EventTarget,'addEventListener'>|undefined=typeof globalThis.addEventListener==='function'?globalThis:undefined,
 connection:EventTarget|undefined=(globalThis.navigator as (Navigator&{connection?:EventTarget})|undefined)?.connection,
){
 try{
  const bump=()=>{networkEpoch++;};
  if(target&&!watchedNetworkTargets.has(target)){watchedNetworkTargets.add(target);target.addEventListener('online',bump);target.addEventListener('offline',bump);}
  if(connection&&!watchedNetworkTargets.has(connection)){
   watchedNetworkTargets.add(connection);let last=networkSnapshot(connection);
   connection.addEventListener('change',()=>{const next=networkSnapshot(connection);if(networkSwitched(last,next)){last=next;bump();}});
  }
 }catch{/* No network events: the TTLs still bound reuse. */}
}

type TransportStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
/** 只在浏览器里用 localStorage；隐私模式、禁用存储或 Node 测试时返回 null，所有读写都是尽力而为。 */
export function transportStorage():TransportStorage|null{try{return typeof window==='undefined'?null:window.localStorage;}catch{return null;}}
const TRANSPORT_CHOICE_KEY='vodog:media-transport-choice:v1',LEARNED_TRANSPORT_KEY='vodog:media-transport-learned:v1';
/** 自动回退学到的 TLS 只保留 24 h（从 UDP 失败那一刻算，TLS 起步的成功不续期），之后重新先试 UDP。 */
export const LEARNED_TRANSPORT_TTL_MS=24*3600_000;
const PAGE_ID=Math.random().toString(36).slice(2);
/** 设置页「此浏览器的连接方式」：持久化在本浏览器，读不到时为标准连接（UDP）。 */
export function readTransportChoice(storage=transportStorage()):Transport{
 try{return storage?.getItem(TRANSPORT_CHOICE_KEY)==='tls'?'tls':'udp';}catch{return 'udp';}
}
export function saveTransportChoice(transport:Transport,storage=transportStorage()){
 try{if(transport==='tls')storage?.setItem(TRANSPORT_CHOICE_KEY,'tls');else storage?.removeItem(TRANSPORT_CHOICE_KEY);}catch{/* The choice still applies to this page. */}
}
/** 网络标识：浏览器提供 `connection.type` 时用它（wifi/cellular…），否则 unknown；同页内还要求同一网络代。 */
export function networkLabel(connection=(globalThis.navigator as (Navigator&{connection?:EventTarget})|undefined)?.connection):string{
 return networkSnapshot(connection).type??'unknown';
}
type LearnedTransport={transport:'tls';network:string;at:number;page:string;epoch:number};
/** 标准连接（UDP）时：本网络 24 h 内 UDP 失败、TLS 自动回退成功过 → 下一通直接从 TLS 起步，省去 UDP 的收集等待。 */
export function learnedTransport(storage=transportStorage(),now=Date.now(),network=networkLabel()):Transport|undefined{
 try{
  const raw=storage?.getItem(LEARNED_TRANSPORT_KEY);if(!raw)return undefined;
  const value=JSON.parse(raw) as Partial<LearnedTransport>;
  const fresh=value.transport==='tls'&&value.network===network&&typeof value.at==='number'&&now-value.at>=0&&now-value.at<LEARNED_TRANSPORT_TTL_MS;
  if(fresh&&!(value.page===PAGE_ID&&value.epoch!==currentNetworkEpoch()))return 'tls';
  storage?.removeItem(LEARNED_TRANSPORT_KEY);return undefined;
 }catch{return undefined;}
}
/** 记住 UDP→TLS 自动回退的结果（transport=tls），或在 UDP 起步成功 / 学到的 TLS 起步失败时忘掉（transport=null）。 */
export function rememberTransport(transport:'tls'|null,storage=transportStorage(),now=Date.now(),network=networkLabel()){
 try{
  if(!transport){storage?.removeItem(LEARNED_TRANSPORT_KEY);return;}
  const value:LearnedTransport={transport,network,at:now,page:PAGE_ID,epoch:currentNetworkEpoch()};
  storage?.setItem(LEARNED_TRANSPORT_KEY,JSON.stringify(value));
 }catch{/* Learning is an optimisation only. */}
}

/** Server media codes carry the real reason; anything else (including DOMException numeric codes) keeps its own message. */
const MEDIA_ERROR_MESSAGES:Record<string,string>={
 GATEWAY_OFFLINE:'网关当前不在线（心跳超时），请稍后重试',
 MEDIA_UNAVAILABLE:'网关媒体能力暂不可用，请稍后重试',
 MEDIA_NODE_UNAVAILABLE:'当前网络与设备没有共同可用的媒体节点',
 MEDIA_BRIDGE_UNAVAILABLE:'媒体节点未接受连接，请重试',
 MEDIA_REVOKED:'通话已结束或媒体授权失效',
 MEDIA_PROBE_REQUIRED:'网络测量尚未完成，请重试',
 MEDIA_NODE_MISMATCH:'媒体节点不一致，请重新连接音频',
 MEDIA_NOT_WINNER:'此通话已由其他设备接听',
};
export function mediaErrorMessage(code:string|undefined,fallback:string):string{
 return (code!==undefined&&Object.prototype.hasOwnProperty.call(MEDIA_ERROR_MESSAGES,code)?MEDIA_ERROR_MESSAGES[code]:undefined)??fallback;
}

/** S72 E：通话接口的 409 错误码固定文案；其余错误码沿用服务端 message。 */
const CALL_ERROR_MESSAGES:Record<string,string>={
 SAME_DEVICE_INTERNAL:'同一设备上的两张卡不能互打',
 OWN_OUTGOING_CALL:'这是你正在拨出的通话',
};
export function callErrorMessage(code:string|undefined,fallback:string):string{
 return (code!==undefined&&Object.prototype.hasOwnProperty.call(CALL_ERROR_MESSAGES,code)?CALL_ERROR_MESSAGES[code]:undefined)??fallback;
}

export async function boundedOperation<T>(operation:Promise<T>,signal:AbortSignal,timeoutMs:number,message:string,onLateValue?:(value:T)=>void):Promise<T>{
 return await new Promise<T>((resolve,reject)=>{
  let settled=false;
  const finish=(action:()=>void)=>{if(settled)return false;settled=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);action();return true;};
  const onAbort=()=>finish(()=>reject(new DOMException('媒体连接已取消','AbortError')));
  const timer=setTimeout(()=>finish(()=>reject(new Error(message))),timeoutMs);
  signal.addEventListener('abort',onAbort,{once:true});
  operation.then(value=>{if(!finish(()=>resolve(value)))try{onLateValue?.(value);}catch{/* Late cleanup must never create an unhandled rejection. */}},error=>{finish(()=>reject(error));});
  if(signal.aborted)onAbort();
 });
}

export type CallEndPolicy={id:string;state:string;claimedByCurrentSession?:boolean;originatingPlatform?:string};
export function mayEndCall(call:CallEndPolicy,mediaCallId:string|null):boolean{
 // S38: 手机拨号盘发起的通话不归任何客户端控制（Control 对它的 /end 返回 409）。
 if(call.originatingPlatform==='pixel')return false;
 if(call.state==='incoming_ringing')return true;
 return ['outgoing_pending','connecting','active','ending','unknown'].includes(call.state)&&(call.claimedByCurrentSession===true||mediaCallId===call.id);
}

export function requiresSessionOwnerEnd(call:CallEndPolicy):boolean{
 return ['outgoing_pending','connecting','active','ending','unknown'].includes(call.state);
}

export function ringingEndGuard(call:CallEndPolicy):{onlyIfRinging:true}{
 if(call.state!=='incoming_ringing')throw new Error('只能用振铃保护拒接尚未接听的来电');
 return {onlyIfRinging:true};
}

export function validateRelayOptions(options:RelayOptions,transport:Transport):RTCConfiguration{
 if(options?.iceTransportPolicy!=='relay'||!Array.isArray(options.iceServers)||options.iceServers.length!==1)throw new Error('中继授权配置无效');
 const server=options.iceServers[0],urls=typeof server.urls==='string'?[server.urls]:server.urls;
 if(!Array.isArray(urls)||urls.length!==1||typeof server.username!=='string'||!server.username||typeof server.credential!=='string'||!server.credential)throw new Error('中继授权配置无效');
 const value=urls[0].toLowerCase(),match=/^(turn|turns):(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?\?transport=(udp|tcp)$/.exec(value);
 if(!match||(match[3]!==undefined&&Number(match[3])>65535))throw new Error('中继授权配置无效');
 const host=match[2];
 if(host.startsWith('[')){
  try{new URL(`https://${host}`);}catch{throw new Error('中继授权配置无效');}
 }else if(host.length>253||host.split('.').some(label=>label.length<1||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))throw new Error('中继授权配置无效');
 if(transport==='udp'&&(match[1]!=='turn'||match[4]!=='udp'))throw new Error('中继授权配置无效');
 if(transport==='tls'&&(match[1]!=='turns'||match[4]!=='tcp'))throw new Error('中继授权配置无效');
 return {iceServers:[server],iceTransportPolicy:'relay'};
}

export async function authorizeMedia(callId:string,api:MediaAPI,transport:Transport,signal:AbortSignal,measure:Measure):Promise<RTCConfiguration>{
 for(let attempt=0;attempt<2;attempt++){
  const networkGeneration=await measure(api,signal);
  try{
   const options=await api<RelayOptions>(`/calls/${callId}/media/options`,{transport,networkGeneration},undefined,{signal,timeoutMs:6000});
   return validateRelayOptions(options,transport);
  }catch(error){if(errorCode(error)==='MEDIA_PROBE_REQUIRED'&&attempt===0)continue;throw error;}
 }
 throw new Error('无法确认媒体节点');
}
