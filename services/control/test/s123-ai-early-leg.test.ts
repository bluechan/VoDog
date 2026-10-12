import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, tokenHash } from '../src/security.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
// `buildApp` closes over this object; tests flip AI_EARLY_LEG_ENABLED per case.
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',
  COOKIE_SECRET:'s123-test-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3398,
  MEDIA_DEFAULT_NODE_ID:'relay-primary',MEDIA_SECRET:'s123-test-media-secret-at-least-32-chars',TURN_SECRET:'s123-test-turn-secret-at-least-32-chars',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false,
  PIXEL_ORIGINATED_CALLS_ENABLED:false,PIXEL_ARCHIVE_ENABLED:true,EARLY_MEDIA_ENABLED:false,AI_EARLY_LEG_ENABLED:false};

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
  // An AI commit leaves the call 'connecting' with answered_by_platform='ai' and recording_status 'pending'.
  const call=async(direction:string,state:string,deviceCallId:string,answeredBy:string|null)=>(await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,originating_platform,device_call_id,media_node_id,started_at,answered_at,answered_by_platform,recording_status)
     VALUES($1,$2,$3,$4,'10086',$5,$6,'normal','web',$7,'relay-primary',now(),$8,$9,'pending') RETURNING id`,[g.id,sim.id,owner,direction,state,g.device_epoch,deviceCallId,state==='active'?new Date():null,answeredBy])).rows[0].id as string;
  return {gatewayId:g.id as string,token,call};
}
const withFlag=async(on:boolean,fn:()=>Promise<void>)=>{(config as any).AI_EARLY_LEG_ENABLED=on;try{await fn();}finally{(config as any).AI_EARLY_LEG_ENABLED=false;}};
const options=(token:string,callId:string,capture?:object)=>app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/media/options`,headers:auth(token),
  payload:{transport:'udp',...(capture?{capture}:{})}});
const bind=(token:string,callId:string,deviceCallId:string)=>app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/capture-binding`,headers:auth(token),
  payload:{deviceCallId,telecomCreationTimeMillis:1758000000000}});
const confirmActive=(gatewayId:string,callId:string,deviceCallId:string)=>db.query(`UPDATE gateway_telecom_snapshots SET calls=$2::jsonb,observed_at=now() WHERE gateway_id=$1`,
  [gatewayId,JSON.stringify([{callId,deviceCallId,state:'active'}])]);

test('S123: capture-less media/options for an AI-answered incoming call only while the flag is on',async()=>{
  const f=await fixture('s123-options');
  const ringing=await f.call('incoming','connecting','t-1','ai');
  const active=await f.call('incoming','active','t-2','ai');
  const human=await f.call('incoming','connecting','t-3','ios');
  const outgoing=await f.call('outgoing','connecting','t-4',null);
  // Not reachable after an AI commit (it writes 'connecting'; the restore path nulls answered_by_platform): stays refused.
  const unclaimed=await f.call('incoming','incoming_ringing','t-6','ai');
  for(const id of [ringing,active]){
    const off=await options(f.token,id);
    assert.equal(off.statusCode,409,off.body);assert.equal(off.json().error.code,'CAPTURE_BINDING_REQUIRED');
  }
  await withFlag(true,async()=>{
    for(const id of [ringing,active]){
      const ok=await options(f.token,id);
      assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().mediaNodeId,'relay-primary');assert.equal(ok.json().captureBinding,undefined);
      assert.equal((await db.query(`SELECT recording_status FROM call_records WHERE id=$1`,[id])).rows[0].recording_status,'pending');
      assert.equal((await db.query(`SELECT 1 FROM recording_capture_bindings WHERE call_id=$1`,[id])).rowCount,0);
    }
    // Human-answered incoming and (with EARLY_MEDIA off) outgoing calls still need a capture identity.
    for(const id of [human,outgoing,unclaimed]){
      const refused=await options(f.token,id);
      assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error.code,'CAPTURE_BINDING_REQUIRED');
    }
    const ending=await f.call('incoming','ending','t-5','ai');
    const revoked=await options(f.token,ending);
    assert.equal(revoked.statusCode,409,revoked.body);assert.equal(revoked.json().error.code,'MEDIA_REVOKED');
    // Old gateways always send capture: the capture path is unchanged (pre-ACTIVE refused, ACTIVE bound).
    const early=await options(f.token,ringing,{deviceCallId:'t-1',telecomCreationTimeMillis:1758000000000});
    assert.equal(early.statusCode,409,early.body);assert.equal(early.json().error.code,'CAPTURE_NOT_ACTIVE');
    await confirmActive(f.gatewayId,active,'t-2');
    const bound=await options(f.token,active,{deviceCallId:'t-2',telecomCreationTimeMillis:1758000000000});
    assert.equal(bound.statusCode,200,bound.body);assert.equal(bound.json().captureBinding.callId,active);
  });
});

test('S123: capture-binding arms an active AI-answered incoming call only while the flag is on',async()=>{
  const f=await fixture('s123-capture');
  const callId=await f.call('incoming','connecting','t-10','ai');
  const off=await bind(f.token,callId,'t-10');
  assert.equal(off.statusCode,503,off.body);assert.equal(off.json().error.code,'CAPTURE_DISABLED');
  await withFlag(true,async()=>{
    const early=await bind(f.token,callId,'t-10');
    assert.equal(early.statusCode,409,early.body);assert.equal(early.json().error.code,'CAPTURE_NOT_ACTIVE');
    await db.query(`UPDATE call_records SET state='active',answered_at=now() WHERE id=$1`,[callId]);
    await confirmActive(f.gatewayId,callId,'t-10');
    const bound=await bind(f.token,callId,'t-10');
    assert.equal(bound.statusCode,200,bound.body);
    assert.equal(bound.json().captureBinding.callId,callId);assert.equal(bound.json().captureBinding.mediaNodeId,'relay-primary');
    const human=await f.call('incoming','active','t-11','ios');
    const refused=await bind(f.token,human,'t-11');
    assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error.code,'CAPTURE_NOT_ACTIVE');
  });
  // Flag off again, PIXEL_ORIGINATED/EARLY_MEDIA off: the route is disabled as before.
  const after=await bind(f.token,callId,'t-10');
  assert.equal(after.statusCode,503,after.body);assert.equal(after.json().error.code,'CAPTURE_DISABLED');
});

test('S123: the gateway offer reaches the bridge for a pre-ACTIVE AI-answered incoming call',async()=>{
  const f=await fixture('s123-offer');
  const callId=await f.call('incoming','connecting','t-20','ai');
  const roles:string[]=[];
  const server=createServer((req,res)=>{if(req.url==='/offer'){roles.push(JSON.parse(Buffer.from(req.headers.authorization!.slice(7).split('.')[0]!,'base64url').toString()).role);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'answer',sdp:'v=0\r\n'}));return;}res.writeHead(404).end();});
  await new Promise<void>(resolve=>server.listen(16881,'127.0.0.1',resolve));
  try{
    for(const on of [false,true])await withFlag(on,async()=>{
      const offer=await app.inject({method:'POST',url:`/api/v1/gateway/calls/${callId}/media/offer`,headers:auth(f.token),payload:{type:'offer',sdp:'v=0\r\n'}});
      assert.equal(offer.statusCode,200,offer.body);assert.deepEqual(offer.json(),{type:'answer',sdp:'v=0\r\n'});
    });
    assert.deepEqual(roles,['gateway','gateway']);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('S123: every heartbeat answer carries aiEarlyLeg',async()=>{
  const f=await fixture('s123-heartbeat');
  const beat=()=>app.inject({method:'POST',url:'/api/v1/gateway/heartbeat',headers:auth(f.token),
    payload:{controlEnabled:true,reportedSequence:0,capabilities:{telephonyReady:true,smsReady:true,mediaReady:true}}});
  const off=await beat();assert.equal(off.statusCode,200,off.body);assert.equal(off.json().aiEarlyLeg,false);
  await withFlag(true,async()=>{const on=await beat();assert.equal(on.statusCode,200,on.body);assert.equal(on.json().aiEarlyLeg,true);});
});

test('S123 决策 8: media/options no longer queues behind a heartbeat-style gateway UPDATE, still behind FOR UPDATE',async()=>{
  const f=await fixture('s123-lock');
  const active=await f.call('incoming','active','t-30','ai');
  const holder=await db.connect();
  try{
    await withFlag(true,async()=>{
      await holder.query('BEGIN');
      await holder.query(`UPDATE gateways SET last_seen_at=now() WHERE id=$1`,[f.gatewayId]);
      const started=Date.now();
      const ok=await options(f.token,active);
      const elapsed=Date.now()-started;
      assert.equal(ok.statusCode,200,ok.body);assert.ok(elapsed<200,`options took ${elapsed} ms behind a non-key UPDATE`);
      await holder.query('COMMIT');
      // A snapshot-style FOR UPDATE still serializes options: it waits, then succeeds once released.
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[f.gatewayId]);
      let settled=false;
      const queued=options(f.token,active).then(r=>{settled=true;return r;});
      await new Promise(resolve=>setTimeout(resolve,300));
      assert.equal(settled,false,'options must wait for the gateway FOR UPDATE holder');
      await holder.query('COMMIT');
      const late=await queued;
      assert.equal(late.statusCode,200,late.body);
    });
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
});
