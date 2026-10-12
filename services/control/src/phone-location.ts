import {isSupportedCountry,parsePhoneNumberFromString,type CountryCode} from 'libphonenumber-js';
import type {QueryResult} from 'pg';
import {CN_SERVICE_SHORT} from './blocklist.js';
import type {Db} from './db.js';
import {workerError} from './diag.js';
import {isEmergencyServiceNumber} from './phone-address.js';

type Queryable={query:(sql:string,params?:unknown[])=>Promise<QueryResult<any>>};
export type LocationLookupKeys={prefixes:string[];areaCode?:string;country?:string};

const OVERRIDES:Record<string,string>={HK:'中国香港',MO:'中国澳门',TW:'中国台湾'};
const regionNames=new Intl.DisplayNames(['zh-Hans'],{type:'region'});
const mobilePrefixes=(digits:string)=>[...new Set([digits.slice(0,8),digits.slice(0,7)])];

/**
 * S96 rules, no DB. A CN national number is a mobile when it is `1` + 10 digits; any other CN
 * national number of landline length (9-11: 2/3-digit area + 7/8-digit local) is a landline, so
 * Beijing `010…` (national `10…`) is a landline. Bare digits without 0/86/+86 are only read as a
 * mobile (partial or full); a bare local landline number is never guessed into an area code.
 */
export function locationLookupKeys(number:unknown,countryIso?:string|null):LocationLookupKeys{
 const none={prefixes:[]};
 const compact=typeof number==='string'?number.trim().replace(/[\s()-]/g,''):'';
 if(!/^\+?\d{1,20}$/.test(compact))return none;
 const digits=compact.replace('+','');
 if(CN_SERVICE_SHORT.test(digits)||isEmergencyServiceNumber(compact))return none;
 const iso=typeof countryIso==='string'?countryIso.toUpperCase():'';
 const region:CountryCode=isSupportedCountry(iso)?iso as CountryCode:'CN';
 if(region==='CN'&&!compact.startsWith('+')&&/^1\d{6,10}$/.test(digits))return {prefixes:mobilePrefixes(digits)};
 const parsed=parsePhoneNumberFromString(compact,{defaultCountry:region,extract:false});
 if(!parsed)return none;
 if(parsed.countryCallingCode==='86'){
  const national=String(parsed.nationalNumber);
  if(CN_SERVICE_SHORT.test(national))return none;
  if(/^1\d{10}$/.test(national))return {prefixes:mobilePrefixes(national)};
  if(/^[1-9]\d{8,10}$/.test(national))return {prefixes:[],areaCode:`0${national.slice(0,/^[12]/.test(national)?2:3)}`};
  return none;
 }
 if(!parsed.isValid()||!parsed.country)return none;
 const country=OVERRIDES[parsed.country]??regionNames.of(parsed.country);
 return country&&country!==parsed.country?{prefixes:[],country}:none;
}

/** The single server-side string; ` · ` is the contract separator. Empty parts are dropped. */
export function formatLocation(row:{province?:string|null;city?:string|null;isp?:string|null}):string|null{
 const province=row.province?.trim()??'',city=row.city?.trim()??'',isp=row.isp?.trim()??'';
 const place=[province,city!==province?city:''].filter(Boolean).join(' ');
 if(!place)return null;
 return isp?`${place} · ${isp}`:place;
}

/**
 * One query over both tables for a page of numbers; keyed by the input `number` string. Never
 * throws: an error yields an empty Map. On a transaction client the caller owns the savepoint.
 */
export async function locateNumbers(db:Queryable,items:{number:string;countryIso?:string|null}[]):Promise<Map<string,string>>{
 const located=new Map<string,string>();
 try{
  const keyed=items.map(item=>({number:item.number,keys:locationLookupKeys(item.number,item.countryIso)}));
  const prefixes=[...new Set(keyed.flatMap(item=>item.keys.prefixes))];
  const areas=[...new Set(keyed.flatMap(item=>item.keys.areaCode?[item.keys.areaCode]:[]))];
  const rows=prefixes.length||areas.length?(await db.query(
   `SELECT 'p' kind,prefix k,province,city,isp FROM phone_location_prefixes WHERE prefix=ANY($1::text[])
    UNION ALL SELECT 'a',area_code,province,city,'固话' FROM phone_location_areas WHERE area_code=ANY($2::text[])`,
   [prefixes,areas],
  )).rows:[];
  const found=new Map<string,string>();
  for(const row of rows){const text=formatLocation(row);if(text)found.set(`${row.kind}:${row.k}`,text);}
  for(const {number,keys} of keyed){
   if(located.has(number))continue;
   const text=keys.country
    ??keys.prefixes.map(prefix=>found.get(`p:${prefix}`)).find(Boolean)
    ??(keys.areaCode?found.get(`a:${keys.areaCode}`):undefined);
   if(text)located.set(number,text);
  }
  return located;
 }catch(error){
  workerError(db as unknown as Db,'phone_location',error);
  return new Map();
 }
}
