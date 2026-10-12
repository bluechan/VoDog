import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {MediaBridgeClient,MediaBridgeError,isConnectionError} from '../src/media-client.js';
test('bridge uses single-use signed grants and surfaces failure', async()=>{
 const key='x'.repeat(40),turn='t'.repeat(40),id='11111111-1111-1111-1111-111111111111';
 const nonces=new Set<string>();let failure=false;
 const server=createServer(async(req,res)=>{
  if(failure){res.writeHead(409).end();return;}
  const [raw,sig]=req.headers.authorization!.slice(7).split('.');
  assert.equal(sig,createHmac('sha256',key).update(raw).digest('base64url'));
  const grant=JSON.parse(Buffer.from(raw,'base64url').toString());
  assert.equal(grant.callId,id);assert.equal(grant.role,'client');assert.equal(grant.mediaEpoch,3);assert.ok(grant.exp>Date.now()/1000);assert.ok(grant.exp<Date.now()/1000+120);assert.ok(!nonces.has(grant.nonce));nonces.add(grant.nonce);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({type:'answer',sdp:'answer-sdp'}));
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(16881,'127.0.0.1',resolve);});
 try {
  const client=new MediaBridgeClient(key,turn);
  assert.equal((await client.offer(id,'client',{type:'offer',sdp:'test'},3)).sdp,'answer-sdp');
  await client.offer(id,'client',{type:'offer',sdp:'test'},3);assert.equal(nonces.size,2);
  const ice=client.iceServers()[0];assert.equal(ice.credential,createHmac('sha1',turn).update(ice.username).digest('base64'));
  await assert.rejects(()=>client.offer('../escape','client',{type:'offer',sdp:'test'}));
  failure=true;await assert.rejects(()=>client.offer(id,'client',{type:'offer',sdp:'test'}),(e:unknown)=>e instanceof MediaBridgeError&&e.status===409);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('a replacing offer (gateway / human leg) is resent once after a connection reset; the AI offer, HTTP answers and repeat failures are not',async()=>{
 const key='x'.repeat(40),turn='t'.repeat(40),id='11111111-1111-1111-1111-111111111111',offer={type:'offer' as const,sdp:'test'};
 let requests=0,resets=0,status=200;const nonces=new Set<string>();
 const server=createServer((req,res)=>{
  requests++;nonces.add(JSON.parse(Buffer.from(req.headers.authorization!.slice(7).split('.')[0]!,'base64url').toString()).nonce);
  if(resets>0){resets--;req.socket.destroy();return;}
  req.resume();req.on('end',()=>{if(status!==200){res.writeHead(status).end();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({type:'answer',sdp:'answer-sdp'}));});
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();assert.ok(address&&typeof address==='object');
 try {
  const client=new MediaBridgeClient(key,turn,{controlBaseUrl:`http://127.0.0.1:${address.port}`});
  resets=1;const startedAt=Date.now();
  assert.equal((await client.offer(id,'gateway',offer,2,true)).sdp,'answer-sdp');
  assert.equal(requests,2,'reset then success');assert.equal(nonces.size,2,'the resend carries a fresh grant');assert.ok(Date.now()-startedAt>=140,'after a short pause');
  requests=0;resets=1;
  assert.equal((await client.offer(id,'client',offer,2,true)).sdp,'answer-sdp');assert.equal(requests,2,'the human client leg replaces too');
  requests=0;resets=1;
  await assert.rejects(client.offer(id,'client',offer,2,false));assert.equal(requests,1,'the AI leg (no replace) stays single-attempt');
  requests=0;resets=2;
  await assert.rejects(client.offer(id,'gateway',offer,2,true));assert.equal(requests,2,'at most one resend');
  requests=0;resets=0;status=503;
  await assert.rejects(client.offer(id,'gateway',offer,2,true),(e:unknown)=>e instanceof MediaBridgeError&&e.status===503);
  assert.equal(requests,1,'an HTTP answer is never resent');
 } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('only connection-level fetch failures count as retryable',()=>{
 const failed=(cause:unknown)=>Object.assign(new TypeError('fetch failed'),{cause});
 assert.equal(isConnectionError(failed(Object.assign(new Error('x'),{code:'ECONNRESET'}))),true);
 assert.equal(isConnectionError(failed(Object.assign(new Error('x'),{code:'UND_ERR_SOCKET'}))),true);
 assert.equal(isConnectionError(failed(Object.assign(new AggregateError([Object.assign(new Error('x'),{code:'ECONNREFUSED'})]),{}))),true);
 assert.equal(isConnectionError(failed(Object.assign(new Error('x'),{code:'UND_ERR_CONNECT_TIMEOUT'}))),false);
 assert.equal(isConnectionError(new DOMException('timed out','TimeoutError')),false);
 assert.equal(isConnectionError(new MediaBridgeError(502)),false);
});
