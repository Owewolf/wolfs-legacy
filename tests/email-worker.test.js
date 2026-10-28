'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, rawReply } = require('./helpers/email-fixture');
const { createNotificationWorker } = require('../server/notifications/worker');

const accepted = () => ({status:'sent_to_server',acceptedCount:1,rejectedCount:0});
const idleMailbox = {async poll(){return {processed:0};}};

function worker(t,f,overrides={}) {
  const instance=createNotificationWorker({db:f.db,env:f.env,now:f.now,
    smtp:{async sendMail(){return accepted();}},imap:idleMailbox,...overrides});
  t.after(()=>instance.stop());
  return instance;
}

function queueTest(f) {
  return f.service.queue('email_test',1,{});
}

function job(f,id) {return f.db.prepare('SELECT * FROM notification_outbox WHERE id=?').get(id);}

test('SMTP submission is recorded distinctly from delivery and is not resubmitted on restart', async t=>{
  const f=createFixture(t),id=queueTest(f),messages=[];
  const smtp={async sendMail(message){messages.push(message);return accepted();}};
  await worker(t,f,{smtp}).tick();
  assert.equal(messages.length,1);
  assert.equal(messages[0].to,'owner@example.test');
  assert.ok(messages[0].text.includes('does not establish that future delivery is guaranteed'));
  assert.equal(job(f,id).status,'sent_to_server');
  assert.equal(job(f,id).delivery_confirmed_at,null);
  assert.equal(job(f,id).attempts,1);
  const attempts=f.db.prepare('SELECT * FROM notification_attempts WHERE outbox_id=?').all(id);
  assert.equal(attempts.length,1);
  assert.equal(attempts[0].outcome,'sent_to_server');
  await worker(t,f,{smtp}).tick();
  assert.equal(messages.length,1);
  assert.equal(f.user().last_check_in,'2026-01-01T08:15:00.000Z');
});

test('transient SMTP failure persists a retry and preserves check-in state', async t=>{
  const f=createFixture(t),id=queueTest(f),before=f.user(),messages=[];
  let calls=0;
  const instance=worker(t,f,{smtp:{async sendMail(message){messages.push(message);calls++;
    if(calls===1) throw Object.assign(new Error('password=fixture-secret owner@example.test'),{code:'SMTP_UNAVAILABLE',transient:true,responseCode:451});
    return accepted();}}});
  await instance.tick();
  assert.equal(job(f,id).status,'failed');
  assert.equal(job(f,id).last_error,'SMTP_UNAVAILABLE');
  assert.equal(Date.parse(job(f,id).next_attempt_at)-Date.parse(f.instant),60000);
  await instance.tick();
  assert.equal(calls,1);
  f.setNow(job(f,id).next_attempt_at);
  await instance.tick();
  assert.equal(calls,2);
  assert.equal(job(f,id).status,'sent_to_server');
  assert.equal(messages[0].messageId,messages[1].messageId);
  assert.deepEqual(f.db.prepare('SELECT outcome FROM notification_attempts WHERE outbox_id=? ORDER BY attempt_number').all(id),
    [{outcome:'failed'},{outcome:'sent_to_server'}]);
  assert.deepEqual(f.user(),before);
  const persisted=JSON.stringify(f.db.prepare('SELECT * FROM notification_attempts').all())+
    JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all())+JSON.stringify(f.db.prepare('SELECT * FROM notification_health').all());
  assert.ok(!persisted.includes('fixture-secret'));
  assert.ok(!persisted.includes('owner@example.test'));
});

test('five unsuccessful attempts dead-letter mail and surface operational degradation', async t=>{
  const f=createFixture(t),id=queueTest(f),alerts=[];
  f.env.NOTIFICATION_ALERT_COMMAND='/fixture/alternate-alert';
  const instance=worker(t,f,{smtp:{async sendMail(){throw Object.assign(new Error('secret raw SMTP error'),{code:'SMTP_UNAVAILABLE',transient:true});}},
    alert:async(...args)=>alerts.push(args)});
  for(let count=0;count<5;count++) {
    await instance.tick();
    if(job(f,id).next_attempt_at) f.setNow(job(f,id).next_attempt_at);
  }
  assert.equal(job(f,id).status,'dead_letter');
  assert.equal(job(f,id).attempts,5);
  assert.equal(job(f,id).next_attempt_at,null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notification_attempts WHERE outbox_id=?').get(id).n,5);
  assert.equal(f.db.prepare("SELECT status FROM notification_health WHERE channel='smtp'").get().status,'degraded');
  assert.ok(alerts.length>0);
  assert.equal(alerts[0][0],'/fixture/alternate-alert');
  assert.deepEqual(JSON.parse(alerts[0][1][0]),{channel:'smtp',status:'degraded',failures:3});
  assert.ok(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='notification_transport_degraded'").get().n>0);
  assert.equal(f.user().last_check_in,'2026-01-01T08:15:00.000Z');
});

test('permanent rejection and ambiguous SMTP outcomes are never automatically retried', async t=>{
  for(const [label,error,status] of [
    ['permanent',{code:'SMTP_REJECTED',transient:false},'dead_letter'],
    ['ambiguous',{code:'SMTP_UNAVAILABLE',ambiguous:true,transient:true},'uncertain']
  ]) await t.test(label,async tt=>{
    const f=createFixture(tt),id=queueTest(f);let calls=0;
    const instance=worker(tt,f,{smtp:{async sendMail(){calls++;throw Object.assign(new Error('sanitized'),error);}}});
    await instance.tick();
    assert.equal(job(f,id).status,status);
    f.setNow(Date.parse(f.instant)+86400000);
    await worker(tt,f,{smtp:{async sendMail(){calls++;return accepted();}}}).tick();
    assert.equal(calls,1);
    assert.equal(job(f,id).attempts,1);
  });
});

test('interrupted sending jobs become uncertain with a persistent attempt and audit record', async t=>{
  const f=createFixture(t),id=queueTest(f);let calls=0;
  f.db.prepare("UPDATE notification_outbox SET status='sending',attempts=1,locked_at=? WHERE id=?").run(f.instant,id);
  const instance=worker(t,f,{smtp:{async sendMail(){calls++;return accepted();}}});
  instance.recoverInterrupted();
  instance.recoverInterrupted();
  await instance.tick();
  assert.equal(calls,0);
  assert.equal(job(f,id).status,'uncertain');
  assert.equal(job(f,id).last_error,'SMTP_INTERRUPTED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notification_attempts WHERE outbox_id=?').get(id).n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='notification_send_uncertain'").get().n,1);
});

test('SMTP acceptance followed by a SQLite persistence failure is uncertain and never resends', async t=>{
  const f=createFixture(t),id=queueTest(f);let calls=0,failed=false;
  f.db.function('fixture_fail_accepted_once',()=>{
    if(!failed) {failed=true;throw new Error('fixture accepted-state persistence failure');}
    return 1;
  });
  f.db.exec(`CREATE TRIGGER fixture_acceptance_failure BEFORE UPDATE OF status ON notification_outbox
    WHEN NEW.status='sent_to_server' AND NEW.id=${id}
    BEGIN SELECT fixture_fail_accepted_once(); END;`);
  const instance=worker(t,f,{smtp:{async sendMail(){calls++;return accepted();}}});
  await instance.tick();
  assert.equal(failed,true);
  assert.equal(calls,1);
  assert.equal(job(f,id).status,'uncertain');
  assert.equal(job(f,id).next_attempt_at,null);
  assert.deepEqual(f.db.prepare('SELECT outcome FROM notification_attempts WHERE outbox_id=?').all(id),[{outcome:'uncertain'}]);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='notification_send_uncertain'").get().n,1);
  assert.equal(f.db.prepare("SELECT status FROM notification_health WHERE channel='smtp'").get().status,'degraded');
  await instance.tick();
  assert.equal(calls,1);
  assert.equal(job(f,id).attempts,1);
});

test('malformed persisted events dead-letter before SMTP and retain audit/health status', async t=>{
  for(const [label,type,data] of [
    ['corrupt-json','access_granted','{"unfinished":'],
    ['unknown-event','unsupported-event','{}'],
    ['bad-template','access_granted','{"eventAt":"invalid-date"}']
  ]) await t.test(label,async tt=>{
    const f=createFixture(tt),id=f.service.queue(type,1,{});let calls=0;
    f.db.prepare('UPDATE notification_outbox SET data_json=? WHERE id=?').run(data,id);
    await worker(tt,f,{smtp:{async sendMail(){calls++;return accepted();}}}).tick();
    assert.equal(calls,0);
    assert.equal(job(f,id).status,'dead_letter');
    assert.equal(job(f,id).attempts,1);
    assert.equal(f.db.prepare('SELECT outcome FROM notification_attempts WHERE outbox_id=?').get(id).outcome,'dead_letter');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='notification_send_dead_letter'").get().n,1);
    assert.equal(f.db.prepare("SELECT status FROM notification_health WHERE channel='smtp'").get().status,'degraded');
    assert.equal(f.user().last_check_in,'2026-01-01T08:15:00.000Z');
  });
});

test('IMAP outages degrade persistently, alert once per hour and recover without accepting activity', async t=>{
  const f=createFixture(t),before=f.user();let unavailable=true,polls=0;
  const instance=worker(t,f,{imap:{async poll(){polls++;if(unavailable) throw Object.assign(new Error('imap-password=secret'),{code:'IMAP_UNAVAILABLE'});return {processed:0};}}});
  for(let i=0;i<4;i++) await instance.tick();
  const degraded=f.db.prepare("SELECT * FROM notification_health WHERE channel='imap'").get();
  assert.equal(degraded.status,'degraded');
  assert.equal(degraded.failures,4);
  assert.equal(degraded.last_error,'IMAP_UNAVAILABLE');
  assert.equal(f.jobs('transport_health').length,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='notification_transport_degraded'").get().n,1);
  assert.deepEqual(f.user(),before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inbound_message_log').get().n,0);
  unavailable=false;
  await instance.tick();
  const recovered=f.db.prepare("SELECT * FROM notification_health WHERE channel='imap'").get();
  assert.equal(recovered.status,'ready');
  assert.equal(recovered.failures,0);
  assert.equal(recovered.last_error,null);
  assert.ok(recovered.last_success_at);
  assert.equal(polls,5);
  assert.deepEqual(f.user(),before);
});

test('mailbox replies process before outgoing reminders and persist monotonic UID checkpoints', async t=>{
  const f=createFixture(t);
  const batch=f.service.rotateRecoveryCodes(1);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null});
  const issued=f.issueReminder();
  const source=rawReply({challenge:issued.value,recovery:batch.codes[0],thread:issued.job.message_id});
  const key={account:'fixture-account',mailbox:'INBOX',uidValidity:'17'};
  let pollCount=0;
  const messages=[];
  const imap={async poll(callbacks){
    pollCount++;
    if(pollCount===1) {
      assert.equal(callbacks.getCheckpoint(key),undefined);
      assert.equal(callbacks.hasProcessed('uid-42'),false);
      const result=await callbacks.processMessage({identity:'uid-42',source});
      assert.equal(result.outcome,'accepted');
      callbacks.saveCheckpoint({...key,lastUid:42});
      callbacks.saveCheckpoint({...key,lastUid:40});
      assert.equal(callbacks.getCheckpoint(key),42);
      assert.equal(callbacks.hasProcessed('uid-42'),true);
    } else {
      assert.equal(callbacks.getCheckpoint(key),42);
      assert.equal(callbacks.hasProcessed('uid-42'),true);
      assert.equal(callbacks.getCheckpoint({...key,uidValidity:'18'}),undefined);
    }
    return {processed:pollCount===1?1:0};
  }};
  const smtp={async sendMail(message){messages.push(message);return accepted();}};
  await worker(t,f,{imap,smtp}).tick();
  assert.equal(f.user().last_check_in,f.instant);
  assert.equal(messages.length,1);
  assert.equal(messages[0].subject,"Wolf's Legacy — Check-in confirmed");
  assert.ok(f.jobs().filter(row=>row.cycle_id===issued.job.cycle_id).every(row=>row.status==='cancelled'));
  await worker(t,f,{imap,smtp}).tick();
  assert.equal(messages.length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inbound_message_log').get().n,1);
  assert.equal(f.db.prepare('SELECT last_uid FROM inbound_checkpoints').get().last_uid,42);
});

test('late mailbox recovery never accepts an expired email and oversized messages are recorded safely', async t=>{
  const f=createFixture(t),batch=f.service.rotateRecoveryCodes(1);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null});
  const issued=f.issueReminder(),before=f.user().last_check_in;
  const source=rawReply({challenge:issued.value,recovery:batch.codes[0],thread:issued.job.message_id});
  f.setNow(Date.parse(f.instant)+86400001);
  const imap={async poll(callbacks){
    assert.equal((await callbacks.processMessage({identity:'late',source})).outcome,'rejected');
    assert.equal((await callbacks.processMessage({identity:'oversize',rejectionReason:'message_size'})).outcome,'rejected');
    return {processed:2};
  }};
  await worker(t,f,{imap}).tick();
  assert.equal(f.user().last_check_in,before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes WHERE consumed_at IS NOT NULL').get().n,0);
  assert.equal(f.db.prepare("SELECT reason FROM inbound_message_log WHERE identity='oversize'").get().reason,'too_large');
});

test('misconfigured notification key and disabled worker cannot manufacture confirmations', async t=>{
  const f=createFixture(t),id=queueTest(f);let sends=0,polls=0;
  f.env.NOTIFICATION_SECRET='';
  const instance=worker(t,f,{smtp:{async sendMail(){sends++;return accepted();}},imap:{async poll(){polls++;return {processed:0};}}});
  await instance.tick();
  assert.equal(sends,0);
  assert.equal(polls,0);
  assert.equal(job(f,id).status,'queued');
  assert.equal(f.db.prepare("SELECT last_error FROM notification_health WHERE channel='imap'").get().last_error,'EMAIL_CONFIGURATION');
  f.env.NOTIFICATIONS_ENABLED='false';
  await instance.tick();
  assert.equal(sends,0);
  assert.equal(polls,0);
});

test('repeated settings and clock changes cannot send two reminders on one local date', async t=>{
  const f=createFixture(t),batch=f.service.rotateRecoveryCodes(1),messages=[];
  assert.equal(batch.codes.length,10);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null});
  f.setDay(32);
  const smtp={async sendMail(message){messages.push(message);return accepted();}};
  const instance=worker(t,f,{smtp});
  await instance.tick();
  assert.equal(messages.length,1);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:'11:00'});
  f.setNow('2026-02-02T09:00:00.000Z');
  await instance.tick();
  assert.equal(messages.length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notification_reminder_days').get().n,1);
});

test('a complete unconfirmed cycle sends once on each of days 32–36 and no other day', async t=>{
  const f=createFixture(t),messages=[];
  const batch=f.service.rotateRecoveryCodes(1);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null});
  const smtp={async sendMail(message){messages.push({day:f.instant,...message});return accepted();}};
  let instance=worker(t,f,{smtp});
  f.setDay(31);
  await instance.tick();
  assert.equal(messages.length,0);
  for(let day=32;day<=36;day++) {
    f.setDay(day);
    await instance.tick();
    await instance.tick();
    // A new worker instance uses only persisted scheduler and sending state.
    instance=worker(t,f,{smtp});
    await instance.tick();
    assert.equal(messages.length,day-31);
  }
  f.setDay(37);
  await instance.tick();
  assert.equal(messages.length,5);
  assert.deepEqual(messages.map(message=>Number(/Check-in required: (\d)/.exec(message.subject)[1])),[5,4,3,2,1]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notification_reminder_days').get().n,5);
  for(const message of messages) {
    assert.match(message.text,/CONFIRM WL-/);
    assert.ok(!message.text.includes('preserved-token-hash'));
    assert.ok(!message.text.includes('beneficiary@example.test'));
    assert.ok(batch.codes.every(value=>!message.text.includes(value) && !message.html.includes(value)));
  }
  assert.equal(f.user().last_check_in,'2026-01-01T08:15:00.000Z');
});

test('restart after missed reminder dates sends only the current day without backfill', async t=>{
  const f=createFixture(t),messages=[];
  f.service.rotateRecoveryCodes(1);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null});
  f.setDay(34,60000);
  await worker(t,f,{smtp:{async sendMail(message){messages.push(message);return accepted();}}}).tick();
  assert.equal(messages.length,1);
  assert.match(messages[0].subject,/3 days before access release/);
  assert.equal(f.jobs().filter(row=>row.status==='cancelled').length,2);
  assert.equal(f.jobs().filter(row=>row.status==='sent_to_server').length,1);
});
