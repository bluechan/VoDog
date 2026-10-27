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
const serviceToken='s136-internal-test-token-at-least-32-characters';
// `buildApp` closes over this object, so the kill-switch tests flip it in place.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s136-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3399,
  AI_ENABLED:true,AI_WORKER_READY:true,AI_INTERNAL_TOKEN:serviceToken,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s136-test-media-secret-at-least-32-chars',TURN_SECRET:'s136-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  BUSY_CONFLICT_ENABLED:true,PIXEL_ORIGINATED_CALLS_ENABLED:true,PIXEL_ARCHIVE_ENABLED:true,
  SCREENING_APP_AUTO_BLOCK_ENABLED:false,SCREENED_CALL_AI_ANSWER_ENABLED:true};

let db:Db,app:FastifyInstance;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const internal={authorization:`Bearer ${serviceToken}`};
const password='correct horse battery staple';

async function userFixture(label:string){
  const email=`${label}@example.test`;
  const id=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[email,await hashPassword(password)])).rows[0].id as string;
  return {id};
}
async function gatewayFixture(ownerUserId:string,label:string){
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)VALUES($1,0,$2,$3,true,$4,'CN')RETURNING id`,[g.id,ownerUserId,`${label} SIM`,tokenHash(`${label}-fingerprint-value`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id,mode)VALUES($1,'normal')`,[sim.id]);
  const token=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(token),label]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,$3,0,0,false,'[]',now())`,[g.id,g.device_epoch,crypto.randomUUID()]);
  return {gatewayId:g.id as string,simId:sim.id as string,deviceEpoch:Number(g.device_epoch),deviceToken:token};
}
type Fixture=Awaited<ReturnType<typeof gatewayFixture>>;
const payloadFor=(f:Fixture,deviceCallId:string)=>({eventId:crypto.randomUUID(),generation:f.deviceEpoch,deviceCallId,simId:f.simId,
  remoteNumber:'075500001360',observedAt:new Date().toISOString(),screened:true});
const post=(f:Fixture,payload:object)=>app.inject({method:'POST',url:'/api/v1/gateway/calls/incoming',headers:auth(f.deviceToken),payload});
const callRow=async(gatewayId:string)=>(await db.query(`SELECT * FROM call_records WHERE gateway_id=$1`,[gatewayId])).rows[0];
async function liveWorker(){
  const r=await app.inject({method:'POST',url:'/internal/v1/ai/workers/heartbeat',headers:internal,
    payload:{instanceId:'00000000-0000-4000-8000-000000000136',bootId:'00000000-0000-4000-8000-000000000137',protocol:'voice-run-v1',capacity:1}});
  assert.equal(r.statusCode,200,r.body);
}
/** The owner's address book holds the screened number, so S136 hands the call to AI. */
async function contactFixture(ownerId:string){
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    await insertContact(c,ownerId,{displayName:'Known caller',phones:[{rawNumber:'075500001360'}],source:'manual'},'CN');
    await c.query('COMMIT');
  }finally{c.release();}
}
const hangups=async(callId:string)=>(await db.query(`SELECT kind FROM commands WHERE call_id=$1`,[callId])).rows.map(r=>r.kind);
const blocklistRows=async(owner:string)=>(await db.query(`SELECT count(*)::int n FROM owner_blocked_numbers WHERE owner_user_id=$1`,[owner])).rows[0].n;
const revision=async(owner:string)=>Number((await db.query(`SELECT version FROM owner_blocklist_revisions WHERE owner_user_id=$1`,[owner])).rows[0]?.version??0);
const noWorker=()=>db.query(`UPDATE ai_worker_instances SET expires_at=now()-interval '1 second'`);

before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

test('S136: a screened ringing call on a normal-mode SIM is handed to AI at once',async()=>{
  await liveWorker();
  const owner=await userFixture('s136-ai');
  const f=await gatewayFixture(owner.id,'s136-ai');
  await contactFixture(owner.id);
  const payload=payloadFor(f,'screened:1');
  const first=await post(f,payload);
  assert.equal(first.statusCode,201,first.body);
  assert.equal(first.json().disposition,'offer_to_owner');
  const call=await callRow(f.gatewayId);
  assert.equal(call.mode_snapshot,'ai');
  assert.equal(call.state,'incoming_ringing');
  assert.equal(call.conflict_disposition,'screened_ai');
  assert.equal(first.json().call.conflictDisposition,'screened_ai');
  assert.ok(call.ai_run_id,'a screened call needs an AI run');
  const run=(await db.query(`SELECT trigger_at<=now() AS due FROM ai_call_runs WHERE id=$1`,[call.ai_run_id])).rows[0];
  assert.equal(run.due,true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM owner_blocked_numbers WHERE owner_user_id=$1`,[owner.id])).rows[0].n,0);
  const replay=await post(f,payload);
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ai_call_runs WHERE call_id=$1`,[call.id])).rows[0].n,1);
});

test('S136: the kill switch off leaves the SIM\'s own mode',async()=>{
  await liveWorker();
  const owner=await userFixture('s136-off');
  const f=await gatewayFixture(owner.id,'s136-off');
  await contactFixture(owner.id);
  (config as any).SCREENED_CALL_AI_ANSWER_ENABLED=false;
  try{
    const r=await post(f,payloadFor(f,'screened:2'));
    assert.equal(r.statusCode,201,r.body);
    const call=await callRow(f.gatewayId);
    assert.equal(call.mode_snapshot,'normal');
    assert.equal(call.ai_run_id,null);
  }finally{(config as any).SCREENED_CALL_AI_ANSWER_ENABLED=true;}
});

test('S136: a screened call with no AI worker keeps ringing instead of being rejected',async()=>{
  await noWorker();
  const owner=await userFixture('s136-noworker');
  const f=await gatewayFixture(owner.id,'s136-noworker');
  await contactFixture(owner.id);
  const r=await post(f,payloadFor(f,'screened:3'));
  assert.equal(r.statusCode,201,r.body);
  assert.equal(r.json().disposition,'offer_to_owner');
  const call=await callRow(f.gatewayId);
  assert.equal(call.state,'incoming_ringing');
  assert.equal(call.mode_snapshot,'ai');
  assert.equal(call.ai_run_id,null);
  assert.equal(call.failure_reason,null);
  assert.equal(call.conflict_disposition,null);
  assert.equal((await db.query(`SELECT count(*)::int n FROM commands WHERE call_id=$1`,[call.id])).rows[0].n,0);
});

test('S136: a screened call from a non-contact stays intercepted and is not blacklisted',async()=>{
  await liveWorker();
  const owner=await userFixture('s136-stranger');
  const f=await gatewayFixture(owner.id,'s136-stranger');
  const r=await post(f,payloadFor(f,'screened:4'));
  assert.equal(r.statusCode,202,r.body);
  assert.equal(r.json().disposition,'dropped_blocked');
  const call=await callRow(f.gatewayId);
  assert.equal(call.state,'failed');
  assert.equal(call.failure_reason,'number_blocked');
  assert.equal(call.blocked_source,'phone');
  assert.equal(call.conflict_disposition,null);
  assert.equal(call.ai_run_id,null);
  assert.deepEqual(await hangups(call.id),['hangup']);
  assert.equal(await blocklistRows(owner.id),0);
  assert.equal(await revision(owner.id),0);
});

test('S136: flag off ignores screened for a non-contact',async()=>{
  await liveWorker();
  const owner=await userFixture('s136-off-stranger');
  const f=await gatewayFixture(owner.id,'s136-off-stranger');
  (config as any).SCREENED_CALL_AI_ANSWER_ENABLED=false;
  try{
    const r=await post(f,payloadFor(f,'screened:5'));
    assert.equal(r.statusCode,201,r.body);
    const call=await callRow(f.gatewayId);
    assert.equal(call.state,'incoming_ringing');
    assert.equal(call.mode_snapshot,'normal');
    assert.deepEqual(await hangups(call.id),[]);
  }finally{(config as any).SCREENED_CALL_AI_ANSWER_ENABLED=true;}
});

test('S136: a screening-app block no longer joins the blocklist by default',()=>{
  const loaded=loadConfig({DATABASE_URL:'postgresql://localhost/vodog_test',COOKIE_SECRET:'s136-config-test-cookie-secret-at-least-32-bytes'});
  assert.equal(loaded.SCREENING_APP_AUTO_BLOCK_ENABLED,false);
  assert.equal(loaded.SCREENED_CALL_AI_ANSWER_ENABLED,false);
});
