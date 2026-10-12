import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test,{after,before} from 'node:test';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {createDb,type Db} from '../src/db.js';
import {hashPassword,tokenHash} from '../src/security.js';
import {annotateNumbers,backfillContactPhoneLocations} from '../src/contacts/repository.js';
import {formatLocation,locateNumbers,locationLookupKeys} from '../src/phone-location.js';

test('S96 lookup keys: mobile, partial, +86/86, landline, service, emergency, international, garbage',()=>{
  assert.deepEqual(locationLookupKeys('13800001234','CN'),{prefixes:['13800001','1380000']});
  assert.deepEqual(locationLookupKeys('1380000','CN'),{prefixes:['1380000']},'7-digit partial');
  assert.deepEqual(locationLookupKeys('13800001','CN'),{prefixes:['13800001','1380000']},'8-digit partial, 8 first');
  assert.deepEqual(locationLookupKeys('138 0000-1234'),{prefixes:['13800001','1380000']},'spaces/dashes, default CN');
  assert.deepEqual(locationLookupKeys('+8613800001234','CN'),{prefixes:['13800001','1380000']});
  assert.deepEqual(locationLookupKeys('8613800001234','CN'),{prefixes:['13800001','1380000']});
  assert.deepEqual(locationLookupKeys('+8613800001234','US'),{prefixes:['13800001','1380000']},'+86 wins over the SIM country');
  assert.deepEqual(locationLookupKeys('01062345678','CN'),{prefixes:[],areaCode:'010'});
  assert.deepEqual(locationLookupKeys('075512345678','CN'),{prefixes:[],areaCode:'0755'});
  assert.deepEqual(locationLookupKeys('+86 755 1234 5678','CN'),{prefixes:[],areaCode:'0755'});
  assert.deepEqual(locationLookupKeys('(020) 8888-8888','CN'),{prefixes:[],areaCode:'020'});
  for(const none of ['10086','95559','+8610086','112','911','','   ','abc','++86','138001','83765432',null,undefined])
    assert.deepEqual(locationLookupKeys(none as any,'CN'),{prefixes:[]},String(none));
  assert.deepEqual(locationLookupKeys('+233244123456','CN'),{prefixes:[],country:'加纳'});
  assert.deepEqual(locationLookupKeys('+85291234567','CN'),{prefixes:[],country:'中国香港'});
  assert.deepEqual(locationLookupKeys('+85361234567'),{prefixes:[],country:'中国澳门'});
  assert.deepEqual(locationLookupKeys('+886912345678'),{prefixes:[],country:'中国台湾'});
  assert.deepEqual(locationLookupKeys('+2331'),{prefixes:[]},'invalid international number');
});

test('S96 format: province/city, municipality, landline, international, empty parts',()=>{
  assert.equal(formatLocation({province:'广东',city:'深圳',isp:'移动'}),'广东 深圳 · 移动');
  assert.equal(formatLocation({province:'北京',city:'北京',isp:'联通'}),'北京 · 联通');
  assert.equal(formatLocation({province:'广东',city:'深圳',isp:'固话'}),'广东 深圳 · 固话');
  assert.equal(formatLocation({province:' 广东 ',city:'',isp:''}),'广东');
  assert.equal(formatLocation({province:'',city:'',isp:'移动'}),null);
});

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.includes('test'))throw new Error('TEST_DATABASE_URL must name an isolated test database');
const config={DATABASE_URL:databaseUrl,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'s96-test-cookie-secret-at-least-32-chars-x',
  GATEWAY_ONLINE_SECONDS:30,PORT:3399,AI_ENABLED:false,AI_WORKER_READY:false,MEDIA_DEFAULT_NODE_ID:'relay-primary',
  MEDIA_SECRET:'s96-test-media-secret-at-least-32-chars-xx',TURN_SECRET:'s96-test-turn-secret-at-least-32-chars-xxx',
  TRANSCRIPTION_ENABLED:false,TRANSCRIPTION_SCAN_INTERVAL_SECONDS:5,TRANSCRIPTION_SCAN_BATCH:2,
  COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false};

let db:Db,app:FastifyInstance,ownerId:string,gatewayId:string,simId:string,token:string,schema:string;
const auth=()=>({authorization:`Bearer ${token}`});
const password='correct horse battery staple';
const seed=async()=>{
  await db.query(`INSERT INTO phone_location_prefixes(prefix,province,city,isp,area_code)VALUES
    ('1380000','广东','深圳','移动','0755'),('13800001','北京','北京','联通','010'),('1390000','广东','广州','电信','020')`);
  await db.query(`INSERT INTO phone_location_areas(area_code,province,city)VALUES('010','北京','北京'),('0755','广东','深圳')`);
};
const truncate=()=>db.query('TRUNCATE phone_location_prefixes,phone_location_areas');

before(async()=>{
  db=createDb(databaseUrl!);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  schema=await readFile(fileURLToPath(new URL('../src/schema.sql',import.meta.url)),'utf8');
  await db.query(schema);
  ownerId=(await db.query(`INSERT INTO users(email,password_hash)VALUES('s96-owner@example.test',$1)RETURNING id`,[await hashPassword(password)])).rows[0].id;
  gatewayId=(await db.query(`INSERT INTO gateways(name,control_enabled,telephony_ready,sms_ready,media_ready,last_seen_at)VALUES('s96-gateway',true,true,true,true,now())RETURNING id`)).rows[0].id;
  simId=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso)VALUES($1,0,$2,'SIM',true,$3,'CN')RETURNING id`,
    [gatewayId,ownerId,tokenHash('s96-sim-fingerprint')])).rows[0].id;
  await db.query(`INSERT INTO sim_settings(sim_id)VALUES($1)`,[simId]);
  app=await buildApp(db,config);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'s96-owner@example.test',password,platform:'android'}});
  assert.equal(login.statusCode,200,login.body);
  token=login.json().token;
});
after(async()=>{await app.close();await db.end();});

test('S96 empty tables: no location key anywhere, and nothing throws',async()=>{
  await truncate();
  assert.equal((await locateNumbers(db,[{number:'13800001234'},{number:'01062345678'}])).size,0);
  const [annotation]=await annotateNumbers(db,ownerId,[{remoteNumber:'13800001234'}],'call');
  assert.equal('remoteLocation' in annotation!,false);
  const lookup=await app.inject({method:'GET',url:'/api/v1/contacts/lookup?number=1380000',headers:auth()});
  assert.deepEqual(lookup.json(),{item:null});
  // International names need no table.
  assert.equal((await locateNumbers(db,[{number:'+233244123456'}])).get('+233244123456'),'加纳');
});

test('S96 locateNumbers prefers the 8-digit prefix, falls back to 7, reads landline areas',async()=>{
  await truncate();await seed();
  const located=await locateNumbers(db,[{number:'13800001234'},{number:'13800005678',countryIso:'CN'},{number:'1390000'},
    {number:'+86 10 6234 5678'},{number:'075512345678'},{number:'02088888888'},{number:'10086'},{number:'garbage'}]);
  assert.deepEqual(Object.fromEntries(located),{
    '13800001234':'北京 · 联通','13800005678':'广东 深圳 · 移动','1390000':'广东 广州 · 电信',
    '+86 10 6234 5678':'北京 · 固话','075512345678':'广东 深圳 · 固话',
  });
  // A broken query is swallowed into an empty Map.
  assert.equal((await locateNumbers({query:async()=>{throw new Error('boom');}},[{number:'13800001234'}])).size,0);
});

test('S96 annotateNumbers, call/SMS/interception DTOs carry remoteLocation only when known',async()=>{
  await truncate();await seed();
  const [mobile,unknown]=await annotateNumbers(db,ownerId,[{remoteNumber:'+8613800005678',countryIso:'CN'},{remoteNumber:'15500000000'}],'call');
  assert.equal(mobile!.remoteLocation,'广东 深圳 · 移动');
  assert.equal('remoteLocation' in unknown!,false);
  const call=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,ended_at)
    VALUES($1,$2,$3,'incoming','13800005678','ended',1,'normal',now())RETURNING id`,[gatewayId,simId,ownerId])).rows[0];
  const blockedCall=(await db.query(`INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,state,generation,mode_snapshot,ended_at,failure_reason)
    VALUES($1,$2,$3,'incoming','01062345678','failed',1,'normal',now(),'number_blocked')RETURNING id`,[gatewayId,simId,ownerId])).rows[0];
  await db.query(`INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation)
    VALUES($1,$2,$3,'incoming','+8613800001234','hi','delivered',1)`,[gatewayId,simId,ownerId]);
  const calls=(await app.inject({method:'GET',url:'/api/v1/calls',headers:auth()})).json().items;
  assert.equal(calls.find((row:any)=>row.id===call.id).remoteLocation,'广东 深圳 · 移动');
  const detail=(await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth()})).json().call;
  assert.equal(detail.remoteLocation,'广东 深圳 · 移动');
  const sms=(await app.inject({method:'GET',url:'/api/v1/sms',headers:auth()})).json().items;
  assert.equal(sms[0].remoteLocation,'北京 · 联通');
  const interceptions=(await app.inject({method:'GET',url:'/api/v1/blocklist/interceptions',headers:auth()})).json().items;
  assert.equal(interceptions.find((row:any)=>row.id===blockedCall.id)?.remoteLocation,'北京 · 固话');
  await truncate();
  const bare=(await app.inject({method:'GET',url:`/api/v1/calls/${call.id}`,headers:auth()})).json().call;
  assert.equal('remoteLocation' in bare,false,'emptied tables remove the key');
});

test('S96 /contacts/lookup returns a top-level location beside item, also for partial and unmatched numbers',async()=>{
  await truncate();await seed();
  const partial=await app.inject({method:'GET',url:'/api/v1/contacts/lookup?number=1380000',headers:auth()});
  assert.deepEqual(partial.json(),{item:null,location:'广东 深圳 · 移动'});
  const created=await app.inject({method:'POST',url:'/api/v1/contacts',headers:auth(),payload:{displayName:'S96 Lookup',phones:[{rawNumber:'13900001111'}]}});
  assert.equal(created.statusCode,201,created.body);
  const matched=(await app.inject({method:'GET',url:'/api/v1/contacts/lookup?number=%2B8613900001111',headers:auth()})).json();
  assert.equal(matched.item.displayName,'S96 Lookup');
  assert.equal(matched.location,'广东 广州 · 电信');
  assert.equal('location' in (await app.inject({method:'GET',url:'/api/v1/contacts/lookup?number=10086',headers:auth()})).json(),false);
});

test('S96 contact writes store location; backfill fills NULL rows, leaves unresolvable NULL, never bumps version',async()=>{
  await truncate();await seed();
  const created=await app.inject({method:'POST',url:'/api/v1/contacts',headers:auth(),payload:{displayName:'S96 Contact',
    phones:[{rawNumber:'138 0000 1234'},{rawNumber:'010-62345678'},{rawNumber:'15500000000'}]}});
  assert.equal(created.statusCode,201,created.body);
  const item=created.json().item;
  assert.deepEqual(item.phones.map((phone:any)=>phone.location??null),['北京 · 联通','北京 · 固话',null]);
  assert.equal('location' in item.phones[2],false,'NULL column omits the key');
  const added=await app.inject({method:'POST',url:`/api/v1/contacts/${item.id}/phones`,headers:auth(),payload:{rawNumber:'0755-12345678'}});
  assert.ok(added.statusCode<300,added.body);
  const stored=async()=>(await db.query(`SELECT raw_number,location FROM contact_phones WHERE contact_id=$1 ORDER BY sort`,[item.id])).rows;
  assert.deepEqual((await stored()).map(row=>row.location),['北京 · 联通','北京 · 固话',null,'广东 深圳 · 固话']);

  await db.query(`UPDATE contact_phones SET location=NULL`);
  const version=async()=>Number((await db.query(`SELECT version FROM contacts WHERE id=$1`,[item.id])).rows[0].version);
  const before=await version();
  const logs:string[]=[];
  assert.ok(await backfillContactPhoneLocations(db,message=>logs.push(message))>=3);
  assert.deepEqual((await stored()).map(row=>row.location),['北京 · 联通','北京 · 固话',null,'广东 深圳 · 固话']);
  assert.equal(await version(),before,'derived field never bumps contacts.version');
  assert.equal(await backfillContactPhoneLocations(db,()=>{}),0,'a second pass finds only the unresolvable row');
  await db.query(`INSERT INTO phone_location_prefixes(prefix,province,city,isp)VALUES('1550000','山东','济南','联通')`);
  assert.equal(await backfillContactPhoneLocations(db,()=>{}),1,'the next run retries a NULL row');
  assert.equal((await stored())[2].location,'山东 济南 · 联通');
});

test('S96 contact write survives a location lookup failure inside the transaction',async()=>{
  await db.query('ALTER TABLE phone_location_areas RENAME TO phone_location_areas_away');
  try{
    const created=await app.inject({method:'POST',url:'/api/v1/contacts',headers:auth(),payload:{displayName:'S96 Resilient',phones:[{rawNumber:'13800001234'}]}});
    assert.equal(created.statusCode,201,created.body);
    assert.equal('location' in created.json().item.phones[0],false);
  }finally{await db.query('ALTER TABLE phone_location_areas_away RENAME TO phone_location_areas');}
});

test('S96 schema re-apply is a no-op and keeps imported rows and stored locations',async()=>{
  await truncate();await seed();
  await db.query(`UPDATE contact_phones SET location='保留' WHERE location IS NULL`);
  const count=async()=>(await db.query(`SELECT (SELECT count(*) FROM phone_location_prefixes)::int p,(SELECT count(*) FROM phone_location_areas)::int a,
    (SELECT count(*) FROM contact_phones WHERE location IS NOT NULL)::int c`)).rows[0];
  const before=await count();
  await db.query(schema);
  assert.deepEqual(await count(),before);
});
