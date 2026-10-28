import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { insertContact } from '../src/contacts/repository.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const serviceToken='s137-internal-test-token-at-least-32-characters';
// `buildApp` closes over this object, so the kill-switch test flips it in place.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s137-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3398,
  AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:serviceToken,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s137-test-media-secret-at-least-32-chars',TURN_SECRET:'s137-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  BUSY_CONFLICT_ENABLED:true,PIXEL_ORIGINATED_CALLS_ENABLED:true,PIXEL_ARCHIVE_ENABLED:true,
  SCREENING_APP_AUTO_BLOCK_ENABLED:false,SCREENED_CALL_AI_ANSWER_ENABLED:true,CONTACT_DEFERRED_AI_ENABLED:true};

let db:Db,app:FastifyInstance;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const internal={authorization:`Bearer ${serviceToken}`};
const worker={instanceId:'00000000-0000-4000-8000-000000001370',bootId:'00000000-0000-4000-8000-000000001371'};
const password='correct horse battery staple';
const contactNumber='075500001360';

async function userFixture(label:string){
  const email=`${label}@example.test`;
  const id=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[email,await hashPassword(password)])).rows[0].id as string;
  return {id,email};
}
async function login(email:string){
  const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:email,password,platform:'android'}});
  assert.equal(r.statusCode,200,r.body);
  return r.json().token as string;
}
/** S137 runs on an AI 即接 SIM. */
async function gatewayFixture(ownerUserId:string,label:string){
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)VALUES($1,0,$2,$3,true,$4,'CN')RETURNING id`,[g.id,ownerUserId,`${label} SIM`,tokenHash(`${label}-fingerprint-value`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id,mode)VALUES($1,'ai')`,[sim.id]);
  const token=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(token),label]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,$3,0,0,false,'[]',now())`,[g.id,g.device_epoch,crypto.randomUUID()]);
  return {gatewayId:g.id as string,simId:sim.id as string,deviceEpoch:Number(g.device_epoch),deviceToken:token};
}
type Fixture=Awaited<ReturnType<typeof gatewayFixture>>;
const payloadFor=(f:Fixture,deviceCallId:string,extra:object={})=>({eventId:crypto.randomUUID(),generation:f.deviceEpoch,deviceCallId,simId:f.simId,
  remoteNumber:contactNumber,observedAt:new Date().toISOString(),...extra});
const post=(f:Fixture,payload:object)=>app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(f.deviceToken),payload});
const callRow=async(gatewayId:string)=>(await db.query(`SELECT * FROM call_records WHERE gateway_id=$1`,[gatewayId])).rows[0];
/** Seconds from now to the run's trigger, plus the columns S137 freezes on it. */
const runRow=async(runId:string)=>(await db.query(`SELECT mode_snapshot,greeting_kind,state,
  extract(epoch FROM trigger_at-now())::float8 AS in_seconds FROM ai_call_runs WHERE id=$1`,[runId])).rows[0];
const diagRows=async(callId:string,event:string)=>(await db.query(`SELECT fields AS details FROM diag_events WHERE call_id=$1 AND event=$2`,[callId,event])).rows;
async function liveWorker(){
  const r=await app.inject({method:'POST',url:'/internal/v1/ai/workers/heartbeat',headers:internal,payload:{...worker,protocol:'voice-run-v1',capacity:1}});
  assert.equal(r.statusCode,200,r.body);
}
async function contactFixture(ownerId:string){
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    await insertContact(c,ownerId,{displayName:'Known caller',phones:[{rawNumber:contactNumber}],source:'manual'},'CN');
    await c.query('COMMIT');
  }finally{c.release();}
}
const noWorker=()=>db.query(`UPDATE ai_worker_instances SET expires_at=now()-interval '1 second'`);
/** The undeferred AI 即接 shape, exactly as before S137. */
async function assertInstant(f:Fixture){
  const call=await callRow(f.gatewayId);
  assert.equal(call.mode_snapshot,'ai');
  assert.ok(call.ai_run_id);
  const run=await runRow(call.ai_run_id);
  assert.equal(run.mode_snapshot,'ai');
  assert.ok(run.in_seconds<=0,`trigger_at must be due, was ${run.in_seconds}`);
  assert.equal(run.greeting_kind,null);
  assert.equal((await diagRows(call.id,'call.contact_deferred')).length,0);
  return call;
}
/** diag() is fire-and-forget; give the insert a moment before reading it back. */
const settle=()=>new Promise(resolve=>setTimeout(resolve,150));

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

test('S137 1: a contact calling an AI 即接 SIM rings 15 s first and gets the leave-message greeting',async()=>{
  await liveWorker();
  const owner=await userFixture('s137-defer');
  const f=await gatewayFixture(owner.id,'s137-defer');
  await contactFixture(owner.id);
  const payload=payloadFor(f,'s137:1');
  const first=await post(f,payload);
  assert.equal(first.statusCode,201,first.body);
  assert.equal(first.json().disposition,'offer_to_owner');
  const call=await callRow(f.gatewayId);
  assert.equal(call.mode_snapshot,'timeout_ai');
  assert.equal(call.state,'incoming_ringing');
  assert.equal(call.conflict_disposition,null);
  assert.ok(call.ai_run_id);
  const run=await runRow(call.ai_run_id);
  assert.equal(run.mode_snapshot,'timeout_ai');
  assert.equal(run.greeting_kind,'leave_message');
  assert.ok(Math.abs(run.in_seconds-15)<=2,`trigger_at ≈ now+15 s, was ${run.in_seconds}`);
  await settle();
  const diag=await diagRows(call.id,'call.contact_deferred');
  assert.equal(diag.length,1);
  assert.deepEqual(diag[0].details,{seconds:15,aiScheduled:true,screened:false,simMode:'ai'});
  const replay=await post(f,payload);
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[call.id])).rows[0].n,1);
  await settle();
  assert.equal((await diagRows(call.id,'call.contact_deferred')).length,1);
  const claim=await app.inject({method:'POST',url:'/internal/v1/ai/runs/claim',headers:internal,payload:worker});
  assert.equal(claim.statusCode,200,claim.body);
  assert.equal(claim.json().run.id,call.ai_run_id);
  assert.equal(claim.json().run.greetingKind,'leave_message');
});

test('S137 2: 通讯录用户启用AI即接 on keeps a contact on AI 即接',async()=>{
  await liveWorker();
  const owner=await userFixture('s137-instant');
  const f=await gatewayFixture(owner.id,'s137-instant');
  await contactFixture(owner.id);
  await db.query(`UPDATE users SET contact_instant_ai=true WHERE id=$1`,[owner.id]);
  const r=await post(f,payloadFor(f,'s137:2'));
  assert.equal(r.statusCode,201,r.body);
  await settle();
  await assertInstant(f);
});

test('S137 3: a number outside the address book stays AI 即接',async()=>{
  await liveWorker();
  const owner=await userFixture('s137-stranger');
  const f=await gatewayFixture(owner.id,'s137-stranger');
  const r=await post(f,payloadFor(f,'s137:3'));
  assert.equal(r.statusCode,201,r.body);
  await settle();
  await assertInstant(f);
});

test('S137 4: CONTACT_DEFERRED_AI_ENABLED off is the pre-S137 behaviour',async()=>{
  await liveWorker();
  const owner=await userFixture('s137-off');
  const f=await gatewayFixture(owner.id,'s137-off');
  await contactFixture(owner.id);
  (config as any).CONTACT_DEFERRED_AI_ENABLED=false;
  try{
    const r=await post(f,payloadFor(f,'s137:4'));
    assert.equal(r.statusCode,201,r.body);
    await settle();
    await assertInstant(f);
  }finally{(config as any).CONTACT_DEFERRED_AI_ENABLED=true;}
});

test('S137 5: a screened contact is deferred too, and a human answer clears 拦截转 AI 接听',async()=>{
  await liveWorker();
  const owner=await userFixture('s137-screened');
  const f=await gatewayFixture(owner.id,'s137-screened');
  await db.query(`UPDATE sim_settings SET mode='normal' WHERE sim_id=$1`,[f.simId]);
  await contactFixture(owner.id);
  const r=await post(f,payloadFor(f,'s137:5',{screened:true}));
  assert.equal(r.statusCode,201,r.body);
  let call=await callRow(f.gatewayId);
  assert.equal(call.mode_snapshot,'timeout_ai');
  assert.equal(call.conflict_disposition,'screened_ai');
  const run=await runRow(call.ai_run_id);
  assert.equal(run.mode_snapshot,'timeout_ai');
  assert.equal(run.greeting_kind,'leave_message');
  assert.ok(Math.abs(run.in_seconds-15)<=2,`trigger_at ≈ now+15 s, was ${run.in_seconds}`);
  await settle();
  assert.deepEqual((await diagRows(call.id,'call.contact_deferred'))[0].details,{seconds:15,aiScheduled:true,screened:true,simMode:'normal'});
  assert.equal((await diagRows(call.id,'call.screened')).length,1);
  const token=await login(owner.email);
  const human=await app.inject({method:'POST',url:`/api/v1/calls/${call.id}/claim`,headers:auth(token),payload:{platform:'android',deviceName:'human'}});
  assert.equal(human.statusCode,200,human.body);
  assert.equal((await runRow(call.ai_run_id)).state,'lost_race');
  call=await callRow(f.gatewayId);
  assert.equal(call.conflict_disposition,null);
});

test('S137 6: no live worker leaves a deferred contact call ringing',async()=>{
  await noWorker();
  const owner=await userFixture('s137-noworker');
  const f=await gatewayFixture(owner.id,'s137-noworker');
  await contactFixture(owner.id);
  const r=await post(f,payloadFor(f,'s137:6'));
  assert.equal(r.statusCode,201,r.body);
  assert.equal(r.json().disposition,'offer_to_owner');
  const call=await callRow(f.gatewayId);
  assert.equal(call.state,'incoming_ringing');
  assert.equal(call.mode_snapshot,'timeout_ai');
  assert.equal(call.ai_run_id,null);
  assert.equal(call.conflict_disposition,null);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1`,[call.id])).rows[0].n,0);
  await settle();
  assert.equal((await diagRows(call.id,'call.contact_deferred'))[0].details.aiScheduled,false);
});

test('S137 7: owner-busy pulls a deferred run in to 5 s once, and leaves other runs alone',async()=>{
  await liveWorker();
  const owner=await userFixture('s137-busy');
  const f=await gatewayFixture(owner.id,'s137-busy');
  await contactFixture(owner.id);
  assert.equal((await post(f,payloadFor(f,'s137:7'))).statusCode,201);
  const call=await callRow(f.gatewayId);
  const token=await login(owner.email);
  const busy=()=>app.inject({method:'POST',url:`/api/v1/calls/${call.id}/owner-busy`,headers:auth(token),payload:{}});
  const first=await busy();
  assert.equal(first.statusCode,200,first.body);
  assert.equal(first.json().aiScheduled,true);
  const run=await runRow(call.ai_run_id);
  assert.ok(Math.abs(run.in_seconds-5)<=2,`trigger_at ≈ now+5 s, was ${run.in_seconds}`);
  assert.equal(run.greeting_kind,'leave_message');
  // Same millisecond: the column is written from the JS Date, as createAiRunForIncoming does.
  const synced=(await db.query(`SELECT abs(extract(epoch FROM c.ai_trigger_at-r.trigger_at))<0.001 AS same FROM call_records c JOIN ai_call_runs r ON r.id=c.ai_run_id WHERE c.id=$1`,[call.id])).rows[0];
  assert.equal(synced.same,true);
  const triggerBefore=(await db.query(`SELECT trigger_at FROM ai_call_runs WHERE id=$1`,[call.ai_run_id])).rows[0].trigger_at.getTime();
  const second=await busy();
  assert.equal(second.statusCode,200,second.body);
  assert.equal(second.json().aiScheduled,false);
  assert.equal((await db.query(`SELECT trigger_at FROM ai_call_runs WHERE id=$1`,[call.ai_run_id])).rows[0].trigger_at.getTime(),triggerBefore);
  await settle();
  assert.equal((await diagRows(call.id,'call.owner_busy')).filter(row=>row.details.advanced===true).length,1);
  // An undeferred AI 即接 run is the existing no-op.
  const other=await userFixture('s137-busy-instant');
  const g=await gatewayFixture(other.id,'s137-busy-instant');
  assert.equal((await post(g,payloadFor(g,'s137:7b'))).statusCode,201);
  const instant=await assertInstant(g);
  const otherToken=await login(other.email);
  const noop=await app.inject({method:'POST',url:`/api/v1/calls/${instant.id}/owner-busy`,headers:auth(otherToken),payload:{}});
  assert.equal(noop.statusCode,200,noop.body);
  assert.equal(noop.json().aiScheduled,false);
  assert.ok((await runRow(instant.ai_run_id)).in_seconds<=0);
});

test('S137 8: the account switch is read and written beside the voice provider',async()=>{
  const owner=await userFixture('s137-switch');
  const token=await login(owner.email);
  const get=await app.inject({method:'GET',url:'/api/v1/ai/voice-providers',headers:auth(token)});
  assert.equal(get.statusCode,200,get.body);
  assert.equal(get.json().contactInstantAi,false);
  const put=await app.inject({method:'PUT',url:'/api/v1/ai/contact-instant-ai',headers:auth(token),payload:{enabled:true}});
  assert.equal(put.statusCode,200,put.body);
  assert.equal(put.json().contactInstantAi,true);
  assert.equal(put.json().selected,get.json().selected);
  const audit=(await db.query(`SELECT details FROM audit_events WHERE actor_user_id=$1 AND action='ai.contact_instant_ai.update'`,[owner.id])).rows;
  assert.equal(audit.length,1);
  assert.deepEqual(audit[0].details,{from:false,to:true});
  const bad=await app.inject({method:'PUT',url:'/api/v1/ai/contact-instant-ai',headers:auth(token),payload:{enabled:'yes'}});
  assert.equal(bad.statusCode,400,bad.body);
  const anonymous=await app.inject({method:'PUT',url:'/api/v1/ai/contact-instant-ai',payload:{enabled:false}});
  assert.equal(anonymous.statusCode,401,anonymous.body);
  assert.equal((await db.query(`SELECT contact_instant_ai FROM users WHERE id=$1`,[owner.id])).rows[0].contact_instant_ai,true);
});

test('S137 9: CONTACT_DEFERRED_AI_ENABLED defaults off',()=>{
  const loaded=loadConfig({DATABASE_URL:'postgresql://localhost/vodog_test',COOKIE_SECRET:'s137-config-test-cookie-secret-at-least-32-bytes'});
  assert.equal(loaded.CONTACT_DEFERRED_AI_ENABLED,false);
});
