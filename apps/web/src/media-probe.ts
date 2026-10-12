import {currentNetworkEpoch,watchNetworkEpoch} from './media-policy.ts';
export type ProbeAPI=<T>(path:string,body?:unknown,method?:string,options?:{signal?:AbortSignal;timeoutMs?:number})=>Promise<T>;
type ProbeNode={nodeId:string;probeUrl:string;grants:string[]};
type ProbeOptions={networkGeneration:string;nodes:ProbeNode[]};
type ProbeSample={nodeId:string;outcome:'ok'|'timeout'|'network_error';httpsRttMs?:number};
const trustedOrigins=new Set(['https://control.example.com','https://relay.example.com:16800']);

/** Measures this browser's current HTTPS path, never a VPS-to-VPS surrogate. */
export async function measureMediaNodes(api:ProbeAPI,signal:AbortSignal,dependencies:{fetch?:typeof fetch;now?:()=>number;newId?:()=>string;timeoutMs?:number}={}):Promise<string>{
 const request=dependencies.fetch??fetch,now=dependencies.now??(()=>performance.now());
 const networkGeneration=(dependencies.newId??(()=>crypto.randomUUID()))();
 const assertCurrent=()=>{if(signal.aborted)throw new Error('通话网络测量已取消，请重试');};
 assertCurrent();
 const options=await api<ProbeOptions>('/media/probes/options',{networkGeneration},undefined,{signal,timeoutMs:6000});
 assertCurrent();
 if(options.networkGeneration!==networkGeneration||!Array.isArray(options.nodes)||!options.nodes.length||options.nodes.length>16)throw new Error('中继探测配置无效');
 const seen=new Set<string>();
 for(const node of options.nodes){
  const url=new URL(node.probeUrl);
  if(!trustedOrigins.has(url.origin)||url.pathname!=='/probe'||url.search||url.hash||url.username||url.password||!node.nodeId||seen.has(node.nodeId)||!Array.isArray(node.grants)||node.grants.length!==3||node.grants.some(g=>typeof g!=='string'||!g||g.length>4096))throw new Error('中继探测配置无效');
  seen.add(node.nodeId);
 }
 const results=await Promise.all(options.nodes.map(async node=>{
  const sample=async(grant:string):Promise<ProbeSample>=>{
   assertCurrent();
   const controller=new AbortController();let timedOut=false;
   const cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});
   const timer=setTimeout(()=>{timedOut=true;controller.abort();},dependencies.timeoutMs??2000);
   const started=now();
   try{
    const response=await request(node.probeUrl,{method:'POST',headers:{Authorization:`Bearer ${grant}`},credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
    const body=await response.json();assertCurrent();
    const elapsed=now()-started;
    if(!response.ok||body.ok!==true||body.nodeId!==node.nodeId||!Number.isFinite(elapsed)||elapsed<0||elapsed>10000)throw new Error('Invalid probe response');
    return {nodeId:node.nodeId,outcome:'ok',httpsRttMs:elapsed};
   }catch{
    assertCurrent();return {nodeId:node.nodeId,outcome:timedOut?'timeout':'network_error'};
   }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
  };
  // S98：第一份授权单独发（承担建连，与过去的第一个样本相同），其余两份同时发——仍是每节点 3 个样本，少一个往返；
  // 三份全并发会让每个样本都含 TCP+TLS 建连（HTTP/1.1 下各开一条连接），高 RTT 有丢包时更容易超时、把首选节点判为失败。
  const [first,...rest]=node.grants;
  return [await sample(first!),...await Promise.all(rest.map(sample))];
 }));
 assertCurrent();
 const samples=results.flat();
 const result=await api<{accepted:number}>('/media/probes/results',{networkGeneration,samples},undefined,{signal,timeoutMs:6000});
 if(result.accepted!==samples.length)throw new Error('中继测量结果未被完整确认');
 const {measureRelayQuality}=await import('./media-quality-probe.ts');
 await measureRelayQuality(api,networkGeneration,signal);
 assertCurrent();return networkGeneration;
}

/** S98：Control 把一个会话已接受的测量保留 120 s（MediaProbeCoordinator ttlMs）；本页在同一会话、同一网络代内复用 ≤100 s。 */
export const PROBE_CACHE_TTL_MS=100_000;
type Measure=(api:ProbeAPI,signal:AbortSignal)=>Promise<string>;
type CacheEntry={session:unknown;epoch:number;at:number;generation:string};
type InFlight={session:unknown;epoch:number;promise:Promise<string>};
const abortable=<T>(promise:Promise<T>,signal:AbortSignal)=>new Promise<T>((resolve,reject)=>{
 const abort=()=>reject(new DOMException('通话网络测量已取消','AbortError'));
 if(signal.aborted){abort();return;}
 signal.addEventListener('abort',abort,{once:true});
 promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
});

/**
 * 已被 Control 接受的测节点结果（networkGeneration），按会话 + 网络代 + 100 s 复用。
 * 同一时刻同一会话只跑一次测量：Control 每会话只留一个 generation，并发的第二次测量会把第一次的证据顶掉。
 */
export class MediaProbeCache{
 private entry?:CacheEntry;
 private inFlight?:InFlight;
 private readonly now:()=>number;
 private readonly epoch:()=>number;
 private readonly ttlMs:number;
 constructor({now=()=>performance.now(),epoch=currentNetworkEpoch,ttlMs=PROBE_CACHE_TTL_MS}:{now?:()=>number;epoch?:()=>number;ttlMs?:number}={}){this.now=now;this.epoch=epoch;this.ttlMs=ttlMs;}
 /** 本会话在当前网络代上、仍在有效期内的 generation。 */
 cached(session:unknown):string|undefined{
  const entry=this.entry;
  if(entry&&entry.session===session&&entry.epoch===this.epoch()&&this.now()-entry.at<this.ttlMs)return entry.generation;
  return undefined;
 }
 forget(){this.entry=undefined;}
 /** 测量一次（或加入本会话、本网络代正在跑的那次），成功后记下；网络代变了的结果不记。 */
 async measure(session:unknown,api:ProbeAPI,signal:AbortSignal,measure:Measure=measureMediaNodes):Promise<string>{
  const running=this.inFlight;
  if(running&&running.session===session&&running.epoch===this.epoch()){
   try{return await abortable(running.promise,signal);}catch(error){if(signal.aborted)throw error;/* The shared run failed: measure on our own. */}
  }
  const epoch=this.epoch(),started=this.now(),promise=measure(api,signal),flight={session,epoch,promise};
  this.inFlight=flight;
  try{
   const generation=await promise;
   if(epoch===this.epoch())this.entry={session,epoch,at:started,generation};
   return generation;
  }finally{if(this.inFlight===flight)this.inFlight=undefined;}
 }
 /** 一次媒体授权用的 measure：第一次可复用；Control 回 MEDIA_PROBE_REQUIRED 后的第二次一定重新测。 */
 forAuthorization(session:unknown,measure:Measure=measureMediaNodes):Measure{
  let first=true;
  return async(api,signal)=>{
   if(first){first=false;const hit=this.cached(session);if(hit)return hit;}
   else this.forget();
   return this.measure(session,api,signal,measure);
  };
 }
 /** 有可能马上要通话时（来电振铃、拨号盘）提前测；已有有效结果或正在测时什么都不做。失败只是没有缓存。 */
 prewarm(session:unknown,api:ProbeAPI,measure:Measure=measureMediaNodes):Promise<void>{
  const running=this.inFlight;
  if(this.cached(session)||(running&&running.session===session&&running.epoch===this.epoch()))return Promise.resolve();
  return this.measure(session,api,new AbortController().signal,measure).then(()=>undefined,()=>undefined);
 }
}

let shared:MediaProbeCache|undefined;
/** 本页共用的测节点缓存（首次使用时开始监听换网）。 */
export function mediaProbeCache():MediaProbeCache{
 if(!shared){watchNetworkEpoch();shared=new MediaProbeCache();}
 return shared;
}
