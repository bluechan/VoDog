import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
export type ApnsResult={status:number;reason?:string};
export type BadgePush={token:string;environment:'development'|'production';badge:number};
export type VoipPush={token:string;environment:'development'|'production';callId:string;notificationId:string;contactName?:string|null;remoteNumber?:string|null;internal?:boolean;peerSimLabel?:string|null;simLabel?:string|null;remoteLocation?:string|null;platform?:string|null};
/** S21 §A: owner-visible text travels bounded and control-character free (name, and since S36 C1 the number). */
const boundedText=(value:unknown)=>{
 if(typeof value!=='string')return null;
 const trimmed=value.replace(/[\x00-\x1f\x7f]/g,'').trim();
 return trimmed?trimmed.slice(0,64):null;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** S104: the watch's own alert push. `answeredBy` = call_records.answered_by_platform, read for call.answered_elsewhere only. */
export type WatchPush={event:'call.incoming'|'call.answered_elsewhere'|'call.missed';callId:string;deliveryId:string;contactName?:string|null;remoteNumber?:string|null;simLabel?:string|null;remoteLocation?:string|null;answeredBy?:string|null};
export class ApnsClient {
 private key:KeyObject;
 private cached?:{jwt:string;created:number};
 /** One HTTP/2 session per origin, reused while open (Apple's guidance); any failure drops it and the next send reconnects. */
 private sessions=new Map<string,{session:ClientHttp2Session;pending:number;ping:NodeJS.Timeout}>();
 private readonly timeoutMs:number;private readonly pingMs:number;
 constructor(private keyId:string,private teamId:string,pem:string,private connector:(url:string)=>ClientHttp2Session=connect,options:{timeoutMs?:number;pingMs?:number}={}){
  this.timeoutMs=options.timeoutMs??8000;this.pingMs=options.pingMs??45_000;
  if(!/^[A-Z0-9]{10}$/.test(keyId)||!/^[A-Z0-9]{10}$/.test(teamId))throw new Error('Invalid APNs identifiers');
  this.key=createPrivateKey(pem);
  if(this.key.asymmetricKeyType!=='ec'||this.key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error('APNs requires a P-256 private key');
 }
 private jwt(){
  const now=Math.floor(Date.now()/1000);
  if(this.cached&&now-this.cached.created<1800)return this.cached.jwt;
  const head=Buffer.from(JSON.stringify({alg:'ES256',kid:this.keyId})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:this.teamId,iat:now})).toString('base64url');
  const unsigned=head+'.'+body;
  const signature=sign('sha256',Buffer.from(unsigned),{key:this.key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const jwt=unsigned+'.'+signature;this.cached={jwt,created:now};return jwt;
 }
 async sendIncoming(push:VoipPush):Promise<ApnsResult>{
  if(!/^[0-9a-f]{32,512}$/i.test(push.token)||!uuid.test(push.callId)||!uuid.test(push.notificationId))throw new Error('Invalid APNs push');
  // Message contents never travel. The contact name (S21 §A) feeds CXCallUpdate.localizedCallerName
  // and the number (S36 C1) its remoteHandle; both are omitted when unknown.
  const contactName=boundedText(push.contactName),remoteNumber=boundedText(push.remoteNumber);
  // S72: an internal call carries `internal` and the calling SIM's label. S81: every call carries the called SIM's label.
  const peerSimLabel=push.internal?boundedText(push.peerSimLabel):null,simLabel=boundedText(push.simLabel);
  // S96: the caller's home location, only when known.
  const remoteLocation=boundedText(push.remoteLocation);
  // S105: the watch's own PushKit token is bound to the watch app's VoIP topic.
  const topic=push.platform==='watchos'?'org.vodog.watchkitapp.voip':'org.vodog.voip';
  return this.post(push.token,push.environment,{'apns-topic':topic,'apns-push-type':'voip','apns-expiration':'0','apns-priority':'10','apns-collapse-id':push.callId,'apns-id':push.notificationId},
   {aps:{'content-available':1},version:1,event:'call.incoming',callId:push.callId,...(contactName?{contactName}:{}),...(remoteNumber?{remoteNumber}:{}),...(simLabel?{simLabel}:{}),...(remoteLocation?{remoteLocation}:{}),...(push.internal?{internal:true,...(peerSimLabel?{peerSimLabel}:{})}:{})});
 }
 /** S67: app-icon badge on the regular (non-VoIP) token; no alert, no sound. */
 async sendBadge(push:BadgePush):Promise<ApnsResult>{
  if(!/^[0-9a-f]{32,512}$/i.test(push.token)||!Number.isInteger(push.badge)||push.badge<0)throw new Error('Invalid APNs badge push');
  return this.post(push.token,push.environment,{'apns-topic':'org.vodog','apns-push-type':'alert','apns-priority':'10','apns-collapse-id':'badge'},{aps:{badge:push.badge}});
 }
 /** S104: a time-sensitive alert on the watch app's own token; the same callId collapses incoming and its end event. */
 async sendWatch(token:string,environment:'development'|'production',push:WatchPush):Promise<ApnsResult>{
  if(!/^[0-9a-f]{32,512}$/i.test(token)||!uuid.test(push.callId)||!uuid.test(push.deliveryId))throw new Error('Invalid APNs watch push');
  const contactName=boundedText(push.contactName),remoteNumber=boundedText(push.remoteNumber),simLabel=boundedText(push.simLabel),remoteLocation=boundedText(push.remoteLocation);
  const title=push.event==='call.incoming'?'来电':push.event==='call.missed'?'未接来电'
   :push.answeredBy==='ios'?'已在 iPhone 接听':push.answeredBy==='ai'?'AI 代接':'已接听';
  const body=[contactName??remoteNumber,simLabel,remoteLocation].filter(Boolean).join(' · ');
  const expiration=push.event==='call.incoming'?String(Math.floor(Date.now()/1000)+45):'0';
  return this.post(token,environment,{'apns-topic':'org.vodog.watchkitapp','apns-push-type':'alert','apns-priority':'10','apns-collapse-id':push.callId,'apns-expiration':expiration,'apns-id':push.deliveryId},
   {aps:{alert:{title,body},category:push.event==='call.incoming'?'INCOMING_CALL':'CALL_ENDED','thread-id':push.callId,
    // Ringing breaks through Focus; a missed call is a normal alert; answered elsewhere silently replaces the banner.
    ...(push.event==='call.incoming'?{'interruption-level':'time-sensitive',sound:'default'}:push.event==='call.missed'?{'interruption-level':'active',sound:'default'}:{'interruption-level':'passive'})},
    version:1,event:push.event,callId:push.callId,...(remoteNumber?{remoteNumber}:{}),...(contactName?{contactName}:{}),...(simLabel?{simLabel}:{}),...(remoteLocation?{remoteLocation}:{})});
 }
 /** Shutdown: in-flight requests finish, then each session closes. */
 close(){for(const host of [...this.sessions.keys()])this.drop(host,false);}
 private drop(host:string,destroy:boolean,session?:ClientHttp2Session){
  const entry=this.sessions.get(host);if(!entry||(session&&entry.session!==session))return;
  this.sessions.delete(host);clearInterval(entry.ping);
  try{if(destroy)entry.session.destroy();else entry.session.close();}catch{}
 }
 private session(host:string){
  const existing=this.sessions.get(host);
  if(existing&&!existing.session.closed&&!existing.session.destroyed)return existing;
  if(existing)this.drop(host,true);
  const session=this.connector(host);
  // Idle keepalive; a failed ping means the path is dead, so the next send starts a fresh session.
  const ping=setInterval(()=>{try{session.ping(error=>{if(error)this.drop(host,true,session);});}catch{this.drop(host,true,session);}},this.pingMs);ping.unref();
  const entry={session,pending:0,ping};this.sessions.set(host,entry);
  // A permanent listener: an unhandled session `error` would otherwise crash the process.
  session.on('error',()=>this.drop(host,true,session));
  session.on('goaway',()=>this.drop(host,false,session));
  session.on('close',()=>this.drop(host,true,session));
  session.unref();
  return entry;
 }
 private post(token:string,environment:'development'|'production',headers:Record<string,string>,payload:unknown):Promise<ApnsResult>{
  const host=environment==='development'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
  return new Promise((resolve,reject)=>{
   let entry:ReturnType<ApnsClient['session']>;
   try{entry=this.session(host);}catch{reject(new Error('APNs connection failed'));return;}
   const {session}=entry;let settled=false;let response='';let status=0;let request:ClientHttp2Stream|undefined;
   // Any failure retires the session so the next send reconnects: gracefully (other pushes in flight
   // finish), or destroyed outright when the request timed out on it.
   const finish=(error?:Error,destroy=false)=>{if(settled)return;settled=true;clearTimeout(timeout);
    if(--entry.pending===0&&!session.destroyed)session.unref();
    if(error){try{request?.close(constants.NGHTTP2_CANCEL);}catch{}this.drop(host,destroy,session);reject(new Error('APNs connection failed'));}
    else {let reason:string|undefined;try{const value=JSON.parse(response);if(typeof value.reason==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value.reason))reason=value.reason;}catch{}resolve({status,reason});}};
   entry.pending++;session.ref();
   const timeout=setTimeout(()=>finish(new Error('timeout'),true),this.timeoutMs);timeout.unref();
   try{request=session.request({':method':'POST',':path':'/3/device/'+token,'authorization':'bearer '+this.jwt(),...headers,'content-type':'application/json'});}
   catch(error){finish(error as Error,true);return;}
   request.on('response',headers=>{status=Number(headers[':status']);});
   request.setEncoding('utf8');request.on('data',chunk=>{response+=chunk;if(response.length>4096)finish(new Error('oversized response'));});
   // A destroyed session destroys its streams, so `close` without `end` covers connection loss too.
   request.once('error',error=>finish(error));request.once('end',()=>finish());request.once('close',()=>finish(new Error('stream closed')));
   request.end(JSON.stringify(payload));
  });
 }
}
