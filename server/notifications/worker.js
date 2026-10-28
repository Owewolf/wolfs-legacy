'use strict';
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createNotificationService,derivedCode,secretReady,audit}=require('./service');
const {utc}=require('./time');
const {renderTemplate}=require('./templates');
const {parseReply}=require('./parser');
const {createSmtpTransport,createImapReceiver}=require('./transport');

function createNotificationWorker({db,env=process.env,now=()=>new Date(),smtp,imap,parse=parseReply,alert=promisify(execFile)}={}) {
  const service=createNotificationService({db,env,now});
  const at=service.timestamp;
  let busy=false,stopped=false,timer;
  function safeError(error,channel) {
    const allowed=['EMAIL_CONFIGURATION','SMTP_REJECTED','SMTP_UNAVAILABLE','IMAP_UNAVAILABLE','INVALID_EVENT_PAYLOAD'];
    return allowed.includes(error?.code)?error.code:`${channel.toUpperCase()}_UNAVAILABLE`;
  }
  async function health(channel,error=null) {
    const stamp=at();
    const old=db.prepare('SELECT * FROM notification_health WHERE channel=?').get(channel);
    if(!error) {
      db.prepare(`INSERT INTO notification_health (channel,status,last_success_at) VALUES (?,'ready',?)
        ON CONFLICT(channel) DO UPDATE SET status='ready',failures=0,first_failed_at=NULL,last_success_at=excluded.last_success_at,last_error=NULL`)
        .run(channel,stamp);return;
    }
    const reason=safeError(error,channel),failures=(old?.failures||0)+1;
    db.prepare(`INSERT INTO notification_health (channel,status,failures,first_failed_at,last_failure_at,last_error)
      VALUES (?,'degraded',?,?,?,?) ON CONFLICT(channel) DO UPDATE SET status='degraded',failures=excluded.failures,
      first_failed_at=COALESCE(notification_health.first_failed_at,excluded.first_failed_at),last_failure_at=excluded.last_failure_at,last_error=excluded.last_error`)
      .run(channel,failures,stamp,stamp,reason);
    if(failures<3 || (old?.alerted_at && utc(stamp)-utc(old.alerted_at)<3600000)) return;
    db.transaction(()=>{
      db.prepare('UPDATE notification_health SET alerted_at=? WHERE channel=?').run(stamp,channel);
      audit(db,null,'notification_transport_degraded',channel,stamp);
      for(const s of db.prepare('SELECT user_id FROM notification_settings WHERE verified_at IS NOT NULL').all())
        service.queue('transport_health',s.user_id,{timestamp:stamp,status:'degraded'},{key:`health:${channel}:${s.user_id}:${stamp.slice(0,13)}`});
    })();
    if(env.NOTIFICATION_ALERT_COMMAND) {
      try {
        if(!env.NOTIFICATION_ALERT_COMMAND.startsWith('/') || /[\r\n\0]/.test(env.NOTIFICATION_ALERT_COMMAND)) throw new Error('invalid_alert_command');
        await alert(env.NOTIFICATION_ALERT_COMMAND,[JSON.stringify({channel,status:'degraded',failures})],{timeout:10000,maxBuffer:1024,env:{PATH:'/usr/bin:/bin'}});
        db.prepare(`INSERT INTO notification_health (channel,status,last_success_at) VALUES ('alternate','ready',?)
          ON CONFLICT(channel) DO UPDATE SET status='ready',last_success_at=excluded.last_success_at,last_error=NULL`).run(stamp);
      } catch {
        db.prepare(`INSERT INTO notification_health (channel,status,last_error,last_failure_at) VALUES ('alternate','degraded','ALTERNATE_FAILED',?)
          ON CONFLICT(channel) DO UPDATE SET status='degraded',last_error='ALTERNATE_FAILED',last_failure_at=excluded.last_failure_at`).run(stamp);
      }
    }
  }
  function recoverInterrupted() {
    // A provider may have accepted DATA before the process died. Automatic
    // resend would claim delivery certainty that SMTP cannot supply.
    db.transaction(()=>{
      for(const job of db.prepare("SELECT * FROM notification_outbox WHERE status='sending'").all()) {
        db.prepare("UPDATE notification_outbox SET status='uncertain',last_error='SMTP_INTERRUPTED',updated_at=? WHERE id=?").run(at(),job.id);
        db.prepare(`INSERT OR IGNORE INTO notification_attempts (outbox_id,attempt_number,outcome,provider_code,created_at)
          VALUES (?,?,'uncertain','SMTP_INTERRUPTED',?)`).run(job.id,job.attempts,at());
        audit(db,job.user_id,'notification_send_uncertain',`outbox=${job.id}`,at());
      }
    })();
  }
  function claim() {
    return db.transaction(()=>{
      const stamp=at();
      db.prepare("UPDATE notification_outbox SET status='retried',updated_at=? WHERE status='failed' AND next_attempt_at<=?").run(stamp,stamp);
      const job=db.prepare(`SELECT * FROM notification_outbox WHERE status IN ('queued','retried') AND schedule_at<=?
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        ORDER BY CASE WHEN event_type='deadswitch_released' THEN 0 ELSE 1 END,schedule_at,id LIMIT 1`).get(stamp,stamp);
      if(!job) return null;
      const messageId=job.message_id||`<wl-${crypto.randomUUID()}@${String(env.SMTP_FROM||'notifications.invalid').split('@').pop()}>`;
      const change=db.prepare(`UPDATE notification_outbox SET status='sending',attempts=attempts+1,locked_at=?,message_id=?,updated_at=?
        WHERE id=? AND status IN ('queued','retried')`).run(stamp,messageId,stamp,job.id);
      return change.changes ? {...job,message_id:messageId,attempts:job.attempts+1} : null;
    }).immediate();
  }
  function cancel(job,reason) {
    db.prepare("UPDATE notification_outbox SET status='cancelled',last_error=?,updated_at=? WHERE id=? AND status='sending'").run(reason,at(),job.id);
  }
  async function send(job) {
    let acceptedAtProvider=false;
    try {
    const s=service.settings(job.user_id);
    if(!s?.recipient || (job.event_type!=='verify_address' && !s.verified_at)) {cancel(job,'RECIPIENT_UNVERIFIED');return;}
    let payload;
    try {payload=JSON.parse(job.data_json);} catch {throw Object.assign(new Error('Invalid event'),{code:'INVALID_EVENT_PAYLOAD',transient:false});}
    if(job.event_type==='reminder') {
      payload=service.prepareReminder(job);
      if(!payload) {cancel(job,'REMINDER_SUPERSEDED_OR_MISSED');return;}
    } else if(job.event_type==='verify_address') {
      if(s.verify_nonce!==payload.nonce || !s.verify_hash || s.verify_expires_at<=at()) {cancel(job,'VERIFICATION_EXPIRED');return;}
      payload={verificationCode:derivedCode(env,'verify',payload.nonce),expiresAt:s.verify_expires_at};
    } else if(job.event_type==='email_test') payload={timestamp:at()};
    let rendered;
    try {rendered=renderTemplate(job.event_type,payload);} catch {throw Object.assign(new Error('Invalid event'),{code:'INVALID_EVENT_PAYLOAD',transient:false});}
      smtp ||= createSmtpTransport(env);
      const result=await smtp.sendMail({to:s.recipient,messageId:job.message_id,
        priority:job.event_type==='deadswitch_released'?'high':'normal',...rendered});
      if(result.status!=='sent_to_server' || result.acceptedCount!==1 || result.rejectedCount) throw Object.assign(new Error('SMTP result'),{code:'SMTP_REJECTED',transient:false});
      acceptedAtProvider=true;
      db.transaction(()=>{
        db.prepare(`UPDATE notification_outbox SET status='sent_to_server',sent_at=?,updated_at=?,last_error=NULL WHERE id=?`).run(at(),at(),job.id);
        db.prepare(`INSERT INTO notification_attempts (outbox_id,attempt_number,outcome,created_at) VALUES (?,?,'sent_to_server',?)`).run(job.id,job.attempts,at());
      })();
    } catch(error) {
      const reason=safeError(error,'smtp');
      const uncertain=acceptedAtProvider || !!error.ambiguous;
      const terminal=error.transient===false || job.attempts>=5;
      const status=uncertain?'uncertain':terminal?'dead_letter':'failed';
      const delay=[60000,300000,1800000,7200000][Math.min(job.attempts-1,3)];
      const next=new Date(utc(at()).getTime()+delay).toISOString();
      db.transaction(()=>{
        db.prepare('UPDATE notification_outbox SET status=?,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?')
          .run(status,reason,status==='failed'?next:null,at(),job.id);
        db.prepare(`INSERT INTO notification_attempts (outbox_id,attempt_number,outcome,provider_code,created_at) VALUES (?,?,?,?,?)`)
          .run(job.id,job.attempts,status,String(error.responseCode||reason),at());
        audit(db,job.user_id,'notification_send_'+status,`outbox=${job.id};reason=${reason}`,at());
      })();
      await health('smtp',error);
      return;
    }
    // Health storage must never rewrite a durably accepted message as failed.
    await health('smtp');
  }
  async function inbound() {
    try {
      imap ||= createImapReceiver(env);
      await imap.poll({
        getCheckpoint:({account,mailbox,uidValidity})=>db.prepare('SELECT last_uid FROM inbound_checkpoints WHERE account=? AND mailbox=? AND uid_validity=?').get(account,mailbox,uidValidity)?.last_uid,
        saveCheckpoint:({account,mailbox,uidValidity,lastUid})=>db.prepare(`INSERT INTO inbound_checkpoints (account,mailbox,uid_validity,last_uid) VALUES (?,?,?,?)
          ON CONFLICT(account,mailbox,uid_validity) DO UPDATE SET last_uid=MAX(last_uid,excluded.last_uid)`).run(account,mailbox,uidValidity,lastUid),
        hasProcessed:identity=>!!db.prepare('SELECT 1 FROM inbound_message_log WHERE identity=?').get(identity),
        processMessage:async message=>{
          const parsed=message.rejectionReason?{ok:false,reason:'too_large'}:await parse(message.source,{replyMailbox:env.CHECKIN_REPLY_MAILBOX,
            trustedAuthservIds:env.CHECKIN_TRUSTED_AUTHSERV_IDS});
          return service.processParsedReply(message.identity,parsed);
        }
      });
      await health('imap');
    } catch(error) {await health('imap',error);}
  }
  async function tick() {
    if(busy || stopped || env.NOTIFICATIONS_ENABLED!=='true') return;
    busy=true;
    try {
      service.reconcile();
      if(!secretReady(env) || (env.NOTIFICATION_REMINDER_DAYS && env.NOTIFICATION_REMINDER_DAYS!=='5') ||
          (env.NOTIFICATION_TIMEZONE && env.NOTIFICATION_TIMEZONE!=='Africa/Johannesburg')) {
        await health('smtp',{code:'EMAIL_CONFIGURATION'});await health('imap',{code:'EMAIL_CONFIGURATION'});return;
      }
      // Process replies before queued mail so a confirmed cycle stops its jobs.
      await inbound();
      for(let i=0;i<20 && !stopped;i++) {const job=claim();if(!job)break;await send(job);}
    } catch {
      await health('worker',{code:'WORKER_UNAVAILABLE'});
    } finally {busy=false;}
  }
  function start() {
    recoverInterrupted();
    const run=()=>tick().catch(()=>require('../logger').error('Notification worker persistence unavailable'));
    run();timer=setInterval(run,30000);timer.unref?.();return {stop};
  }
  function stop() {stopped=true;clearInterval(timer);smtp?.close?.();}
  return {tick,start,stop,recoverInterrupted,health,service};
}
module.exports={createNotificationWorker};
