import assert from 'node:assert/strict';
import test from 'node:test';
import {simsOnlineFirst} from '../src/sim-order.ts';

test('simsOnlineFirst puts online SIMs first and keeps server order inside each group',()=>{
 const s=(id:string,online:boolean,present?:boolean)=>({id,online,present});
 assert.deepEqual(simsOnlineFirst([s('a',false),s('b',true),s('c',false,false),s('d',true),s('e',true,false)]).map(x=>x.id),['b','d','a','c','e']);
});
