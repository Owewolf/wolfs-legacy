'use strict';
const crypto = require('node:crypto');
const { DAY, utc, localDate, deadlines, reminderSlots } = require('./time');

const PENDING = "('queued','retried','failed','sending')";
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(prefix, bytes=crypto.randomBytes(20)) {
  // 160 independent random bits, encoded in the 32-symbol alphabet.
  let bits=0,value=0,out='';
  for(const byte of bytes) { value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+=alphabet[(value>>>bits)&31];} }
  if(bits) out+=alphabet[(value<<(5-bits))&31];
  return prefix+'-'+out.match(/.{1,4}/g).join('-');
}
function normalizeCode(value) { return typeof value==='string' ? value.trim().toUpperCase() : ''; }
function digest(purpose,value) { return crypto.createHash('sha256').update(purpose+'\0'+normalizeCode(value)).digest('hex'); }
function equal(a,b) {
  return typeof a==='string' && typeof b==='string' && a.length===b.length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
}
function secretReady(env) { return /^[a-f0-9]{64}$/i.test(env.NOTIFICATION_SECRET || ''); }
function derivedCode(env,purpose,nonce) {
  if(!secretReady(env)) throw new Error('notification_secret_unconfigured');
  return code(purpose==='verify'?'NV':'WL',crypto.createHmac('sha256',Buffer.from(env.NOTIFICATION_SECRET,'hex')).update(purpose+'\0'+nonce).digest().subarray(0,20));
}
function audit(db,userId,action,detail,at) {
  // Unlike the legacy best-effort helper, security/outbox audit is transactional.
  return db.prepare('INSERT INTO audit_log (user_id,action,target_type,detail,created_at) VALUES (?,?,?,?,?)')
    .run(userId,action,'notification',detail || null,at);
}

function createNotificationService({db,env=process.env,now=()=>new Date()}={}) {
  const timestamp=()=>utc(now()).toISOString();
  const settings=id=>db.prepare('SELECT * FROM notification_settings WHERE user_id=?').get(id);
  function ensureSettings(id) {
    db.prepare('INSERT OR IGNORE INTO notification_settings (user_id,timezone,updated_at) VALUES (?,?,?)')
      .run(id,'Africa/Johannesburg',timestamp());
    return settings(id);
  }
  function queue(type,userId,data={},options={}) {
    const s=settings(userId);
    if(type!=='verify_address' && (!s?.verified_at || !s.recipient)) return null;
    const at=timestamp();
    const r=db.prepare(`INSERT OR IGNORE INTO notification_outbox
      (event_type,user_id,beneficiary_id,cycle_id,idempotency_key,schedule_at,reminder_number,reminder_date,data_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(type,userId,options.beneficiaryId||null,options.cycleId||null,
        options.key||`${type}:${userId}:${crypto.randomUUID()}`,options.at||at,options.number||null,options.date||null,JSON.stringify(data),at,at);
    return r.changes ? Number(r.lastInsertRowid) : null;
  }
  function cancelCycle(cycleId,at=timestamp()) {
    if(!cycleId) return;
    db.prepare("UPDATE notification_cycles SET status='superseded' WHERE id=? AND status='open'").run(cycleId);
    db.prepare(`UPDATE notification_outbox SET status='cancelled',updated_at=? WHERE cycle_id=? AND event_type='reminder' AND status IN ${PENDING}`).run(at,cycleId);
    db.prepare('UPDATE checkin_challenges SET revoked_at=? WHERE cycle_id=? AND used_at IS NULL AND revoked_at IS NULL').run(at,cycleId);
  }
  function schedule(cycle,at=timestamp()) {
    const s=settings(cycle.user_id);
    if(!s?.reply_enabled || !s.verified_at || s.config_status!=='ready' || cycle.status!=='open') return;
    for(const slot of reminderSlots(cycle.expiry_at,s.timezone,s.reminder_clock)) {
      // Never backfill missed slots, including on first enable or after restore.
      if(slot.at<at) continue;
      queue('reminder',cycle.user_id,{releaseAt:cycle.expiry_at,daysRemaining:slot.daysRemaining,reminderNumber:slot.number},
        {cycleId:cycle.id,key:`reminder:${cycle.id}:${slot.number}`,at:slot.at,number:slot.number,date:slot.date});
    }
  }
  function newCycle(userId,reason='checkin',at=timestamp()) {
    const c=db.prepare(`SELECT d.*,u.last_check_in FROM dead_switch_config d JOIN users u ON u.id=d.user_id WHERE d.user_id=?`).get(userId);
    if(!c) return null;
    cancelCycle(c.notification_cycle_id,at);
    if(!c.is_active) { db.prepare('UPDATE dead_switch_config SET notification_cycle_id=NULL WHERE user_id=?').run(userId);return null; }
    const times=deadlines(c.last_check_in,c.check_in_interval_days,c.grace_period_days);
    const id=crypto.randomUUID();
    const status=c.switch_triggered?'released':'open';
    db.prepare(`INSERT INTO notification_cycles (id,user_id,last_checkin_at,due_at,expiry_at,status,created_at,reason) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id,userId,times.lastCheckinAt,times.nextCheckinAt,times.releaseAt,status,at,reason);
    db.prepare('UPDATE dead_switch_config SET notification_cycle_id=? WHERE user_id=?').run(id,userId);
    const cycle=db.prepare('SELECT * FROM notification_cycles WHERE id=?').get(id);
    schedule(cycle,at);return cycle;
  }
  function reconcile() {
    return db.transaction(()=>{
      const at=timestamp();
      const configs=db.prepare('SELECT d.*,u.last_check_in FROM dead_switch_config d JOIN users u ON u.id=d.user_id').all();
      for(const c of configs) {
        const cycle=c.notification_cycle_id && db.prepare('SELECT * FROM notification_cycles WHERE id=?').get(c.notification_cycle_id);
        const times=deadlines(c.last_check_in,c.check_in_interval_days,c.grace_period_days);
        if(!c.is_active) { if(cycle?.status==='open') {cancelCycle(cycle.id,at);db.prepare("UPDATE notification_cycles SET status='disabled' WHERE id=?").run(cycle.id);}continue; }
        if(!cycle || cycle.last_checkin_at!==times.lastCheckinAt || cycle.expiry_at!==times.releaseAt ||
            (!c.switch_triggered && cycle.status!=='open')) newCycle(c.user_id,'reconcile',at);
        else schedule(cycle,at);
      }
    }).immediate();
  }
  function signedInCheckin(userId) {
    return db.transaction(()=>{
      const at=timestamp();
      db.prepare('UPDATE users SET last_check_in=? WHERE id=?').run(at,userId);
      db.prepare('UPDATE dead_switch_config SET switch_triggered=0,switch_triggered_at=NULL WHERE user_id=?').run(userId);
      const cycle=newCycle(userId,'signed_in_checkin',at);
      audit(db,userId,'checkin','signed_in',at);
      return {success:true,checked_in_at:at,cycle_id:cycle?.id||null};
    }).immediate();
  }
  function configureSwitch(userId,{interval,grace,active}) {
    return db.transaction(()=>{
      const at=timestamp();
      db.prepare('UPDATE dead_switch_config SET check_in_interval_days=?,grace_period_days=?,is_active=? WHERE user_id=?').run(interval,grace,active?1:0,userId);
      if(active) {
        db.prepare('UPDATE users SET last_check_in=? WHERE id=?').run(at,userId);
        db.prepare('UPDATE dead_switch_config SET switch_triggered=0,switch_triggered_at=NULL WHERE user_id=?').run(userId);
      }
      const cycle=newCycle(userId,active?'switch_configuration':'disabled',at);
      audit(db,userId,active?'deadswitch_activate':'deadswitch_deactivate',`interval=${interval}d grace=${grace}d`,at);
      return cycle;
    }).immediate();
  }
  function releaseDue() {
    return db.transaction(()=>{
      const at=timestamp();
      let count=0;
      const configs=db.prepare(`SELECT d.*,u.last_check_in FROM dead_switch_config d JOIN users u ON u.id=d.user_id
        WHERE d.is_active=1 AND d.switch_triggered=0`).all();
      for(const c of configs) {
        const expiry=deadlines(c.last_check_in,c.check_in_interval_days,c.grace_period_days).releaseAt;
        if(at<expiry) continue;
        if(!c.notification_cycle_id) newCycle(c.user_id,'release_reconcile',at);
        const current=db.prepare('SELECT notification_cycle_id FROM dead_switch_config WHERE user_id=?').get(c.user_id);
        db.prepare('UPDATE dead_switch_config SET switch_triggered=1,switch_triggered_at=? WHERE user_id=? AND switch_triggered=0').run(at,c.user_id);
        db.prepare('UPDATE beneficiaries SET access_granted=1,access_granted_at=? WHERE user_id=? AND access_granted=0').run(at,c.user_id);
        cancelCycle(current.notification_cycle_id,at);
        db.prepare("UPDATE notification_cycles SET status='released' WHERE id=?").run(current.notification_cycle_id);
        queue('deadswitch_released',c.user_id,{grantedAt:at},{cycleId:current.notification_cycle_id,key:`release:${current.notification_cycle_id}`});
        audit(db,c.user_id,'deadswitch_triggered',`cycle=${current.notification_cycle_id}`,at);count++;
      }
      return count;
    }).immediate();
  }
  function startVerification(userId,recipient) {
    return db.transaction(()=>{
      const at=timestamp();const nonce=crypto.randomUUID();
      const token=derivedCode(env,'verify',nonce);ensureSettings(userId);
      db.prepare(`UPDATE notification_settings SET recipient=?,verified_at=NULL,reply_enabled=0,verify_nonce=?,verify_hash=?,
        verify_expires_at=?,verify_attempts=0,config_status='pending_verification',updated_at=? WHERE user_id=?`)
        .run(recipient,nonce,digest('verify',token),new Date(utc(at).getTime()+30*60000).toISOString(),at,userId);
      db.prepare(`UPDATE notification_outbox SET status='cancelled',updated_at=? WHERE user_id=? AND status IN ${PENDING}`).run(at,userId);
      db.prepare('UPDATE checkin_challenges SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL').run(at,userId);
      queue('verify_address',userId,{nonce},{key:`verify:${nonce}`});
      audit(db,userId,'notification_verification_requested',null,at);
      return {success:true};
    }).immediate();
  }
  function completeVerification(userId,value) {
    return db.transaction(()=>{
      const s=settings(userId),at=timestamp();
      if(!secretReady(env) || !s?.verify_hash || s.verify_attempts>=5 || s.verify_expires_at<=at) return false;
      db.prepare('UPDATE notification_settings SET verify_attempts=verify_attempts+1 WHERE user_id=?').run(userId);
      if(!equal(s.verify_hash,digest('verify',value))) return false;
      db.prepare(`UPDATE notification_settings SET verified_at=?,verify_hash=NULL,verify_nonce=NULL,verify_expires_at=NULL,
        reply_enabled=1,config_status='ready',updated_at=? WHERE user_id=?`).run(at,at,userId);
      db.prepare(`UPDATE notification_outbox SET status='cancelled',updated_at=? WHERE user_id=? AND event_type='verify_address' AND status IN ${PENDING}`).run(at,userId);
      newCycle(userId,'notification_address_verified',at);
      audit(db,userId,'notification_address_verified',null,at);return true;
    }).immediate();
  }
  function configureNotifications(userId,{replyEnabled,timezone,reminderClock}) {
    return db.transaction(()=>{
      const s=ensureSettings(userId),at=timestamp();
      if(timezone!=='Africa/Johannesburg' || (reminderClock!==null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderClock))) throw new Error('invalid_notification_settings');
      if(replyEnabled && (!s.verified_at || !secretReady(env))) throw new Error('verified_notification_address_required');
      db.prepare("UPDATE notification_settings SET reply_enabled=?,timezone=?,reminder_clock=?,updated_at=? WHERE user_id=?")
        .run(replyEnabled?1:0,timezone,reminderClock,at,userId);
      newCycle(userId,'notification_configuration',at);
      audit(db,userId,'notification_settings_changed',null,at);
      return {success:true};
    }).immediate();
  }
  function prepareReminder(job) {
    return db.transaction(()=>{
      const at=timestamp(),s=settings(job.user_id);
      const c=db.prepare('SELECT * FROM dead_switch_config WHERE user_id=?').get(job.user_id);
      const cycle=db.prepare('SELECT * FROM notification_cycles WHERE id=?').get(job.cycle_id);
      if(!s?.verified_at || !s.reply_enabled || !c?.is_active || c.switch_triggered || c.notification_cycle_id!==job.cycle_id ||
          cycle?.status!=='open' || at>=cycle.expiry_at || localDate(at,s.timezone)!==job.reminder_date) return null;
      const day=db.prepare('SELECT outbox_id FROM notification_reminder_days WHERE user_id=? AND local_date=?').get(job.user_id,job.reminder_date);
      if(day && day.outbox_id!==job.id) return null;
      db.prepare('INSERT OR IGNORE INTO notification_reminder_days (user_id,local_date,outbox_id) VALUES (?,?,?)').run(job.user_id,job.reminder_date,job.id);
      let challenge=db.prepare('SELECT * FROM checkin_challenges WHERE outbox_id=?').get(job.id);
      if(!challenge) {
        const id=crypto.randomUUID(),value=derivedCode(env,'challenge',id);
        db.prepare('UPDATE checkin_challenges SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL').run(at,job.user_id);
        const expiry=new Date(Math.min(utc(at).getTime()+DAY,utc(cycle.expiry_at).getTime())).toISOString();
        db.prepare(`INSERT INTO checkin_challenges (id,code_hash,user_id,cycle_id,outbox_id,message_id,issued_at,expires_at,reminder_sequence,protocol_version)
          VALUES (?,?,?,?,?,?,?,?,?,2)`).run(id,digest('challenge',value),job.user_id,job.cycle_id,job.id,job.message_id,at,expiry,job.reminder_number);
        challenge=db.prepare('SELECT * FROM checkin_challenges WHERE id=?').get(id);
      }
      if(challenge.protocol_version!==2 || challenge.used_at || challenge.revoked_at || challenge.expires_at<=at) return null;
      return {...JSON.parse(job.data_json),challenge:derivedCode(env,'challenge',challenge.id),challengeExpiresAt:challenge.expires_at};
    }).immediate();
  }
  function securityWarning(userId,at) {
    const hour=at.slice(0,13);
    queue('checkin_failed',userId,{}, {key:`reply_warning:${userId}:${hour}`});
  }
  function processParsedReply(identity,parsed) {
    return db.transaction(()=>{
      const at=timestamp();
      if(db.prepare('SELECT 1 FROM inbound_message_log WHERE identity=?').get(identity)) return {outcome:'duplicate'};
      const fingerprint=parsed?.messageId ? digest('message-id',parsed.messageId) : null;
      if(fingerprint && db.prepare('SELECT 1 FROM inbound_message_log WHERE message_fingerprint=?').get(fingerprint)) {
        db.prepare(`INSERT INTO inbound_message_log (identity,outcome,reason,received_at) VALUES (?,'duplicate','duplicate_message',?)`).run(identity,at);
        return {outcome:'duplicate'};
      }
      let challenge,s,c;
      if(parsed?.ok) {
        challenge=db.prepare('SELECT * FROM checkin_challenges WHERE code_hash=?').get(digest('challenge',parsed.challenge));
        if(challenge) {s=settings(challenge.user_id);c=db.prepare('SELECT * FROM dead_switch_config WHERE user_id=?').get(challenge.user_id);}
      }
      let reason=parsed?.ok?'invalid_reply':(parsed?.reason||'malformed');
      let accepted=false;
      if(challenge && s?.verified_at && s.reply_enabled && s.config_status==='ready') {
        const failures=db.prepare("SELECT COUNT(*) n FROM inbound_message_log WHERE user_id=? AND outcome='rejected' AND received_at>?")
          .get(challenge.user_id,new Date(utc(at).getTime()-3600000).toISOString()).n;
        const metadata=require('./parser').validateReplyMetadata(parsed,{expectedFrom:s.recipient,replyMailbox:env.CHECKIN_REPLY_MAILBOX,expectedMessageId:challenge.message_id,allowButtonReply:true});
        const cycle=db.prepare('SELECT * FROM notification_cycles WHERE id=?').get(challenge.cycle_id);
        if(failures>=10) reason='rate_limited';
        else if(metadata.ok && challenge.protocol_version===2 && equal(challenge.code_hash,digest('challenge',parsed.challenge)) &&
          !challenge.used_at && !challenge.revoked_at && challenge.expires_at>at &&
          c?.is_active && !c.switch_triggered && c.notification_cycle_id===challenge.cycle_id && cycle?.status==='open' && cycle.expiry_at>at) {
          const used=db.prepare('UPDATE checkin_challenges SET used_at=?,inbound_identity=? WHERE id=? AND protocol_version=2 AND used_at IS NULL AND revoked_at IS NULL').run(at,identity,challenge.id);
          if(used.changes!==1) throw new Error('checkin_race');
          db.prepare('UPDATE users SET last_check_in=? WHERE id=?').run(at,challenge.user_id);
          // Neither emergency requests nor beneficiary grants are touched.
          db.prepare('UPDATE dead_switch_config SET switch_triggered=0,switch_triggered_at=NULL WHERE user_id=?').run(challenge.user_id);
          const next=newCycle(challenge.user_id,'verified_email_reply',at);
          audit(db,challenge.user_id,'email_checkin_accepted',`previous_cycle=${challenge.cycle_id};cycle=${next.id}`,at);
          queue('checkin_confirmed',challenge.user_id,{confirmedAt:at,nextCheckinAt:next.due_at,nextReleaseAt:next.expiry_at},
            {cycleId:next.id,key:`checkin_confirmed:${next.id}`});
          accepted=true;reason='accepted';
        }
      }
      // Only fixed, whitelisted reason codes ever enter the persistent log.
      const allowed=new Set(['accepted','invalid_reply','rate_limited','malformed','too_large','automatic','forwarded','ambiguous','invalid_metadata','invalid_command','unsupported_mime','authentication_failed']);
      if(!allowed.has(reason)) reason='invalid_reply';
      db.prepare(`INSERT INTO inbound_message_log
        (identity,message_fingerprint,user_id,cycle_id,outcome,reason,authentication_status,received_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(identity,fingerprint,challenge?.user_id||null,challenge?.cycle_id||null,accepted?'accepted':'rejected',reason,
          ['reviewed','failed','unavailable'].includes(parsed?.authentication?.status)?parsed.authentication.status:'unavailable',at);
      if(!accepted && challenge) {
        audit(db,challenge.user_id,'email_checkin_rejected',reason,at);
        securityWarning(challenge.user_id,at);
      }
      return {outcome:accepted?'accepted':'rejected'};
    }).immediate();
  }
  function beneficiaryEvent({type,userId,beneficiary,now:eventNow}) {
    const at=eventNow?utc(eventNow).toISOString():timestamp();
    const requestedAt=beneficiary.emergency_access_requested_at ? utc(beneficiary.emergency_access_requested_at).toISOString() : at;
    const data=type==='emergency_requested' ? {beneficiaryName:beneficiary.name,requestedAt,waitingDays:beneficiary.emergency_waiting_days,
      eligibleAt:new Date(utc(requestedAt).getTime()+beneficiary.emergency_waiting_days*DAY).toISOString()} :
      {beneficiaryName:beneficiary.name,eventAt:at,accessGranted:!!beneficiary.access_granted,grantedAt:at};
    const transition=audit(db,userId,'beneficiary_notification_event',`beneficiary=${beneficiary.id};event=${type}`,at);
    return queue(type,userId,data,{beneficiaryId:beneficiary.id,key:`beneficiary:${transition.lastInsertRowid}:${beneficiary.id}:${type}`});
  }
  return {timestamp,settings,ensureSettings,queue,cancelCycle,newCycle,reconcile,signedInCheckin,configureSwitch,releaseDue,
    startVerification,completeVerification,configureNotifications,prepareReminder,processParsedReply,beneficiaryEvent};
}
function recordBeneficiaryEvent(db,event) { return createNotificationService({db}).beneficiaryEvent(event); }
module.exports={createNotificationService,recordBeneficiaryEvent,code,digest,derivedCode,equal,secretReady,audit,PENDING};
