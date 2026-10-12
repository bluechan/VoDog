import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect,type ClientHttp2Session,type ServerHttp2Session} from 'node:http2';
import {once} from 'node:events';
import {generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {ApnsClient} from '../src/apns.js';
test('APNs uses ES256, a dedicated VoIP topic and an expiring payload without private call details',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const server=createServer();let received:any;let auth='';
 server.on('stream',(stream,headers)=>{auth=String(headers.authorization);let raw='';stream.setEncoding('utf8');stream.on('data',chunk=>raw+=chunk);stream.on('end',()=>{received={headers,body:JSON.parse(raw)};stream.respond({':status':200});stream.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 let client:ApnsClient|undefined;
 try {
  const address=server.address();assert.ok(address&&typeof address==='object');
  client=new ApnsClient('TESTKEY001','TESTTEAM01',pem,url=>{assert.equal(url,'https://api.sandbox.push.apple.com');return connect('http://127.0.0.1:'+address.port);});
  const result=await client.sendIncoming({token:'a'.repeat(64),environment:'development',callId:'11111111-1111-4111-8111-111111111111',notificationId:'22222222-2222-4222-8222-222222222222'});assert.equal(result.status,200);
  assert.equal(received.headers['apns-topic'],'org.vodog.voip');assert.equal(received.headers['apns-expiration'],'0');assert.equal(received.headers['apns-push-type'],'voip');assert.equal(received.body.remoteNumber,undefined);
  const [head,body,sig]=auth.slice(7).split('.');assert.equal(JSON.parse(Buffer.from(head!,'base64url').toString()).alg,'ES256');assert.equal(JSON.parse(Buffer.from(body!,'base64url').toString()).iss,'TESTTEAM01');
  assert.equal(verify('sha256',Buffer.from(head+'.'+body),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig!,'base64url')),true);
  assert.deepEqual(Object.keys(received.body).sort(),['aps','callId','event','version'],'no contact name or SIM label means no optional key');
  const iosBody=received.body;
  // S105: the watch's own PushKit token goes to the watch app's VoIP topic; headers and payload otherwise identical.
  assert.equal((await client.sendIncoming({token:'b'.repeat(64),environment:'development',callId:'11111111-1111-4111-8111-111111111111',notificationId:'33333333-3333-4333-8333-333333333333',platform:'watchos'})).status,200);
  assert.equal(received.headers['apns-topic'],'org.vodog.watchkitapp.voip');assert.equal(received.headers['apns-push-type'],'voip');
  assert.equal(received.headers['apns-expiration'],'0');assert.equal(received.headers['apns-priority'],'10');assert.equal(received.headers['apns-collapse-id'],'11111111-1111-4111-8111-111111111111');
  assert.deepEqual(received.body,iosBody);
  await client.sendIncoming({token:'b'.repeat(64),environment:'development',callId:'11111111-1111-4111-8111-111111111111',notificationId:'44444444-4444-4444-8444-444444444444',platform:'ios'});
  assert.equal(received.headers['apns-topic'],'org.vodog.voip');
 } finally {client?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('the VoIP payload carries the contact name, number and called SIM label at the top level and adds no other key',async()=>{
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const server=createServer();let received:any;
 server.on('stream',(stream)=>{let raw='';stream.setEncoding('utf8');stream.on('data',chunk=>raw+=chunk);stream.on('end',()=>{received=JSON.parse(raw);stream.respond({':status':200});stream.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 let client:ApnsClient|undefined;
 try {
  const address=server.address();assert.ok(address&&typeof address==='object');
  client=new ApnsClient('TESTKEY001','TESTTEAM01',pem,()=>connect('http://127.0.0.1:'+address.port));
  const push={token:'a'.repeat(64),environment:'development' as const,callId:'11111111-1111-4111-8111-111111111111',notificationId:'22222222-2222-4222-8222-222222222222'};
  await client.sendIncoming({...push,contactName:'  张三\n  ',remoteNumber:' +15551234567\n',simLabel:' Test SIM A\n'});
  // iOS reads `contactName` from the payload top level for CXCallUpdate.localizedCallerName and,
  // since S36 C1, `remoteNumber` for its remoteHandle.
  assert.deepEqual(Object.keys(received).sort(),['aps','callId','contactName','event','remoteNumber','simLabel','version']);
  assert.equal(received.simLabel,'Test SIM A','S81: an ordinary call carries the called SIM label, bounded and trimmed');
  assert.equal(received.contactName,'张三','control characters stripped and trimmed');
  assert.equal(received.remoteNumber,'+15551234567','the number is bounded and trimmed the same way');
  await client.sendIncoming({...push,contactName:'   ',remoteNumber:null,simLabel:null});
  assert.equal('simLabel' in received,false,'no SIM label means no key');
  assert.equal('contactName' in received,false,'a blank name is omitted rather than sent empty');
  assert.equal('remoteNumber' in received,false,'an unknown number is omitted rather than sent empty');
 } finally {client?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('S96: the VoIP payload carries remoteLocation only when known, bounded like the other text',async()=>{
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const server=createServer();let received:any;
 server.on('stream',(stream)=>{let raw='';stream.setEncoding('utf8');stream.on('data',chunk=>raw+=chunk);stream.on('end',()=>{received=JSON.parse(raw);stream.respond({':status':200});stream.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 let client:ApnsClient|undefined;
 try {
  const address=server.address();assert.ok(address&&typeof address==='object');
  client=new ApnsClient('TESTKEY001','TESTTEAM01',pem,()=>connect('http://127.0.0.1:'+address.port));
  const push={token:'a'.repeat(64),environment:'development' as const,callId:'11111111-1111-4111-8111-111111111111',notificationId:'22222222-2222-4222-8222-222222222222'};
  await client.sendIncoming({...push,remoteNumber:'+8613800001234',remoteLocation:' 广东 深圳 · 移动\n'});
  assert.deepEqual(Object.keys(received).sort(),['aps','callId','event','remoteLocation','remoteNumber','version']);
  assert.equal(received.remoteLocation,'广东 深圳 · 移动');
  await client.sendIncoming({...push,remoteNumber:'+8613800001234',remoteLocation:null});
  assert.deepEqual(Object.keys(received).sort(),['aps','callId','event','remoteNumber','version'],'no location means no key');
  await client.sendIncoming({...push,remoteLocation:'   '});
  assert.equal('remoteLocation' in received,false,'a blank location is omitted');
 } finally {client?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

// One HTTP/2 session per origin, reused across sends and push types, retired on any failure.
async function pooledFixture(respond:(n:number)=>boolean=()=>true){
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const server=createServer(),serverSessions:ServerHttp2Session[]=[],clientSessions:ClientHttp2Session[]=[];let streams=0;
 server.on('session',session=>serverSessions.push(session));
 server.on('stream',stream=>{const n=++streams;stream.resume();stream.on('end',()=>{if(!respond(n))return;stream.respond({':status':200});stream.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const connector=()=>{const session=connect('http://127.0.0.1:'+address.port);clientSessions.push(session);return session;};
 return {pem,server,serverSessions,clientSessions,connector,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
const pooledPush=()=>({token:'a'.repeat(64),environment:'development' as const,callId:'11111111-1111-4111-8111-111111111111',notificationId:randomUUID()});

test('APNs keeps one HTTP/2 session per origin: sequential, concurrent, badge and VoIP sends share it',async()=>{
 const f=await pooledFixture();const client=new ApnsClient('TESTKEY001','TESTTEAM01',f.pem,f.connector);
 try {
  assert.equal((await client.sendIncoming(pooledPush())).status,200);
  assert.equal((await client.sendIncoming(pooledPush())).status,200);
  assert.equal((await client.sendBadge({token:'b'.repeat(64),environment:'development',badge:2})).status,200);
  const both=await Promise.all([client.sendIncoming(pooledPush()),client.sendBadge({token:'b'.repeat(64),environment:'development',badge:3})]);
  assert.deepEqual(both.map(r=>r.status),[200,200]);
  assert.equal(f.clientSessions.length,1,'every send rode the first session');assert.equal(f.serverSessions.length,1);
 } finally {client.close();await f.close();}
});

test('APNs reconnects on the next send after the server sends GOAWAY or drops the connection',async()=>{
 const f=await pooledFixture();const client=new ApnsClient('TESTKEY001','TESTTEAM01',f.pem,f.connector);
 try {
  assert.equal((await client.sendIncoming(pooledPush())).status,200);
  const goneAway=once(f.clientSessions[0]!,'close');f.serverSessions[0]!.close();await goneAway;
  assert.equal((await client.sendIncoming(pooledPush())).status,200);
  assert.equal(f.clientSessions.length,2,'a GOAWAY retires the session and the next send reconnects');
  const dropped=once(f.clientSessions[1]!,'close');f.serverSessions[1]!.destroy();await dropped;
  assert.equal((await client.sendBadge({token:'b'.repeat(64),environment:'development',badge:1})).status,200);
  assert.equal(f.clientSessions.length,3,'a dropped connection is replaced too');
 } finally {client.close();await f.close();}
});

test('an APNs request timeout destroys its session and the next send starts a fresh one',async()=>{
 const f=await pooledFixture(n=>n!==1);const client=new ApnsClient('TESTKEY001','TESTTEAM01',f.pem,f.connector,{timeoutMs:150});
 try {
  const startedAt=Date.now();
  await assert.rejects(client.sendIncoming(pooledPush()),/APNs connection failed/);
  assert.ok(Date.now()-startedAt<2000,'the per-request timeout fired');
  assert.equal(f.clientSessions[0]!.destroyed,true,'the stuck session is destroyed, not reused');
  assert.equal((await client.sendIncoming(pooledPush())).status,200);
  assert.equal(f.clientSessions.length,2);
 } finally {client.close();await f.close();}
});

test('S104: watch alerts use the watchkitapp topic, alert headers and a collapsing, expiring incoming payload',async()=>{
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const server=createServer();let received:any;
 server.on('stream',(stream,headers)=>{let raw='';stream.setEncoding('utf8');stream.on('data',chunk=>raw+=chunk);stream.on('end',()=>{received={headers,body:JSON.parse(raw)};stream.respond({':status':200});stream.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 let client:ApnsClient|undefined;
 try {
  const address=server.address();assert.ok(address&&typeof address==='object');
  client=new ApnsClient('TESTKEY001','TESTTEAM01',pem,url=>{assert.equal(url,'https://api.push.apple.com');return connect('http://127.0.0.1:'+address.port);});
  const callId='11111111-1111-4111-8111-111111111111',deliveryId='33333333-3333-4333-8333-333333333333';
  const before=Math.floor(Date.now()/1000);
  await client.sendWatch('a'.repeat(64),'production',{event:'call.incoming',callId,deliveryId,contactName:' 张伟\n',remoteNumber:'+8613800001234',simLabel:'工作号',remoteLocation:'上海'});
  const h=received.headers;
  assert.equal(h['apns-topic'],'org.vodog.watchkitapp');assert.equal(h['apns-push-type'],'alert');assert.equal(h['apns-priority'],'10');
  assert.equal(h['apns-collapse-id'],callId);assert.equal(h['apns-id'],deliveryId);
  const expiration=Number(h['apns-expiration']);assert.ok(expiration>=before+45&&expiration<=before+47,'incoming expires 45 s out');
  assert.deepEqual(received.body,{aps:{alert:{title:'来电',body:'张伟 · 工作号 · 上海'},category:'INCOMING_CALL','interruption-level':'time-sensitive',sound:'default','thread-id':callId},
   version:1,event:'call.incoming',callId,remoteNumber:'+8613800001234',contactName:'张伟',simLabel:'工作号',remoteLocation:'上海'});
  const titles:Record<string,string>={};
  for(const [event,answeredBy] of [['call.answered_elsewhere','ios'],['call.answered_elsewhere','ai'],['call.answered_elsewhere','web'],['call.missed',null]] as const){
   await client.sendWatch('a'.repeat(64),'production',{event,callId,deliveryId,remoteNumber:'+8613800001234',answeredBy});
   assert.equal(received.headers['apns-expiration'],'0');assert.equal(received.body.aps.category,'CALL_ENDED');assert.equal(received.body.aps.alert.body,'+8613800001234','number stands in for an unknown name');
   assert.equal('contactName' in received.body,false);titles[event+':'+answeredBy]=received.body.aps.alert.title;
   if(event==='call.missed'){assert.equal(received.body.aps['interruption-level'],'active');assert.equal(received.body.aps.sound,'default');}
   else {assert.equal(received.body.aps['interruption-level'],'passive');assert.equal('sound' in received.body.aps,false,'answered elsewhere replaces the banner silently');}
  }
  assert.deepEqual(titles,{'call.answered_elsewhere:ios':'已在 iPhone 接听','call.answered_elsewhere:ai':'AI 代接','call.answered_elsewhere:web':'已接听','call.missed:null':'未接来电'});
  await assert.rejects(client.sendWatch('xyz','production',{event:'call.missed',callId,deliveryId}),/Invalid APNs watch push/);
 } finally {client?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
