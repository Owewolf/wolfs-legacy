'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { createFixture, rawReply, START, DAY } = require('./helpers/email-fixture');
const { createNotificationService, derivedCode, digest } = require('../server/notifications/service');
const { initNotificationSchema } = require('../server/notifications/schema');
const { reminderSlots, parts } = require('../server/notifications/time');
const { parseReply } = require('../server/notifications/parser');

function provision(f) {
  f.service.configureNotifications(1, { replyEnabled: true, timezone: 'Africa/Johannesburg', reminderClock: null });
  const issued = f.issueReminder();
  return issued;
}

function parse(f, issued, overrides = {}) {
  return parseReply(rawReply({ challenge: issued.value,
    thread: issued.job.message_id, ...overrides }), { replyMailbox: f.env.CHECKIN_REPLY_MAILBOX,
    trustedAuthservIds: f.env.CHECKIN_TRUSTED_AUTHSERV_IDS, allowButtonReply:true });
}

test('30+7 cycle schedules exactly days 32–36 at the final release clock', t => {
  const f = createFixture(t);
  f.service.reconcile();
  const jobs = f.jobs();
  assert.equal(jobs.length, 5);
  assert.deepEqual(jobs.map(job => (Date.parse(job.schedule_at) - Date.parse(START)) / DAY), [32,33,34,35,36]);
  assert.deepEqual(jobs.map(job => job.reminder_number), [1,2,3,4,5]);
  assert.deepEqual(jobs.map(job => JSON.parse(job.data_json).daysRemaining), [5,4,3,2,1]);
  assert.equal(new Set(jobs.map(job => job.reminder_date)).size, 5);
  assert.ok(jobs.every(job => parts(job.schedule_at, 'Africa/Johannesburg').hour === 10));
  const cycle = f.db.prepare('SELECT * FROM notification_cycles WHERE id=?').get(f.config().notification_cycle_id);
  assert.equal(cycle.due_at, '2026-01-31T08:15:00.000Z');
  assert.equal(cycle.expiry_at, '2026-02-07T08:15:00.000Z');
});

test('restart reconciliation and database constraints prevent duplicate logical reminders', t => {
  const f = createFixture(t);
  f.service.reconcile();
  const before = f.jobs();
  for (let i=0;i<3;i++) createNotificationService({ db:f.db, env:f.env, now:f.now }).reconcile();
  assert.deepEqual(f.jobs(), before);
  const job = before[0];
  assert.throws(() => f.db.prepare(`INSERT INTO notification_outbox
    (event_type,user_id,cycle_id,idempotency_key,schedule_at,reminder_number,created_at,updated_at)
    VALUES ('reminder',1,?,'different-key',?,1,?,?)`).run(job.cycle_id,job.schedule_at,f.instant,f.instant), /UNIQUE/);
});

test('late enablement creates only future reminder dates and never backfills', t => {
  const f = createFixture(t, { replyEnabled:false });
  f.setDay(34, 60000);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null});
  assert.deepEqual(f.jobs().map(job=>JSON.parse(job.data_json).daysRemaining), [2,1]);
  f.service.reconcile();
  assert.equal(f.jobs().length,2);
});

test('local daily clock survives a DST change with UTC persistence', () => {
  const slots = reminderSlots('2026-04-01T08:15:00.000Z','Europe/London');
  assert.deepEqual(slots.map(slot=>slot.at), [
    '2026-03-27T09:15:00.000Z','2026-03-28T09:15:00.000Z',
    '2026-03-29T08:15:00.000Z','2026-03-30T08:15:00.000Z','2026-03-31T08:15:00.000Z'
  ]);
  assert.ok(slots.every(slot=>parts(slot.at,'Europe/London').hour===9));
});

test('verified raw email consumes its challenge once and starts a new cycle without changing access', async t => {
  const f = createFixture(t);
  const issued = provision(f);
  const accessBefore = f.beneficiaries();
  const parsed = await parse(f, issued, {body:`  confirm  ${issued.value.toLowerCase()}\t\n\n-- \nSignature\n> CONFIRM WL-QUOTED-CODE`});
  assert.equal(parsed.ok,true);
  const oldCycle = f.config().notification_cycle_id;
  const result = f.service.processParsedReply('imap-valid',parsed);
  assert.deepEqual(result,{outcome:'accepted'});
  assert.equal(f.user().last_check_in,f.instant);
  assert.equal(f.config().is_active,1);
  assert.equal(f.config().switch_triggered,0);
  assert.notEqual(f.config().notification_cycle_id,oldCycle);
  assert.deepEqual(f.beneficiaries(),accessBefore);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_challenges WHERE used_at IS NOT NULL').get().n,1);
  assert.ok(f.jobs().filter(job=>job.cycle_id===oldCycle).every(job=>job.status==='cancelled'));
  assert.equal(f.jobs('checkin_confirmed').length,1);
  const next = f.db.prepare('SELECT * FROM notification_cycles WHERE id=?').get(f.config().notification_cycle_id);
  assert.equal(Date.parse(next.due_at)-Date.parse(f.instant),30*DAY);
  assert.equal(Date.parse(next.expiry_at)-Date.parse(f.instant),37*DAY);
  assert.equal(f.service.processParsedReply('imap-valid',parsed).outcome,'duplicate');
  assert.equal(f.service.processParsedReply('imap-redelivery',parsed).outcome,'duplicate');
  assert.equal(f.jobs('checkin_confirmed').length,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='email_checkin_accepted'").get().n,1);
});

test('prefilled button email confirms activity without direct-reply headers or offline codes', async t => {
  const f=createFixture(t),issued=provision(f),access=f.beneficiaries();
  const parsed=await parse(f,issued,{thread:null,subject:"Wolf's Legacy check-in confirmation"});
  assert.equal(parsed.ok,true);
  assert.equal(parsed.inReplyTo,null);
  assert.equal(f.service.processParsedReply('button-confirmation',parsed).outcome,'accepted');
  assert.equal(f.config().is_active,1);
  assert.deepEqual(f.beneficiaries(),access);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes').get().n,0);
});

test('trusted mail authentication review is retained in the inbound audit record', async t => {
  const f = createFixture(t);
  const issued = provision(f);
  const parsed = await parse(f,issued);
  assert.equal(parsed.authentication.status,'reviewed');
  f.service.processParsedReply('authenticated',parsed);
  assert.equal(f.db.prepare('SELECT authentication_status FROM inbound_message_log').get().authentication_status,'reviewed');
});

test('confirmation validation rejects incomplete, forged, forwarded, automatic and ambiguous raw replies', async t => {
  const cases = [
    ['unknown-challenge', ()=>({body:'CONFIRM WL-UNKNOWN-CODE'})],
    ['confirm-only', ()=>({body:'CONFIRM'})],
    ['forged-sender', ()=>({from:'attacker@example.test'})],
    ['wrong-mailbox', ()=>({to:'elsewhere@example.test'})],
    ['forward', ()=>({subject:'Fwd: Wolf check-in'})],
    ['automatic', ()=>({extraHeaders:['Auto-Submitted: auto-replied']})],
    ['wrong-thread', ()=>({thread:'<unrelated@example.test>'})],
    ['conflicting-lines', issued=>({body:`CONFIRM ${issued.value}\nCONFIRM WL-OTHER-CODE`})],
    ['bad-authentication', ()=>({extraHeaders:['Authentication-Results: mx.example.test; dmarc=fail']})],
    ['legacy-two-code-command', issued=>({body:`CONFIRM ${issued.value} RC-UNUSED-INVALID-CODE`})]
  ];
  for (const [label,override] of cases) await t.test(label,async tt=>{
    const f = createFixture(tt),issued=provision(f),before=f.user().last_check_in,access=f.beneficiaries();
    const result=f.service.processParsedReply(label,await parse(f,issued,override(issued)));
    assert.equal(result.outcome,'rejected');
    assert.equal(f.user().last_check_in,before);
    assert.deepEqual(f.beneficiaries(),access);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes WHERE consumed_at IS NOT NULL').get().n,0);
  });
});

test('expired, superseded, disabled, wrong-owner and released challenges cannot check in', async t => {
  const mutations = [
    ['expired', (f)=>f.setDay(33,1)],
    ['superseded', (f)=>f.service.newCycle(1,'test-supersession')],
    ['disabled', (f)=>f.db.prepare('UPDATE dead_switch_config SET is_active=0 WHERE user_id=1').run()],
    ['wrong-owner', (f)=>{f.db.prepare('UPDATE notification_settings SET recipient=? WHERE user_id=1').run('other@example.test');}],
    ['legacy-protocol', (f,issued)=>{f.db.prepare('UPDATE checkin_challenges SET protocol_version=1 WHERE id=?').run(issued.challenge.id);}],
    ['released', (f)=>{f.setDay(37);assert.equal(f.service.releaseDue(),1);assert.ok(f.beneficiaries().every(b=>b.access_granted));}]
  ];
  for(const [label,mutate] of mutations) await t.test(label,async tt=>{
    const f=createFixture(tt),issued=provision(f),before=f.user().last_check_in;
    mutate(f,issued);
    const access=f.beneficiaries();
    assert.equal(f.service.processParsedReply(label,await parse(f,issued)).outcome,'rejected');
    assert.equal(f.user().last_check_in,before);
    assert.deepEqual(f.beneficiaries(),access);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes WHERE consumed_at IS NOT NULL').get().n,0);
  });
});

test('challenge replay cannot confirm a later cycle and invalid attempts are rate limited', async t => {
  const f=createFixture(t),issued=provision(f);
  assert.equal(f.service.processParsedReply('first',await parse(f,issued)).outcome,'accepted');
  const before=f.user().last_check_in;
  assert.equal(f.service.processParsedReply('replayed',await parse(f,issued,{messageId:'<replayed@example.test>'})).outcome,'rejected');
  const later=f.issueReminder();
  for(let i=0;i<12;i++) assert.equal(f.service.processParsedReply(`forged-${i}`,
    await parse(f,later,{messageId:`<forged-${i}@example.test>`,from:'attacker@example.test'})).outcome,'rejected');
  assert.equal(f.user().last_check_in,before);
  assert.equal(f.jobs('checkin_failed').length,2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM inbound_message_log WHERE reason='rate_limited'").get().n,2);
  assert.equal(f.service.processParsedReply('rate-blocked',await parse(f,later,{messageId:'<rate-blocked@example.test>'})).outcome,'rejected');
  f.setNow(Date.parse(f.instant)+3600001);
  assert.equal(f.service.processParsedReply('rate-expired',await parse(f,later,{messageId:'<rate-expired@example.test>'})).outcome,'accepted');
});

test('newer daily reminder revokes old challenge and keeps a maximum 24-hour lifetime', t => {
  const f=createFixture(t),issued=provision(f);
  const second=f.issueReminder(1);
  assert.ok(f.db.prepare('SELECT revoked_at FROM checkin_challenges WHERE id=?').get(issued.challenge.id).revoked_at);
  assert.equal(Date.parse(second.challenge.expires_at)-Date.parse(second.challenge.issued_at),DAY);
  const last=f.issueReminder(4);
  f.setNow(Date.parse(last.job.schedule_at)+12*3600000);
  f.db.prepare('DELETE FROM checkin_challenges WHERE outbox_id=?').run(last.job.id);
  f.service.prepareReminder(last.job);
  const challenge=f.db.prepare('SELECT * FROM checkin_challenges WHERE outbox_id=?').get(last.job.id);
  assert.equal(challenge.expires_at,'2026-02-07T08:15:00.000Z');
});

test('check-in and challenge consumption roll back if confirmation cannot be durably queued', async t => {
  const f=createFixture(t),issued=provision(f),before=f.user(),oldCycle=f.config().notification_cycle_id;
  const parsed = await parse(f,issued);
  f.db.exec(`CREATE TRIGGER fixture_ack_failure BEFORE INSERT ON notification_outbox
    WHEN NEW.event_type='checkin_confirmed' BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END;`);
  assert.throws(()=>f.service.processParsedReply('rollback',parsed), /fixture persistence failure/);
  function consumed() { return f.db.prepare('SELECT COUNT(*) n FROM checkin_challenges WHERE used_at IS NOT NULL').get().n; }
  assert.deepEqual(f.user(),before);
  assert.equal(f.config().notification_cycle_id,oldCycle);
  assert.equal(consumed(),0);
  assert.equal(f.db.prepare('SELECT used_at FROM checkin_challenges WHERE id=?').get(issued.challenge.id).used_at,null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inbound_message_log').get().n,0);
  assert.ok(f.jobs().every(job=>job.status==='queued'));
  f.db.exec('DROP TRIGGER fixture_ack_failure');
  assert.equal(f.service.processParsedReply('rollback',parsed).outcome,'accepted');
  assert.equal(consumed(),1);
});

test('migration is additive and backups contain no plaintext factors or transport secrets', t => {
  const f=createFixture(t);
  f.db.exec(`CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,fields_encrypted TEXT);
    CREATE TABLE homebank_snapshots(user_id INTEGER PRIMARY KEY,snapshot_encrypted TEXT);
    CREATE TABLE document_associations(document_id TEXT,entry_id INTEGER);
    INSERT INTO vault_entries VALUES(1,'fixture-vault-ciphertext');
    INSERT INTO homebank_snapshots VALUES(1,'fixture-snapshot-ciphertext');
    INSERT INTO document_associations VALUES('fixture-document',1);`);
  const tables=['users','dead_switch_config','beneficiaries','vault_entries','homebank_snapshots','document_associations'];
  const before=Object.fromEntries(tables.map(name=>[name,f.db.prepare(`SELECT * FROM ${name}`).all()]));
  initNotificationSchema(f.db);
  initNotificationSchema(f.db);
  assert.deepEqual(Object.fromEntries(tables.map(name=>[name,f.db.prepare(`SELECT * FROM ${name}`).all()])),before);
  const issued=provision(f);
  f.env.SMTP_PASSWORD='fixture-smtp-secret';
  f.env.CHECKIN_IMAP_PASSWORD='fixture-imap-secret';
  const backup=f.db.serialize();
  for(const secret of [issued.value,f.env.SMTP_PASSWORD,f.env.CHECKIN_IMAP_PASSWORD,f.env.NOTIFICATION_SECRET]) {
    assert.equal(backup.includes(Buffer.from(secret)),false,'plaintext secret must not enter SQLite');
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes').get().n,0);
  assert.equal(issued.challenge.code_hash,digest('challenge',issued.value));
  assert.equal(issued.challenge.protocol_version,2);
});

test('verifying the notification address enables replies once without codes or a check-in', t => {
  const f=createFixture(t,{verified:false,replyEnabled:false});
  const before=f.user(),access=f.beneficiaries();
  f.service.startVerification(1,'owner@example.test');
  const settings=f.service.settings(1);
  const value=derivedCode(f.env,'verify',settings.verify_nonce);
  assert.equal(f.service.completeVerification(1,'NV-INCORRECT-CODE'),false);
  assert.equal(f.service.completeVerification(1,value),true);
  const cycle=f.config().notification_cycle_id;
  const jobs=f.jobs();
  assert.equal(f.service.settings(1).reply_enabled,1);
  assert.equal(jobs.length,5);
  assert.equal(f.service.completeVerification(1,value),false);
  assert.equal(f.config().notification_cycle_id,cycle);
  assert.deepEqual(f.jobs(),jobs);
  assert.deepEqual(f.user(),before);
  assert.deepEqual(f.beneficiaries(),access);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes').get().n,0);
});

test('unverified address or missing signing secret cannot enable replies', t => {
  const f=createFixture(t,{verified:false,replyEnabled:false});
  const settings={replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null};
  assert.throws(()=>f.service.configureNotifications(1,settings),/verified_notification_address_required/);
  f.service.startVerification(1,'owner@example.test');
  const value=derivedCode(f.env,'verify',f.service.settings(1).verify_nonce);
  f.env.NOTIFICATION_SECRET='';
  assert.equal(f.service.completeVerification(1,value),false);
  assert.equal(f.service.settings(1).verified_at,null);
  assert.equal(f.service.settings(1).reply_enabled,0);
});

test('release is never early, transitions exactly once, and leaves already-granted timestamps intact', t => {
  const f=createFixture(t);
  f.service.reconcile();
  const before=f.beneficiaries()[1];
  f.setDay(37,-1);
  assert.equal(f.service.releaseDue(),0);
  assert.equal(f.beneficiaries()[0].access_granted,0);
  f.setDay(37);
  assert.equal(f.service.releaseDue(),1);
  assert.equal(f.service.releaseDue(),0);
  assert.equal(f.jobs('deadswitch_released').length,1);
  assert.ok(f.beneficiaries().every(b=>b.access_granted));
  assert.equal(f.beneficiaries()[1].access_granted_at,before.access_granted_at);
  assert.equal(f.beneficiaries()[0].emergency_access_requested,1);
});

test('simultaneous replies across SQLite connections consume one challenge exactly once', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wl-email-race-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'fixture.db');
  const f=createFixture(t,{filename}),issued=provision(f);
  const parsed=await parse(f,issued);
  const barrier=new SharedArrayBuffer(4);
  const source=`const {parentPort,workerData}=require('node:worker_threads');
    const Database=require(workerData.databaseModule);
    const {createNotificationService}=require(workerData.serviceModule);
    const db=new Database(workerData.filename);db.pragma('busy_timeout=5000');
    const service=createNotificationService({db,env:workerData.env,now:()=>new Date(workerData.at)});
    parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0);
    try{parentPort.postMessage(service.processParsedReply(workerData.identity,workerData.parsed));}
    catch(error){parentPort.postMessage({error:error.message});}finally{db.close();}`;
  const workers=[0,1].map(index=>new Worker(source,{eval:true,workerData:{filename,env:f.env,at:f.instant,barrier,
    databaseModule:require.resolve('better-sqlite3'),serviceModule:require.resolve('../server/notifications/service'),
    identity:`race-${index}`,parsed:{...parsed,messageId:`<race-${index}@example.test>`}}}));
  const exits=workers.map(worker=>once(worker,'exit'));
  await Promise.all(workers.map(worker=>once(worker,'message')));
  const results=workers.map(worker=>once(worker,'message'));
  Atomics.store(new Int32Array(barrier),0,1);
  Atomics.notify(new Int32Array(barrier),0,2);
  const outcomes=(await Promise.all(results)).map(([result])=>result.outcome).sort();
  assert.deepEqual(outcomes,['accepted','rejected']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_challenges WHERE used_at IS NOT NULL').get().n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='email_checkin_accepted'").get().n,1);
  assert.equal(f.jobs('checkin_confirmed').length,1);
  await Promise.all(exits);
});
