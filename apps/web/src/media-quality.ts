/** Numeric audio counters only: never retain SDP, candidates, addresses or credentials. */
export type AudioQualitySample={elapsedMs:number;inbound:Record<string,number>[]};
const fields=['packetsReceived','packetsLost','jitter','concealedSamples','silentConcealedSamples','concealmentEvents','totalSamplesReceived','jitterBufferDelay','jitterBufferEmittedCount','bytesReceived'] as const;
export function audioQualitySample(report:RTCStatsReport,elapsedMs:number):AudioQualitySample{
 const inbound:Record<string,number>[]=[];
 report.forEach(stat=>{
  if(stat.type!=='inbound-rtp'||(stat.kind??stat.mediaType)!=='audio')return;
  const counters:Record<string,number>={};
  for(const key of fields)if(typeof stat[key]==='number'&&Number.isFinite(stat[key]))counters[key]=stat[key];
  inbound.push(counters);
 });
 return {elapsedMs:Math.max(0,Math.round(elapsedMs)),inbound};
}
const num=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const ms=(seconds:number)=>Math.round(seconds*1000*10)/10;
const CANDIDATE_TYPES=new Set(['host','srflx','prflx','relay']);
/**
 * P3 诊断：`rttMs` 取选中候选对的 currentRoundTripTime；`txRemote` 是对端（桥）对我方发送的回报（remote-inbound-rtp）；
 * `localCandidateType`/`remoteCandidateType` 只是候选类型枚举（host/srflx/prflx/relay），不含地址。
 */
export type AudioRxTx={rx:Record<string,number>;tx:Record<string,number>;rttMs?:number;txRemote?:Record<string,number>;localCandidateType?:string;remoteCandidateType?:string};
/** 选中的候选对：transport.selectedCandidatePairId，其次 Firefox 的 `selected`，最后已提名的对。 */
function selectedPair(report:RTCStatsReport):Record<string,unknown>|undefined{
 let selectedId:unknown,flagged:Record<string,unknown>|undefined,nominated:Record<string,unknown>|undefined;
 report.forEach(stat=>{
  if(stat.type==='transport'&&typeof stat.selectedCandidatePairId==='string')selectedId??=stat.selectedCandidatePairId;
  if(stat.type==='candidate-pair'){if(stat.selected===true)flagged??=stat;if(stat.nominated)nominated??=stat;}
 });
 return (typeof selectedId==='string'?report.get(selectedId) as Record<string,unknown>|undefined:undefined)??flagged??nominated;
}
/** S70：通话接收/发送质量计数（inbound-rtp / outbound-rtp audio），进 30 s `media.stats` 与通话结束 `media.summary`。 */
export function audioRxTx(report:RTCStatsReport):AudioRxTx{
 const rx:Record<string,number>={},tx:Record<string,number>={},txRemote:Record<string,number>={};
 report.forEach(stat=>{
  if((stat.kind??stat.mediaType)!=='audio')return;
  if(stat.type==='remote-inbound-rtp'){
   if(num(stat.fractionLost))txRemote.fractionLost=stat.fractionLost;
   if(num(stat.roundTripTime))txRemote.roundTripTimeMs=ms(stat.roundTripTime);
   if(num(stat.jitter))txRemote.jitterMs=ms(stat.jitter);
  }
  if(stat.type==='inbound-rtp'){
   for(const key of ['packetsReceived','packetsLost','concealedSamples','silentConcealedSamples','totalSamplesReceived','concealmentEvents','insertedSamplesForDeceleration','removedSamplesForAcceleration'] as const)if(num(stat[key]))rx[key]=stat[key];
   if(num(stat.jitter))rx.jitterMs=Math.round(stat.jitter*1000*10)/10;
   if(num(stat.jitterBufferDelay)&&num(stat.jitterBufferEmittedCount)&&stat.jitterBufferEmittedCount>0)rx.jitterBufferMs=Math.round(stat.jitterBufferDelay/stat.jitterBufferEmittedCount*1000*10)/10;
  }
  if(stat.type==='outbound-rtp')for(const key of ['packetsSent','bytesSent'] as const)if(num(stat[key]))tx[key]=stat[key];
 });
 const result:AudioRxTx={rx,tx};
 const pair=selectedPair(report);
 if(pair){
  if(num(pair.currentRoundTripTime))result.rttMs=ms(pair.currentRoundTripTime);
  for(const [side,key] of [['localCandidateId','localCandidateType'],['remoteCandidateId','remoteCandidateType']] as const){
   const id=pair[side],type=typeof id==='string'?(report.get(id) as {candidateType?:unknown}|undefined)?.candidateType:undefined;
   if(typeof type==='string'&&CANDIDATE_TYPES.has(type))result[key]=type;
  }
 }
 if(Object.keys(txRemote).length)result.txRemote=txRemote;
 return result;
}
/** S36 C3：诊断只留几个数字——够判断一通电话的音频好坏，不留任何地址或凭据。S70 追加 `rx`/`tx`。 */
export function diagAudioStats(report:RTCStatsReport):Record<string,unknown>{
 const stats:Record<string,unknown>=audioRxTx(report);
 report.forEach(stat=>{
  if(stat.type==='inbound-rtp'&&(stat.kind??stat.mediaType)==='audio'){
   for(const key of ['packetsLost','jitter','audioLevel'] as const)if(typeof stat[key]==='number'&&Number.isFinite(stat[key]))stats[key]=stat[key];
  }
  if(stat.type==='candidate-pair'&&stat.nominated&&typeof stat.currentRoundTripTime==='number'&&Number.isFinite(stat.currentRoundTripTime))stats.rtt=stat.currentRoundTripTime;
 });
 return stats;
}
/** One in-flight read, bounded memory, and no late result after disposal. */
export class AudioQualityMonitor{
 private timer?:ReturnType<typeof setInterval>;
 private pending=false;
 private stopped=false;
 private readonly started=performance.now();
 readonly samples:AudioQualitySample[]=[];
 /** S70：最近一次读数的 rx/tx，通话结束时进 `media.summary`（关闭后的 peer 读不到统计）。 */
 lastRxTx?:AudioRxTx;
 private readonly peer:Pick<RTCPeerConnection,'getStats'>;
 private readonly intervalMs:number;
 constructor(peer:Pick<RTCPeerConnection,'getStats'>,intervalMs=2000){this.peer=peer;this.intervalMs=intervalMs;}
 start(){if(this.timer||this.stopped)return;void this.sample();this.timer=setInterval(()=>{void this.sample();},this.intervalMs);}
 async sample(){
  if(this.pending||this.stopped)return;
  this.pending=true;
  try{const report=await this.peer.getStats();if(!this.stopped){this.lastRxTx=audioRxTx(report);this.samples.push(audioQualitySample(report,performance.now()-this.started));if(this.samples.length>180)this.samples.shift();}}
  catch{/* Diagnostics must never interrupt a call. */}
  finally{this.pending=false;}
 }
 stop(){this.stopped=true;clearInterval(this.timer);this.timer=undefined;return this.samples.map(sample=>({elapsedMs:sample.elapsedMs,inbound:sample.inbound.map(row=>({...row}))}));}
}
