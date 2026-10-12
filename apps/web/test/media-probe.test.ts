import test from 'node:test';
import assert from 'node:assert/strict';
import {measureMediaNodes,MediaProbeCache,PROBE_CACHE_TTL_MS,type ProbeAPI} from '../src/media-probe.ts';
import {currentNetworkEpoch,watchNetworkEpoch} from '../src/media-policy.ts';
function fixture(url='https://control.example.com/probe'){
 const reports:unknown[]=[];
 const api:ProbeAPI=async<T>(path:string,body?:unknown)=>{
  if(path.includes('/quality-probes/'))throw Object.assign(new Error('disabled'),{code:'MEDIA_QUALITY_UNAVAILABLE'});
  if(path.endsWith('/options'))return {networkGeneration:'generation-1',nodes:[{nodeId:'demo-node-1',probeUrl:url,grants:['one','two','three']}]} as T;
  reports.push(body);return {accepted:3} as T;
 };
 return {api,reports};
}
test('probe sends one-shot empty credential-isolated POSTs and actual browser timings',async()=>{
 // Each request takes 10 ms on the fake clock from its own start, whether or not others are in flight.
 const {api,reports}=fixture(),requests:RequestInit[]=[];let time=0;
 const request=(async(_url,init)=>{requests.push(init!);const started=time;await new Promise(resolve=>setTimeout(resolve,1));time=Math.max(time,started+10);return new Response(JSON.stringify({ok:true,nodeId:'demo-node-1'}));}) as typeof fetch;
 assert.equal(await measureMediaNodes(api,new AbortController().signal,{fetch:request,now:()=>time,newId:()=> 'generation-1'}),'generation-1');
 assert.equal(requests.length,3);assert.deepEqual(requests.map(r=>(r.headers as Record<string,string>).Authorization),['Bearer one','Bearer two','Bearer three']);
 for(const r of requests){assert.equal(r.method,'POST');assert.equal(r.body,undefined);assert.equal(r.credentials,'omit');assert.equal(r.redirect,'error');}
 assert.deepEqual(reports,[{networkGeneration:'generation-1',samples:Array.from({length:3},()=>({nodeId:'demo-node-1',outcome:'ok',httpsRttMs:10}))}]);
});
test('untrusted destination is rejected before any grant request',async()=>{
 const {api,reports}=fixture('https://untrusted.invalid/probe');let requested=false;
 await assert.rejects(measureMediaNodes(api,new AbortController().signal,{newId:()=> 'generation-1',fetch:(async()=>{requested=true;throw new Error();}) as typeof fetch}));
 assert.equal(requested,false);assert.deepEqual(reports,[]);
});
test('cancelled options cannot submit evidence under changed session or network',async()=>{
 const controller=new AbortController();let requests=0;
 const api:ProbeAPI=async<T>()=>{requests++;controller.abort();return {networkGeneration:'generation-1',nodes:[]} as T;};
 await assert.rejects(measureMediaNodes(api,controller.signal,{newId:()=> 'generation-1'}),/取消/);assert.equal(requests,1);
});
test('timeout and mismatched node response do not become successful RTT samples',async()=>{
 const {api,reports}=fixture();let calls=0;
 const request=(async(_url,init)=>{calls++;if(calls===1)return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));return new Response(JSON.stringify({ok:true,nodeId:'wrong'}));}) as typeof fetch;
 await measureMediaNodes(api,new AbortController().signal,{fetch:request,newId:()=> 'generation-1',timeoutMs:1});
 assert.deepEqual(reports,[{networkGeneration:'generation-1',samples:[{nodeId:'demo-node-1',outcome:'timeout'},{nodeId:'demo-node-1',outcome:'network_error'},{nodeId:'demo-node-1',outcome:'network_error'}]}]);
});

test('P1 the first grant warms the connection, then the other two grants of a node fly together',async()=>{
 const {api,reports}=fixture(),log:string[]=[];const pending:(()=>void)[]=[];
 const request=(async(_url,init)=>{const grant=(init!.headers as Record<string,string>).Authorization.slice(7);log.push(`start ${grant}`);await new Promise<void>(resolve=>pending.push(resolve));log.push(`end ${grant}`);return new Response(JSON.stringify({ok:true,nodeId:'demo-node-1'}));}) as typeof fetch;
 const measuring=measureMediaNodes(api,new AbortController().signal,{fetch:request,newId:()=> 'generation-1'});
 const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
 await settle();assert.deepEqual(log,['start one']);
 pending.shift()!();await settle();assert.deepEqual(log,['start one','end one','start two','start three'],'grants two and three are in flight together');
 pending.shift()!();pending.shift()!();await measuring;
 assert.equal((reports[0] as {samples:unknown[]}).samples.length,3,'still three samples per node');
});

function cacheFixture(){
 let time=0,epoch=0,measures=0;
 const cache=new MediaProbeCache({now:()=>time,epoch:()=>epoch});
 const measure=async()=>`generation-${++measures}`;
 const api:ProbeAPI=async<T>()=>({}) as T,signal=new AbortController().signal;
 return {cache,measure,api,signal,get measures(){return measures;},advance(ms:number){time+=ms;},switchNetwork(){epoch++;}};
}

test('P1 accepted probe evidence is reused for one session within the TTL and re-measured after it',async()=>{
 const fixture=cacheFixture();
 assert.equal(await fixture.cache.forAuthorization('session-a',fixture.measure)(fixture.api,fixture.signal),'generation-1');
 fixture.advance(PROBE_CACHE_TTL_MS-1);
 assert.equal(await fixture.cache.forAuthorization('session-a',fixture.measure)(fixture.api,fixture.signal),'generation-1');
 assert.equal(fixture.measures,1);
 fixture.advance(1);
 assert.equal(await fixture.cache.forAuthorization('session-a',fixture.measure)(fixture.api,fixture.signal),'generation-2');
 assert.ok(PROBE_CACHE_TTL_MS<=100_000,'Control keeps evidence 120 s; reuse stays inside it');
});

test('P1 a network switch or another session never reuses the evidence',async()=>{
 const fixture=cacheFixture();
 await fixture.cache.forAuthorization('session-a',fixture.measure)(fixture.api,fixture.signal);
 assert.equal(await fixture.cache.forAuthorization('session-b',fixture.measure)(fixture.api,fixture.signal),'generation-2','no cross-session reuse');
 assert.equal(fixture.cache.cached('session-a'),undefined,'the newest measurement replaced the other session\'s');
 fixture.switchNetwork();
 assert.equal(fixture.cache.cached('session-b'),undefined);
 assert.equal(await fixture.cache.forAuthorization('session-b',fixture.measure)(fixture.api,fixture.signal),'generation-3');
});

test('P1 MEDIA_PROBE_REQUIRED after a cached generation re-measures on the second call',async()=>{
 const fixture=cacheFixture();
 await fixture.cache.forAuthorization('session-a',fixture.measure)(fixture.api,fixture.signal);
 const measure=fixture.cache.forAuthorization('session-a',fixture.measure);
 assert.equal(await measure(fixture.api,fixture.signal),'generation-1');
 assert.equal(await measure(fixture.api,fixture.signal),'generation-2');
 assert.equal(fixture.cache.cached('session-a'),'generation-2');
});

test('P1 a call joins the prewarm already running instead of replacing its evidence, and a failed prewarm is not cached',async()=>{
 const fixture=cacheFixture();let finish!:(value:string)=>void,starts=0;
 const slow=()=>{starts++;return new Promise<string>(resolve=>{finish=resolve;});};
 const warming=fixture.cache.prewarm('session-a',fixture.api,slow);
 void fixture.cache.prewarm('session-a',fixture.api,slow);
 const call=fixture.cache.forAuthorization('session-a',slow)(fixture.api,fixture.signal);
 assert.equal(starts,1,'one measurement per session at a time');
 finish('generation-warm');await warming;assert.equal(await call,'generation-warm');
 const failing=new MediaProbeCache({now:()=>0,epoch:()=>0});
 await failing.prewarm('session-a',fixture.api,async()=>{throw new Error('offline');});
 assert.equal(failing.cached('session-a'),undefined);
});

test('P1 a measurement that straddles a network switch is not cached',async()=>{
 const fixture=cacheFixture();let finish!:(value:string)=>void;
 const running=fixture.cache.forAuthorization('session-a',()=>new Promise<string>(resolve=>{finish=resolve;}))(fixture.api,fixture.signal);
 fixture.switchNetwork();finish('generation-old');
 assert.equal(await running,'generation-old');assert.equal(fixture.cache.cached('session-a'),undefined);
});

test('P1/P2 the network epoch moves on online/offline and a connection type change, not on estimate-only changes',()=>{
 const target=new EventTarget(),connection=Object.assign(new EventTarget(),{type:'wifi'});
 watchNetworkEpoch(target,connection);watchNetworkEpoch(target,connection);
 const start=currentNetworkEpoch();
 connection.dispatchEvent(new Event('change'));assert.equal(currentNetworkEpoch(),start,'rtt/downlink estimate change');
 connection.type='cellular';connection.dispatchEvent(new Event('change'));assert.equal(currentNetworkEpoch(),start+1);
 target.dispatchEvent(new Event('offline'));target.dispatchEvent(new Event('online'));assert.equal(currentNetworkEpoch(),start+3,'listeners installed once');
});
