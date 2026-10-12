import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type {Db} from '../src/db.js';
import {registerPushRoutes} from '../src/push-routes.js';
import {WatchPushWorker} from '../src/watch-push-worker.js';
import {PushWorker} from '../src/push-worker.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl)throw new Error('TEST_DATABASE_URL must point to an isolated PostgreSQL database');
const schema='watchos_push_'+crypto.randomBytes(8).toString('hex');
const admin=new pg.Pool({connectionString:databaseUrl,max:2});
const db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:5}) as Db;
let app=Fastify(),user:string,iosSession:string,androidSession:string;

before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  user=(await db.query("INSERT INTO users(email,password_hash)VALUES('watch-one@example.test','x')RETURNING id")).rows[0].id;
  const session=(platform:string,hash:string)=>db.query("INSERT INTO sessions(user_id,access_hash,client_type,platform,access_expires_at,refresh_expires_at)VALUES($1,$2,'native',$3,now()+interval '1 hour',now()+interval '1 day')RETURNING id",[user,hash,platform]).then(r=>r.rows[0].id);
  iosSession=await session('ios','w-ios');androidSession=await session('android','w-android');
  registerPushRoutes(app,db,request=>({userId:String(request.headers['x-user']),sessionId:String(request.headers['x-session']),platform:String(request.headers['x-platform'])}));
  await app.ready();
});
after(async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
const ios=()=>({'x-user':user,'x-session':iosSession,'x-platform':'ios'});
const watchBody=(apnsToken=crypto.randomBytes(32).toString('hex'))=>({platform:'watchos',bundleId:'org.vodog.watchkitapp',environment:'development',deviceName:'Apple Watch',apnsToken});
const register=async(installationId=crypto.randomUUID())=>{
  const body=watchBody();const res=await app.inject({method:'PUT',url:`/api/v1/push/registrations/${installationId}`,headers:ios(),payload:body});
  assert.equal(res.statusCode,200,res.body);return {installationId,token:body.apnsToken,registration:res.json().registration};
};

test('an iOS session registers the watch; android and macos are rejected; the shape constraint holds',async()=>{
  const {installationId,token,registration}=await register();
  assert.deepEqual(Object.keys(registration).sort(),['apnsEnabled','id','installationId','updatedAt','voipEnabled']);assert.equal(registration.apnsEnabled,true);assert.equal(registration.voipEnabled,false);
  const row=(await db.query('SELECT platform,environment,package_name,apns_token,voip_token,fcm_token,session_id FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0];
  assert.deepEqual(row,{platform:'watchos',environment:'development',package_name:null,apns_token:token,voip_token:null,fcm_token:null,session_id:iosSession});
  // Same token under another installation moves: the old row loses it.
  const moved=crypto.randomUUID();assert.equal((await app.inject({method:'PUT',url:`/api/v1/push/registrations/${moved}`,headers:ios(),payload:watchBody(token)})).statusCode,200);
  assert.equal((await db.query('SELECT apns_token FROM push_registrations WHERE installation_id=$1',[installationId])).rows[0].apns_token,null);
  const fromAndroid=await app.inject({method:'PUT',url:`/api/v1/push/registrations/${crypto.randomUUID()}`,headers:{'x-user':user,'x-session':androidSession,'x-platform':'android'},payload:watchBody()});
  assert.equal(fromAndroid.statusCode,403);assert.equal(fromAndroid.json().error.code,'PLATFORM_MISMATCH');
  const macosId=crypto.randomUUID();
  const macos=await app.inject({method:'PUT',url:`/api/v1/push/registrations/${macosId}`,headers:{'x-user':user,'x-session':iosSession,'x-platform':'macos'},payload:{...watchBody(),platform:'macos'}});
  assert.notEqual(macos.statusCode,200);assert.equal((await db.query('SELECT 1 FROM push_registrations WHERE installation_id=$1',[macosId])).rowCount,0);
  const wrongBundle=await app.inject({method:'PUT',url:`/api/v1/push/registrations/${crypto.randomUUID()}`,headers:ios(),payload:{...watchBody(),bundleId:'org.vodog'}});assert.notEqual(wrongBundle.statusCode,200);
  // S105: the watch's own VoIP token is stored; a later PUT without it keeps it; it moves between installations like iOS.
  const voipId=crypto.randomUUID(),voip='b'.repeat(64);
  const withVoip=await app.inject({method:'PUT',url:`/api/v1/push/registrations/${voipId}`,headers:ios(),payload:{...watchBody(),voipToken:voip.toUpperCase()}});
  assert.equal(withVoip.statusCode,200,withVoip.body);assert.equal(withVoip.json().registration.voipEnabled,true);
  const voipOf=async(id:string)=>(await db.query('SELECT voip_token FROM push_registrations WHERE installation_id=$1',[id])).rows[0].voip_token;
  assert.equal(await voipOf(voipId),voip);
  assert.equal((await app.inject({method:'PUT',url:`/api/v1/push/registrations/${voipId}`,headers:ios(),payload:watchBody()})).statusCode,200);assert.equal(await voipOf(voipId),voip);
  const voipMoved=crypto.randomUUID();assert.equal((await app.inject({method:'PUT',url:`/api/v1/push/registrations/${voipMoved}`,headers:ios(),payload:{...watchBody(),voipToken:voip}})).statusCode,200);
  assert.equal(await voipOf(voipId),null);assert.equal(await voipOf(voipMoved),voip);
  assert.equal((await app.inject({method:'PUT',url:`/api/v1/push/registrations/${crypto.randomUUID()}`,headers:ios(),payload:{...watchBody(),voipToken:'xyz'}})).statusCode!==200,true);
  // A watch row with a VoIP token now satisfies the shape constraint.
  await db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,device_name,apns_token,voip_token)VALUES($1,$2,$3,'watchos','development','w',$4,$5)`,
    [crypto.randomUUID(),user,iosSession,'e'.repeat(64),'c'.repeat(64)]);
  // The one place a raw write is right: the constraint itself must reject an off-shape watch row.
  for(const [env,voip,pkg] of [[null,null,null],['development',null,'org.vodog']] as const)
    await assert.rejects(db.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,package_name,device_name,apns_token,voip_token)VALUES($1,$2,$3,'watchos',$4,$5,'w',$6,$7)`,
      [crypto.randomUUID(),user,iosSession,env,pkg,'d'.repeat(64),voip]),/push_registrations_platform_shape/);
});

async function ringing(label:string,overrides:{internal?:boolean}={}){
  const gateway=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,media_ready,last_seen_at)VALUES($1,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query("INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present)VALUES($1,0,$2,$3,true)RETURNING id",[gateway.id,user,label])).rows[0];
  return (await db.query("INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,remote_number,internal_call)VALUES($1,$2,$3,'incoming','incoming_ringing',$4,'normal','+8613800001234',$5)RETURNING id",[gateway.id,sim.id,user,gateway.device_epoch,overrides.internal??false])).rows[0].id as string;
}
const reset=async()=>{await db.query('UPDATE push_registrations SET disabled_at=now(),apns_token=NULL,voip_token=NULL');await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE state='incoming_ringing'");};
const recorder=(status=200,reason?:string)=>{const sent:any[]=[];return {sent,sender:{sendWatch:async(token:string,environment:string,push:any)=>{sent.push({token,environment,...push});return {status,reason};}}};};

test('incoming is pushed once with the call fields, then answered elsewhere carries who answered',async()=>{
  await reset();const {token}=await register();const call=await ringing('联通186');const {sent,sender}=recorder();
  const worker=new WatchPushWorker(db,sender,{enabled:true});
  assert.equal(await worker.tickOnce(),1);await worker.tickOnce();assert.equal(sent.length,1);
  assert.equal(sent[0].event,'call.incoming');assert.equal(sent[0].callId,call);assert.equal(sent[0].token,token);assert.equal(sent[0].environment,'development');
  assert.equal(sent[0].remoteNumber,'+8613800001234');assert.equal(sent[0].simLabel,'联通186');
  const incomingId=(await db.query("SELECT id FROM watchos_push_deliveries WHERE call_id=$1 AND event='call.incoming'",[call])).rows[0].id;assert.equal(sent[0].deliveryId,incomingId);
  await db.query("UPDATE call_records SET state='active',answered_at=now(),answered_by_platform='ios' WHERE id=$1",[call]);
  await worker.tickOnce();assert.equal(sent.length,2);assert.equal(sent[1].event,'call.answered_elsewhere');assert.equal(sent[1].answeredBy,'ios');assert.notEqual(sent[1].deliveryId,incomingId);
  await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1",[call]);
  await worker.tickOnce();assert.equal(sent.length,2,'an answered call never also reports missed');
});

test('a missed call ends as call.missed; a blocked one only cancels; internal calls never reach the watch',async()=>{
  await reset();await register();const {sent,sender}=recorder();const worker=new WatchPushWorker(db,sender,{enabled:true});
  const missed=await ringing('missed');await worker.tickOnce();
  await db.query("UPDATE call_records SET state='ended',ended_at=now() WHERE id=$1",[missed]);await worker.tickOnce();
  assert.deepEqual(sent.map(p=>p.event),['call.incoming','call.missed']);
  const blocked=await ringing('blocked');await worker.tickOnce();
  await db.query("UPDATE call_records SET state='failed',ended_at=now(),failure_reason='number_blocked' WHERE id=$1",[blocked]);await worker.tickOnce();
  assert.deepEqual(sent.filter(p=>p.callId===blocked).map(p=>p.event),['call.incoming']);
  const internal=await ringing('internal',{internal:true});await worker.tickOnce();
  assert.equal(sent.some(p=>p.callId===internal),false);assert.equal((await db.query('SELECT 1 FROM watchos_push_deliveries WHERE call_id=$1',[internal])).rowCount,0);
});

test('flag off sends nothing even when kicked; DELETE stops enqueue; 410 clears the token; 5xx retries at most 3 times',async()=>{
  await reset();await register();const {sent,sender}=recorder();
  const off=new WatchPushWorker(db,sender,{enabled:false});const offCall=await ringing('flag-off');assert.equal(await off.tickOnce(),0);off.start();await off.stop();
  assert.equal(sent.length,0);assert.equal((await db.query('SELECT 1 FROM watchos_push_deliveries WHERE call_id=$1',[offCall])).rowCount,0);
  await reset();
  const deleted=await register();assert.equal((await app.inject({method:'DELETE',url:`/api/v1/push/registrations/${deleted.installationId}`,headers:ios()})).statusCode,204);
  const after=await ringing('deleted');await new WatchPushWorker(db,sender,{enabled:true}).tickOnce();
  assert.equal(sent.length,0);assert.equal((await db.query('SELECT 1 FROM watchos_push_deliveries WHERE call_id=$1',[after])).rowCount,0);
  await reset();const gone=await register();await ringing('gone');const rejected=recorder(410,'Unregistered');
  await new WatchPushWorker(db,rejected.sender,{enabled:true}).tickOnce();assert.equal(rejected.sent.length,1);
  assert.equal((await db.query('SELECT apns_token FROM push_registrations WHERE installation_id=$1',[gone.installationId])).rows[0].apns_token,null);
  await reset();await register();const busy=recorder(503,'ServiceUnavailable');const worker=new WatchPushWorker(db,busy.sender,{enabled:true});const call=await ringing('retry');
  for(let i=0;i<4;i++){await worker.tickOnce();await db.query("UPDATE watchos_push_deliveries SET updated_at=now()-interval '1 minute' WHERE call_id=$1",[call]);}
  assert.equal(busy.sent.length,3);
  assert.deepEqual((await db.query("SELECT state,attempts FROM watchos_push_deliveries WHERE call_id=$1",[call])).rows,[{state:'failed',attempts:3}]);
});

test('S105: a watch with a VoIP token rings by VoIP on the watch topic and gets no incoming alert; a plain watch still does',async()=>{
  await reset();
  const iosVoip=crypto.randomBytes(32).toString('hex'),watchVoip=crypto.randomBytes(32).toString('hex');
  // Production shape: the iPhone and its watch share one session.
  assert.equal((await app.inject({method:'PUT',url:`/api/v1/push/registrations/${crypto.randomUUID()}`,headers:ios(),
    payload:{platform:'ios',bundleId:'org.vodog',environment:'development',deviceName:'iPhone',voipToken:iosVoip}})).statusCode,200);
  const watchId=crypto.randomUUID();
  assert.equal((await app.inject({method:'PUT',url:`/api/v1/push/registrations/${watchId}`,headers:ios(),payload:{...watchBody(),voipToken:watchVoip}})).statusCode,200);
  const plain=await register();
  const call=await ringing('voip-watch');
  const voipSent:any[]=[];const pushWorker=new PushWorker(db,{sendIncoming:async(push:any)=>{voipSent.push(push);return {status:200};}});
  await pushWorker.tick();
  assert.deepEqual(voipSent.map(p=>[p.platform,p.token]).sort(),[['ios',iosVoip],['watchos',watchVoip]].sort());
  assert.ok(voipSent.every(p=>p.callId===call));
  const {sent,sender}=recorder();const worker=new WatchPushWorker(db,sender,{enabled:true});
  assert.equal(await worker.tickOnce(),1);
  assert.deepEqual(sent.map(p=>[p.event,p.token]),[['call.incoming',plain.token]]);
  const watchReg=(await db.query('SELECT id FROM push_registrations WHERE installation_id=$1',[watchId])).rows[0].id;
  assert.equal((await db.query('SELECT 1 FROM watchos_push_deliveries WHERE registration_id=$1',[watchReg])).rowCount,0);
});
