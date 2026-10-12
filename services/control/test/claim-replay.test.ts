import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';

// S105: the watch claims through its iPhone's session; a replayed claim never rewrites who answered.
const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s105-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3405,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s105-test-media-secret-at-least-32-chars',TURN_SECRET:'s105-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false};
let db:Db,app:FastifyInstance;
const password='correct horse battery staple';
const auth=(token:string)=>({authorization:`Bearer ${token}`});

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

async function ringingCall(label:string){
  const email=`${label}@example.test`;
  const userId=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[email,await hashPassword(password)])).rows[0].id;
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'ios'}});
  assert.equal(login.statusCode,200,login.body);
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id`,[g.id,userId,`${label} SIM`,tokenHash(`${label}-fingerprint`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  const deviceToken=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(deviceToken),label]);
  const r=await app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(deviceToken),
    payload:{eventId:crypto.randomUUID(),generation:Number(g.device_epoch),deviceCallId:`${label}-device`,simId:sim.id,remoteNumber:'+15550100',observedAt:new Date().toISOString()}});
  assert.equal(r.statusCode<300,true,r.body);
  return {token:login.json().token as string,callId:r.json().call.id as string};
}
const claim=(token:string,callId:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:`/api/v1/calls/${callId}/claim`,headers:auth(token),payload});

test('S105: a replayed claim from the same session returns the stored answerer and rewrites nothing',async()=>{
  const {token,callId}=await ringingCall('s105-replay');
  const first=await claim(token,callId,{platform:'watchos',deviceName:'Apple Watch'});
  assert.equal(first.statusCode,200,first.body);assert.equal(first.json().call.answeredByDevice,'Apple Watch');
  const stored=(await db.query('SELECT answered_by_platform,answered_by_device,claimed_by_session_id FROM call_records WHERE id=$1',[callId])).rows[0];
  const second=await claim(token,callId,{platform:'ios',deviceName:'iPhone'});
  assert.equal(second.statusCode,200,second.body);
  assert.equal(second.json().call.answeredByDevice,'Apple Watch');assert.equal(second.json().call.claimedByCurrentSession,true);
  assert.deepEqual((await db.query('SELECT answered_by_platform,answered_by_device,claimed_by_session_id FROM call_records WHERE id=$1',[callId])).rows[0],stored);
  assert.equal(Number((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1 AND kind='answer'`,[callId])).rows[0].n),1,'the replay queues no second answer');
});

test('S105: claim accepts watchos and still rejects a platform outside the enum',async()=>{
  const {token,callId}=await ringingCall('s105-enum');
  const bad=await claim(token,callId,{platform:'tvos'});
  assert.equal(bad.statusCode,400,bad.body);
  assert.equal((await db.query('SELECT state FROM call_records WHERE id=$1',[callId])).rows[0].state,'incoming_ringing');
  assert.equal((await claim(token,callId,{platform:'watchos'})).statusCode,200);
});

async function outboundFixture(label:string,platform:'ios'|'android'){
  const email=`${label}@example.test`;
  const userId=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[email,await hashPassword(password)])).rows[0].id;
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform}});
  assert.equal(login.statusCode,200,login.body);
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id`,[g.id,userId,`${label} SIM`,tokenHash(`${label}-fingerprint`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,$3,0,0,false,'[]',now())`,[g.id,g.device_epoch,crypto.randomUUID()]);
  return {token:login.json().token as string,simId:sim.id as string};
}
const dial=(token:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/v1/calls/outbound',
  headers:{...auth(token),'idempotency-key':crypto.randomUUID()},payload:{remoteNumber:'+15550123',...payload}});
const storedPlatform=async(callId:string)=>(await db.query('SELECT originating_platform FROM call_records WHERE id=$1',[callId])).rows[0].originating_platform;

test('S105: outbound from an ios session may be labelled watchos and nothing else',async()=>{
  const ios=await outboundFixture('s105-out-watch','ios');
  const watch=await dial(ios.token,{simId:ios.simId,platform:'watchos'});
  assert.equal(watch.statusCode,202,watch.body);
  assert.equal(watch.json().call.originatingPlatform,'watchos');
  assert.equal(await storedPlatform(watch.json().call.id),'watchos');

  const bad=await dial(ios.token,{simId:ios.simId,platform:'android'});
  assert.equal(bad.statusCode,400,bad.body);

  const plainIos=await outboundFixture('s105-out-ios','ios');
  const plain=await dial(plainIos.token,{simId:plainIos.simId});
  assert.equal(plain.statusCode,202,plain.body);
  assert.equal(plain.json().call.originatingPlatform,'ios');
  assert.equal(await storedPlatform(plain.json().call.id),'ios');

  const android=await outboundFixture('s105-out-android','android');
  const spoof=await dial(android.token,{simId:android.simId,platform:'watchos'});
  assert.equal(spoof.statusCode,400,spoof.body);
  assert.equal(Number((await db.query(`SELECT count(*)::int n FROM call_records c JOIN sims s ON s.id=c.sim_id WHERE s.id=$1`,[android.simId])).rows[0].n),0);
});

test('S105: an ios session posts watch diagnostics under X-Diag-Source watchos',async()=>{
  const {token}=await outboundFixture('s105-diag','ios');
  const posted=await app.inject({method:'POST',url:'/api/v1/diag/events',headers:{...auth(token),'x-diag-source':'watchos'},
    payload:[{ts:new Date().toISOString(),level:'info',event:'s105.watch_diag',fields:{leg:'watch'}}]});
  assert.equal(posted.statusCode,200,posted.body);assert.deepEqual(posted.json(),{accepted:1,dropped:0});
  assert.equal((await db.query(`SELECT source FROM diag_events WHERE event='s105.watch_diag'`)).rows[0].source,'watchos');
});
