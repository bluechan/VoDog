import type {Db} from './db.js';
import type {ApnsClient,WatchPush} from './apns.js';
import {annotateNumbers} from './contacts/repository.js';
import {diag,errorReason,throttled} from './diag.js';

/** S63 missed rule: incoming, never answered, terminal, not blocked, not internal. */
const MISSED=`c.direction='incoming' AND c.answered_at IS NULL AND c.state IN ('ended','failed') AND NOT c.internal_call AND c.failure_reason IS DISTINCT FROM 'number_blocked'`;
/** push-worker.ts conditions for a call that may still ring a client, minus internal calls (S104: the watch never double-rings). */
const ringing=(online:string)=>`c.state='incoming_ringing' AND NOT (c.mode_snapshot='ai' AND c.ai_run_id IS NOT NULL) AND NOT c.internal_call AND c.started_at>now()-interval '2 minutes'
 AND g.control_enabled AND g.telephony_ready AND g.media_ready AND g.last_seen_at>now()-(${online}::text||' seconds')::interval`;
const DESTINATION=`p.platform='watchos' AND p.apns_token IS NOT NULL AND p.disabled_at IS NULL AND s.revoked_at IS NULL AND s.refresh_expires_at>now()`;

/**
 * S104: watchOS alert pushes (call.incoming, then call.answered_elsewhere or call.missed).
 * The delivery table has no lease columns: the `running` guard serialises ticks in-process, a claim
 * bumps attempts+updated_at, and a row is only re-claimed 10 s later (longer than the 8 s APNs timeout).
 */
export class WatchPushWorker {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<number>;
  constructor(private db:Db,private sender:Pick<ApnsClient,'sendWatch'>,private options:{enabled:boolean;onlineSeconds?:number;intervalMs?:number}){}
  start(){if(this.timer||!this.options.enabled)return;this.timer=setInterval(()=>{void this.tickOnce().catch(()=>{});},this.options.intervalMs??1000);this.timer.unref();}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.running;}
  tickOnce():Promise<number>{
    if(!this.options.enabled)return Promise.resolve(0);
    if(this.running)return this.running;
    this.running=this.run().catch(error=>{if(throttled('push.worker_error:watchos'))diag(this.db,'push.worker_error',{worker:'watchos',reason:errorReason(error)},{level:'warn'});throw error;}).finally(()=>{this.running=undefined;});
    return this.running;
  }
  private async run(){
    const online=this.options.onlineSeconds??30;
    // S105: a watch with its own VoIP token rings through CallKit (push-worker.ts), never also by alert.
    await this.db.query(`INSERT INTO watchos_push_deliveries(id,registration_id,call_id,event,state)
      SELECT gen_random_uuid(),p.id,c.id,'call.incoming','pending' FROM call_records c JOIN gateways g ON g.id=c.gateway_id
      JOIN push_registrations p ON p.user_id=c.snapshot_owner_id JOIN sessions s ON s.id=p.session_id
      WHERE ${ringing('$1')} AND ${DESTINATION} AND p.voip_token IS NULL ON CONFLICT DO NOTHING`,[online]);
    // An answered call ends as answered_elsewhere, a missed one as missed; neither (blocked, still
    // connecting) enqueues nothing and is re-checked next tick. 10 min bounds the scan.
    await this.db.query(`INSERT INTO watchos_push_deliveries(id,registration_id,call_id,event,state)
      SELECT gen_random_uuid(),d.registration_id,d.call_id,CASE WHEN c.answered_at IS NOT NULL THEN 'call.answered_elsewhere' ELSE 'call.missed' END,'pending'
      FROM watchos_push_deliveries d JOIN call_records c ON c.id=d.call_id
      WHERE d.event='call.incoming' AND d.state='delivered' AND d.created_at>now()-interval '10 minutes' AND c.state<>'incoming_ringing'
      AND (c.answered_at IS NOT NULL OR (${MISSED})) ON CONFLICT DO NOTHING`);
    await this.db.query(`UPDATE watchos_push_deliveries d SET state='cancelled',last_error='call_no_longer_ringing',updated_at=now()
      FROM call_records c WHERE d.call_id=c.id AND d.event='call.incoming' AND d.state='pending' AND c.state<>'incoming_ringing'`);
    const jobs=await this.db.query(`WITH ready AS (SELECT id FROM watchos_push_deliveries WHERE state='pending'
      AND (attempts=0 OR updated_at<now()-interval '10 seconds') ORDER BY created_at,id LIMIT 4 FOR UPDATE SKIP LOCKED)
      UPDATE watchos_push_deliveries d SET attempts=attempts+1,updated_at=now() FROM ready WHERE d.id=ready.id RETURNING d.*`);
    await Promise.all(jobs.rows.map(job=>this.deliver(job)));
    return jobs.rowCount??0;
  }
  private async deliver(job:any){
    const event=job.event as WatchPush['event'];
    const incoming=event==='call.incoming',condition=incoming?ringing('$3'):`c.state<>'incoming_ringing'`;
    const row=(await this.db.query(`SELECT p.apns_token,p.environment,c.remote_number,c.snapshot_owner_id,c.answered_by_platform,sim.country_iso,
      COALESCE(NULLIF(sim.label,''),sim.phone_label) sim_label
      FROM push_registrations p JOIN sessions s ON s.id=p.session_id
      JOIN call_records c ON c.id=$2 AND c.snapshot_owner_id=p.user_id JOIN gateways g ON g.id=c.gateway_id
      LEFT JOIN sims sim ON sim.id=c.sim_id WHERE p.id=$1 AND ${DESTINATION} AND ${condition}`,
      incoming?[job.registration_id,job.call_id,this.options.onlineSeconds??30]:[job.registration_id,job.call_id])).rows[0];
    if(!row){await this.finish(job,'cancelled','destination_or_call_inactive');return;}
    const annotation=await annotateNumbers(this.db,row.snapshot_owner_id,[{remoteNumber:row.remote_number,countryIso:row.country_iso}],'call')
      .then(([value])=>value).catch(()=>undefined);
    try{
      const result=await this.sender.sendWatch(row.apns_token,row.environment,{event,callId:job.call_id,deliveryId:job.id,contactName:annotation?.contactName??null,
        remoteNumber:row.remote_number,simLabel:row.sim_label??null,remoteLocation:annotation?.remoteLocation??null,answeredBy:row.answered_by_platform??null});
      if(result.status===200){await this.finish(job,'delivered',null);return;}
      if(result.status===410||result.reason==='BadDeviceToken'||result.reason==='DeviceTokenNotForTopic')await this.db.query('UPDATE push_registrations SET apns_token=NULL,updated_at=now() WHERE id=$1 AND apns_token=$2',[job.registration_id,row.apns_token]);
      const retry=(result.status===429||result.status>=500)&&job.attempts<3;
      await this.finish(job,retry?'pending':'failed',`APNS_${result.status}_${result.reason??'rejected'}`);
    }catch{await this.finish(job,job.attempts<3?'pending':'failed','APNS_CONNECTION_FAILED');}
  }
  // Wins over a concurrent ringing-ended `cancelled`: a push that really went out is `delivered`, so its end event follows.
  private async finish(job:any,state:'pending'|'delivered'|'failed'|'cancelled',error:string|null){
    await this.db.query('UPDATE watchos_push_deliveries SET state=$3,last_error=$4,updated_at=now() WHERE id=$1 AND attempts=$2',[job.id,job.attempts,state,error]);
  }
}
