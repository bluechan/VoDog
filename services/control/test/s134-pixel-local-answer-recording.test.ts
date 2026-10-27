import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
// `buildApp` closes over this object; tests flip the capture flags per case.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s134-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3399,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s134-test-media-secret-at-least-32-chars',TURN_SECRET:'s134-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  PIXEL_ORIGINATED_CALLS_ENABLED:false,PIXEL_ARCHIVE_ENABLED:true,EARLY_MEDIA_ENABLED:false,AI_EARLY_LEG_ENABLED:false,
  PIXEL_LOCAL_ANSWER_RECORDING_ENABLED:false};

let db:Db,app:FastifyInstance;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
before(async()=>{
  db=createDb(databaseUrl);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await db.query(await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8'));
  await db.query(await readFile(fileURLToPath(new URL('../src/transcription/schema.sql',import.meta.url)),'utf8'));
  app=await buildApp(db,config as never);
});
after(async()=>{await app.close();await db.end();});

async function fixture(label:string){
  const owner=(await db.query(`INSERT INTO users(email,password_hash)VALUES($1,$2)RETURNING id`,[`${label}@example.test`,await hashPassword('correct horse battery staple')])).rows[0].id as string;
  const g=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES($1,true,true,true,true,now())RETURNING id,device_epoch`,[label])).rows[0];
  const sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash)VALUES($1,0,$2,$3,true,$4)RETURNING id`,[g.id,owner,`${label} SIM`,tokenHash(`${label}-fingerprint`)])).rows[0];
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[sim.id]);
  const token=`${label}-${crypto.randomUUID()}-device-token`;
  await db.query(`INSERT INTO device_credentials(gateway_id,secret_hash,label)VALUES($1,$2,$3)`,[g.id,tokenHash(token),label]);
  await db.query(`INSERT INTO gateway_telecom_snapshots(gateway_id,generation,snapshot_id,snapshot_sequence,reported_sequence,local_busy,calls,observed_at)VALUES($1,$2,$3,0,0,false,'[]',now())`,[g.id,g.device_epoch,crypto.randomUUID()]);
  // A locally answered incoming call never joined media: no media node, recording 'none' (the f5a68518 shape).
  const call=async(state:string,deviceCallId:string,answeredBy:string|null)=>(await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,device_call_id,started_at,answered_at,answered_by_platform,recording_status)
     VALUES($1,$2,$3,'incoming','075500001340',$4,$5,'normal',$6,now(),$7,$8,'none') RETURNING id`,
    [g.id,sim.id,owner,state,g.device_epoch,deviceCallId,state==='active'?new Date():null,answeredBy])).rows[0].id as string;
  const confirmActive=(callId:string,deviceCallId:string)=>db.query(`UPDATE gateway_telecom_snapshots SET calls=$2::jsonb,observed_at=now() WHERE gateway_id=$1`,
    [g.id,JSON.stringify([{callId,deviceCallId,state:'active'}])]);
  return {token,call,confirmActive,epoch:Number(g.device_epoch)};
}
const flags=async(on:Partial<typeof config>,fn:()=>Promise<void>)=>{
  Object.assign(config,on);
  try{await fn();}finally{Object.assign(config,{PIXEL_LOCAL_ANSWER_RECORDING_ENABLED:false,AI_EARLY_LEG_ENABLED:false});}
};
const bind=(token:string,callId:string,deviceCallId:string)=>app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/capture-binding`,headers:auth(token),
  payload:{deviceCallId,telecomCreationTimeMillis:1758000000000}});
const row=async(id:string)=>(await db.query(`SELECT recording_status,media_node_id FROM call_records WHERE id=$1`,[id])).rows[0];

test('S134: a Pixel-answered incoming call gets a capture binding only while the flag is on',async()=>{
  const f=await fixture('s134-local');
  const local=await f.call('active','l-1','device');
  await f.confirmActive(local,'l-1');
  // Every capture flag off: the route is disabled.
  const off=await bind(f.token,local,'l-1');
  assert.equal(off.statusCode,503,off.body);assert.equal(off.json().error.code,'CAPTURE_DISABLED');
  // Another capture flag on, S134 off: the route works but does not take this call.
  await flags({AI_EARLY_LEG_ENABLED:true},async()=>{
    const refused=await bind(f.token,local,'l-1');
    assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error.code,'CAPTURE_NOT_ACTIVE');
  });
  assert.deepEqual(await row(local),{recording_status:'none',media_node_id:null});
  await flags({PIXEL_LOCAL_ANSWER_RECORDING_ENABLED:true},async()=>{
    const bound=await bind(f.token,local,'l-1');
    assert.equal(bound.statusCode,200,bound.body);
    assert.equal(bound.json().captureBinding.callId,local);assert.equal(bound.json().captureBinding.mediaNodeId,'relay-primary');
    assert.deepEqual(await row(local),{recording_status:'pending',media_node_id:'relay-primary'});
    assert.equal((await db.query(`SELECT 1 FROM recording_capture_bindings WHERE call_id=$1`,[local])).rowCount,1);
  });
});

test('S134: client-answered, unanswered and non-active incoming calls are still refused',async()=>{
  const f=await fixture('s134-refused');
  const ios=await f.call('active','r-1','ios');
  const unanswered=await f.call('active','r-2',null);
  const ringing=await f.call('incoming_ringing','r-3',null);
  const ending=await f.call('ending','r-4','device');
  await flags({PIXEL_LOCAL_ANSWER_RECORDING_ENABLED:true},async()=>{
    for(const [id,deviceCallId] of [[ios,'r-1'],[unanswered,'r-2'],[ringing,'r-3'],[ending,'r-4']] as const){
      const refused=await bind(f.token,id,deviceCallId);
      assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error.code,'CAPTURE_NOT_ACTIVE');
      assert.equal((await row(id)).recording_status,'none');
    }
  });
});

test('S134: AI-answered incoming calls follow AI_EARLY_LEG_ENABLED, not the S134 flag',async()=>{
  const f=await fixture('s134-ai');
  const ai=await f.call('active','a-1','ai');
  await f.confirmActive(ai,'a-1');
  await flags({PIXEL_LOCAL_ANSWER_RECORDING_ENABLED:true},async()=>{
    const refused=await bind(f.token,ai,'a-1');
    assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error.code,'CAPTURE_NOT_ACTIVE');
  });
  await flags({AI_EARLY_LEG_ENABLED:true},async()=>{
    const bound=await bind(f.token,ai,'a-1');
    assert.equal(bound.statusCode,200,bound.body);assert.equal(bound.json().captureBinding.callId,ai);
  });
});

test('S134: the gateway ACTIVE event marks the device answer in the same request, so the binding follows',async()=>{
  const f=await fixture('s134-event');
  const callId=await f.call('incoming_ringing','e-1',null);
  const event=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/events`,headers:auth(f.token),
    payload:{eventId:crypto.randomUUID(),generation:f.epoch,state:'active'}});
  assert.equal(event.statusCode,200,event.body);
  const after=(await db.query(`SELECT state,answered_by_platform FROM call_records WHERE id=$1`,[callId])).rows[0];
  assert.deepEqual(after,{state:'active',answered_by_platform:'device'});
  await f.confirmActive(callId,'e-1');
  await flags({PIXEL_LOCAL_ANSWER_RECORDING_ENABLED:true},async()=>{
    const bound=await bind(f.token,callId,'e-1');
    assert.equal(bound.statusCode,200,bound.body);
  });
});
