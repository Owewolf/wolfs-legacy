#!/usr/bin/env node
'use strict';
// Read only the disposable acceptance database. Never import application db/config.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
const DAY=86400000;
const CHECKS=['run_selected','owner_enrollment_verified','one_accepted_reply','one_confirmation_used',
  'challenge_used_once_and_linked','receipt_before_release','challenge_expiry_bounded','last_checkin_matches_receipt','initial_cycle_matches_30_plus_7',
  'new_cycle_matches_30_plus_7','new_five_reminders_scheduled','old_cycle_superseded','old_reminders_stopped',
  'old_challenges_invalidated','switch_stays_active_untriggered','emergency_request_preserved','prior_grant_preserved',
  'acknowledgement_submitted','acknowledgement_matches_new_deadlines','transactional_audit_matches',
  'reminder_observed_in_mailbox','acknowledgement_observed_in_mailbox'];
function fail(code){const error=new Error(code);error.code=code;throw error;}
function regular(file){const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1;}
function utc(value){return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));}
function same(a,b){return utc(a)&&utc(b)&&a===b;}
function messageId(value){return typeof value==='string'&&value.length<400&&/^<wl-[a-z0-9-]+@[a-z0-9.-]+>$/i.test(value);}

function openSession(sessionFile){
  if(!path.isAbsolute(sessionFile)||!regular(sessionFile))fail('invalid_session_file');
  const session=JSON.parse(fs.readFileSync(sessionFile,'utf8'));
  const temp=fs.realpathSync(os.tmpdir()),staging=session.staging;
  if(typeof staging!=='string'||!path.isAbsolute(staging)||path.dirname(staging)!==temp||
    !/^wolfs-legacy-email-acceptance-[a-zA-Z0-9]{6,}$/.test(path.basename(staging))||
    fs.realpathSync(staging)!==staging||!fs.lstatSync(staging).isDirectory())fail('invalid_acceptance_staging_path');
  const data=path.join(staging,'data'),file=path.join(data,'vault.db');
  if(fs.realpathSync(data)!==data||!regular(file)||fs.realpathSync(file)!==file||!regular(path.join(staging,'bootstrap.js')))
    fail('invalid_acceptance_database_path');
  // The directory guard excludes production paths; rejecting symlinks/hardlinks
  // prevents a staged filename from redirecting this reader to the live vault.
  const db=new Database(file,{readonly:true,fileMustExist:true,timeout:1000});
  db.pragma('query_only=ON');
  return {db,session};
}

function inspectDatabase(db,userId){
  const report={version:1,generated_at:new Date().toISOString(),outcome:'pending',database_verified:false,
    round_trip_verified:false,reason:'awaiting_test_owner_or_reminder',
    invariants:Object.fromEntries(CHECKS.map(key=>[key,false])),counts:{},timestamps:{},
    mailbox:{status:'not_requested',reminder_observed:false,acknowledgement_observed:false}};
  const all=db.prepare('SELECT user_id,started_at,cycle_id,initial_last_check_in,beneficiary_ids FROM acceptance_runs').all();
  report.counts.acceptance_runs=all.length;
  if(userId!==undefined&&(!Number.isSafeInteger(userId)||userId<1))fail('invalid_user_id');
  if(userId===undefined&&all.length>1)fail('select_one_test_owner_with_user_id');
  const run=userId===undefined?all[0]:all.find(item=>item.user_id===userId);
  if(!run)return {report};
  const c=report.invariants;c.run_selected=true;
  const user=db.prepare('SELECT last_check_in FROM users WHERE id=?').get(run.user_id);
  const config=db.prepare('SELECT * FROM dead_switch_config WHERE user_id=?').get(run.user_id);
  const settings=db.prepare('SELECT verified_at,reply_enabled,config_status,timezone FROM notification_settings WHERE user_id=?').get(run.user_id);
  c.owner_enrollment_verified=!!(settings&&utc(settings.verified_at)&&settings.verified_at<=run.started_at&&
    settings.reply_enabled===1&&settings.config_status==='ready'&&settings.timezone==='Africa/Johannesburg');
  const accepted=db.prepare("SELECT identity,received_at,cycle_id FROM inbound_message_log WHERE user_id=? AND outcome='accepted' AND received_at>=?").all(run.user_id,run.started_at);
  const used=db.prepare('SELECT id,outbox_id,message_id,issued_at,expires_at,used_at,revoked_at,inbound_identity,protocol_version FROM checkin_challenges WHERE user_id=? AND cycle_id=? AND used_at IS NOT NULL').all(run.user_id,run.cycle_id);
  report.counts.accepted_replies=accepted.length;report.counts.consumed_confirmations=used.length;report.counts.used_challenges=used.length;
  c.one_accepted_reply=accepted.length===1&&accepted[0].cycle_id===run.cycle_id&&utc(accepted[0].received_at);
  c.one_confirmation_used=used.length===1&&used[0].protocol_version===2&&same(used[0].used_at,accepted[0]?.received_at);
  const receipt=accepted.length===1?accepted[0]:null,challenge=used.length===1?used[0]:null;
  c.challenge_used_once_and_linked=!!(challenge&&receipt&&same(challenge.used_at,receipt.received_at)&&
    challenge.inbound_identity===receipt.identity&&!challenge.revoked_at&&utc(challenge.issued_at)&&utc(challenge.expires_at)&&
    challenge.issued_at<=receipt.received_at&&challenge.expires_at>receipt.received_at);
  c.last_checkin_matches_receipt=!!receipt&&same(user?.last_check_in,receipt.received_at);
  const old=db.prepare('SELECT * FROM notification_cycles WHERE id=? AND user_id=?').get(run.cycle_id,run.user_id);
  const next=config?.notification_cycle_id?db.prepare('SELECT * FROM notification_cycles WHERE id=? AND user_id=?').get(config.notification_cycle_id,run.user_id):null;
  c.receipt_before_release=!!(receipt&&old&&utc(receipt.received_at)&&utc(old.expiry_at)&&receipt.received_at<old.expiry_at);
  c.challenge_expiry_bounded=!!(challenge&&old&&utc(challenge.issued_at)&&utc(challenge.expires_at)&&utc(old.expiry_at)&&
    Date.parse(challenge.expires_at)>Date.parse(challenge.issued_at)&&
    Date.parse(challenge.expires_at)<=Math.min(Date.parse(challenge.issued_at)+DAY,Date.parse(old.expiry_at)));
  c.initial_cycle_matches_30_plus_7=!!(old&&same(old.last_checkin_at,run.initial_last_check_in)&&utc(old.due_at)&&utc(old.expiry_at)&&
    Date.parse(old.due_at)-Date.parse(old.last_checkin_at)===30*DAY&&Date.parse(old.expiry_at)-Date.parse(old.last_checkin_at)===37*DAY);
  c.old_cycle_superseded=old?.status==='superseded';
  c.new_cycle_matches_30_plus_7=!!(receipt&&next&&next.id!==run.cycle_id&&next.status==='open'&&next.reason==='verified_email_reply'&&
    same(next.last_checkin_at,receipt.received_at)&&utc(next.due_at)&&utc(next.expiry_at)&&
    Date.parse(next.due_at)-Date.parse(receipt.received_at)===30*DAY&&Date.parse(next.expiry_at)-Date.parse(receipt.received_at)===37*DAY);
  const newJobs=next?db.prepare("SELECT reminder_number,schedule_at,status FROM notification_outbox WHERE cycle_id=? AND user_id=? AND event_type='reminder' ORDER BY reminder_number").all(next.id,run.user_id):[];
  // Johannesburg has the same UTC offset on all five dates. The harness uses
  // the expiry clock (no configured override), with scheduler second precision.
  c.new_five_reminders_scheduled=!!(next&&settings?.timezone==='Africa/Johannesburg'&&newJobs.length===5&&
    newJobs.every((job,index)=>job.reminder_number===index+1&&job.status==='queued'&&utc(job.schedule_at)&&receipt&&job.schedule_at>receipt.received_at&&
      Date.parse(job.schedule_at)===Math.floor(Date.parse(next.expiry_at)/1000)*1000-(5-index)*DAY));
  const oldJobs=db.prepare("SELECT id,status,message_id,schedule_at FROM notification_outbox WHERE cycle_id=? AND user_id=? AND event_type='reminder'").all(run.cycle_id,run.user_id);
  const reminder=challenge?oldJobs.find(job=>job.id===challenge.outbox_id):null;
  const submitted=job=>!!job&&['sent_to_server','delivered'].includes(job.status)&&messageId(job.message_id)&&
    db.prepare("SELECT COUNT(*) n FROM notification_attempts WHERE outbox_id=? AND outcome='sent_to_server'").get(job.id).n===1;
  c.old_reminders_stopped=oldJobs.length===5&&!!challenge&&submitted(reminder)&&reminder.message_id===challenge.message_id&&
    oldJobs.every(job=>job.id===challenge.outbox_id||job.status==='cancelled');
  c.old_challenges_invalidated=db.prepare('SELECT COUNT(*) n FROM checkin_challenges WHERE user_id=? AND cycle_id=? AND used_at IS NULL AND revoked_at IS NULL').get(run.user_id,run.cycle_id).n===0;
  c.switch_stays_active_untriggered=!!(config&&config.is_active===1&&config.switch_triggered===0&&config.switch_triggered_at===null&&
    config.check_in_interval_days===30&&config.grace_period_days===7);
  let ids;try{ids=JSON.parse(run.beneficiary_ids);}catch{ids=[];}
  if(Array.isArray(ids)&&ids.length===2&&ids[0]!==ids[1]&&ids.every(id=>Number.isSafeInteger(id)&&id>0)){
    const fields='user_id,emergency_waiting_days,emergency_access_requested,emergency_access_requested_at,access_granted,access_granted_at';
    const emergency=db.prepare(`SELECT ${fields} FROM beneficiaries WHERE id=?`).get(ids[0]);
    const granted=db.prepare(`SELECT ${fields} FROM beneficiaries WHERE id=?`).get(ids[1]);
    c.emergency_request_preserved=!!(emergency&&emergency.user_id===run.user_id&&emergency.emergency_waiting_days===90&&
      emergency.emergency_access_requested===1&&same(emergency.emergency_access_requested_at,run.started_at)&&emergency.access_granted===0&&emergency.access_granted_at===null);
    c.prior_grant_preserved=!!(granted&&granted.user_id===run.user_id&&granted.emergency_waiting_days===90&&
      granted.emergency_access_requested===0&&granted.emergency_access_requested_at===null&&granted.access_granted===1&&same(granted.access_granted_at,run.started_at));
  }
  const acks=next?db.prepare("SELECT id,status,message_id,data_json FROM notification_outbox WHERE user_id=? AND cycle_id=? AND event_type='checkin_confirmed'").all(run.user_id,next.id):[];
  const ack=acks.length===1?acks[0]:null;c.acknowledgement_submitted=submitted(ack);
  let payload;try{payload=JSON.parse(ack?.data_json||'null');}catch{payload=null;}
  c.acknowledgement_matches_new_deadlines=!!(payload&&receipt&&next&&same(payload.confirmedAt,receipt.received_at)&&
    same(payload.nextCheckinAt,next.due_at)&&same(payload.nextReleaseAt,next.expiry_at));
  const audits=db.prepare("SELECT detail,created_at FROM audit_log WHERE user_id=? AND action='email_checkin_accepted' AND created_at>=?").all(run.user_id,run.started_at);
  c.transactional_audit_matches=!!(receipt&&next&&audits.length===1&&same(audits[0].created_at,receipt.received_at)&&
    audits[0].detail===`previous_cycle=${run.cycle_id};cycle=${next.id}`);
  report.timestamps={run_started_at:utc(run.started_at)?run.started_at:null,initial_last_check_in:utc(run.initial_last_check_in)?run.initial_last_check_in:null,
    accepted_at:utc(receipt?.received_at)?receipt.received_at:null,last_check_in:utc(user?.last_check_in)?user.last_check_in:null,
    new_due_at:utc(next?.due_at)?next.due_at:null,new_release_at:utc(next?.expiry_at)?next.expiry_at:null};
  const databaseKeys=CHECKS.filter(key=>!key.endsWith('_observed_in_mailbox'));
  report.database_verified=databaseKeys.every(key=>c[key]===true);
  const awaitingSubmission=!!(ack&&['queued','sending','failed','retried','dead_letter','uncertain'].includes(ack.status)&&
    databaseKeys.filter(key=>key!=='acknowledgement_submitted').every(key=>c[key]===true));
  report.reason=report.database_verified?'mailbox_observation_required':accepted.length===0?'awaiting_valid_email_confirmation':
    awaitingSubmission?'awaiting_acknowledgement_submission':'database_invariant_failed';
  if(accepted.length>0&&!report.database_verified&&!awaitingSubmission)report.outcome='failed';
  return {report,ids:report.database_verified?{reminder:reminder.message_id,acknowledgement:ack.message_id}:null};
}

async function observeMailbox(ids,env,{createClient}={}){
  if(!ids||!messageId(ids.reminder)||!messageId(ids.acknowledgement))fail('invalid_message_identity');
  const host=env.CHECKIN_IMAP_HOST,port=Number(env.CHECKIN_IMAP_PORT||993),mailbox=env.CHECKIN_IMAP_MAILBOX||'INBOX';
  if(typeof host!=='string'||!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host)||port!==993||typeof mailbox!=='string'||mailbox.length>200||/[\x00-\x1f\x7f]/.test(mailbox)||
    ![env.CHECKIN_IMAP_USERNAME,env.CHECKIN_IMAP_PASSWORD].every(value=>typeof value==='string'&&value&&!/[\r\n\0]/.test(value)))fail('mailbox_configuration_required');
  const factory=createClient||(options=>new(require('imapflow').ImapFlow)(options));
  const client=factory({host,port,secure:true,auth:{user:env.CHECKIN_IMAP_USERNAME,pass:env.CHECKIN_IMAP_PASSWORD},
    tls:{minVersion:'TLSv1.2',rejectUnauthorized:true,servername:host},logger:false,logRaw:false,emitLogs:false,
    disableAutoIdle:true,disableCompression:true,connectionTimeout:15000,greetingTimeout:10000,socketTimeout:30000,
    maxLiteralSize:4096,maxLineLength:4096,maxResponseSize:8192});
  let lock;
  try{
    client.on?.('error',()=>{});await client.connect();lock=await client.getMailboxLock(mailbox,{readOnly:true});
    const found={};
    for(const [kind,id]of Object.entries(ids)){
      const candidates=await client.search({header:{'message-id':id}},{uid:true});
      if(!Array.isArray(candidates)||candidates.length>20)fail('mailbox_search_ambiguous');
      found[kind]=false;
      for(const uid of [...new Set(candidates)]){
        if(!Number.isSafeInteger(uid)||uid<1)fail('mailbox_search_ambiguous');
        // IMAP HEADER search is a substring match. Fetch only this header to
        // verify exact equality; never request envelope, body, MIME or source.
        const row=await client.fetchOne(uid,{uid:true,headers:['message-id']},{uid:true});
        if(!Buffer.isBuffer(row?.headers)||row.headers.length>4096)fail('mailbox_header_unavailable');
        const unfolded=row.headers.toString('utf8').replace(/\r?\n[ \t]+/g,' ');
        const values=[...unfolded.matchAll(/^message-id:\s*([^\r\n]+)$/gmi)].map(match=>match[1].trim());
        if(values.length===1&&values[0]===id){found[kind]=true;break;}
      }
    }
    return {status:found.reminder&&found.acknowledgement?'observed':'pending',reminder_observed:found.reminder,
      acknowledgement_observed:found.acknowledgement,observed_at:new Date().toISOString()};
  }finally{try{lock?.release();}catch{}try{await client.logout();}catch{try{client.close();}catch{}}}
}

async function collectEvidence({sessionFile=path.resolve(__dirname,'../data/email-acceptance-session.json'),userId,checkMailbox=false,env,createClient}={}){
  const {db}=openSession(sessionFile);let snapshot;
  try{snapshot=db.transaction(()=>inspectDatabase(db,userId))();}finally{db.close();}
  const {report,ids}=snapshot;
  if(checkMailbox&&report.database_verified){
    try{
      const mailEnv=env||require('dotenv').parse(fs.readFileSync(path.resolve(__dirname,'../.env')));
      report.mailbox=await observeMailbox(ids,mailEnv,{createClient});
      report.invariants.reminder_observed_in_mailbox=report.mailbox.reminder_observed;
      report.invariants.acknowledgement_observed_in_mailbox=report.mailbox.acknowledgement_observed;
      report.reason=report.mailbox.status==='observed'?'verified':'awaiting_mailbox_receipt';
    }catch{report.mailbox={status:'unavailable',reminder_observed:false,acknowledgement_observed:false};report.reason='mailbox_observation_unavailable';}
  }
  report.round_trip_verified=Object.values(report.invariants).every(value=>value===true);
  if(report.round_trip_verified)report.outcome='verified';
  return report;
}

async function main(args){
  const options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--check-mailbox')options.checkMailbox=true;
    else if(args[i]==='--session'&&args[i+1])options.sessionFile=args[++i];
    else if(args[i]==='--user-id'&&/^\d+$/.test(args[i+1]||''))options.userId=Number(args[++i]);
    else{process.stderr.write('Usage: node scripts/email-acceptance-evidence.js [--session /absolute/session.json] [--user-id integer] [--check-mailbox]\n');return 1;}
  }
  try{const report=await collectEvidence(options);process.stdout.write(JSON.stringify(report,null,2)+'\n');return report.outcome==='verified'?0:report.outcome==='pending'?2:1;}
  catch{process.stdout.write(JSON.stringify({version:1,outcome:'error',reason:'invalid_session_or_evidence',round_trip_verified:false})+'\n');return 1;}
}
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(()=>{process.exitCode=1;});
module.exports={collectEvidence,inspectDatabase,observeMailbox,openSession,main};
