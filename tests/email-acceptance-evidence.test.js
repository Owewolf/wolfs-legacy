'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createFixture,rawReply,START,DAY}=require('./helpers/email-fixture');
const {parseReply}=require('../server/notifications/parser');
const {collectEvidence,openSession}=require('../scripts/email-acceptance-evidence');

function stage(t){
  const staging=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wolfs-legacy-email-acceptance-'));
  fs.mkdirSync(path.join(staging,'data'),{mode:0o700});fs.writeFileSync(path.join(staging,'bootstrap.js'),'// synthetic fixture\n');
  const sessionFile=path.join(staging,'session.json');fs.writeFileSync(sessionFile,JSON.stringify({staging}),{mode:0o600});
  const f=createFixture(t,{filename:path.join(staging,'data/vault.db')});
  t.after(()=>{if(f.db.open)f.db.close();fs.rmSync(staging,{recursive:true,force:true});});
  f.db.exec('CREATE TABLE acceptance_runs(user_id INTEGER PRIMARY KEY,started_at TEXT,cycle_id TEXT,initial_last_check_in TEXT,beneficiary_ids TEXT)');
  return {...f,source:f,staging,sessionFile};
}

async function acceptedFixture(t){
  const f=stage(t);f.setNow(new Date(Date.parse(START)+32*DAY-5000).toISOString());
  const batch=f.service.rotateRecoveryCodes(1);
  f.service.configureNotifications(1,{replyEnabled:true,timezone:'Africa/Johannesburg',reminderClock:null});
  const runStart=f.source.instant,oldId=f.config().notification_cycle_id;
  f.db.prepare('UPDATE beneficiaries SET emergency_waiting_days=90,emergency_access_requested_at=? WHERE id=1').run(runStart);
  f.db.prepare('UPDATE beneficiaries SET emergency_waiting_days=90,access_granted_at=? WHERE id=2').run(runStart);
  f.db.prepare('INSERT INTO acceptance_runs VALUES(?,?,?,?,?)').run(1,runStart,oldId,START,'[1,2]');
  const reminder=f.issueReminder();const reminderId='<wl-reminder-1@example.test>';
  f.db.prepare("UPDATE notification_outbox SET status='sent_to_server',message_id=?,attempts=1,sent_at=? WHERE id=?").run(reminderId,f.source.instant,reminder.job.id);
  f.db.prepare('UPDATE checkin_challenges SET message_id=? WHERE id=?').run(reminderId,reminder.challenge.id);
  const attempt=f.db.prepare("INSERT INTO notification_attempts(outbox_id,attempt_number,outcome,created_at) VALUES(?,1,'sent_to_server',?)");
  attempt.run(reminder.job.id,f.source.instant);
  f.setNow(new Date(Date.parse(f.source.instant)+60000).toISOString());
  const parsed=await parseReply(rawReply({challenge:reminder.value,recovery:batch.codes[0],thread:reminderId}),{trustedAuthservIds:'mx.example.test'});
  assert.equal(f.service.processParsedReply('synthetic-inbound-identity',parsed).outcome,'accepted');
  const ack=f.jobs('checkin_confirmed')[0];const ackId='<wl-acknowledgement-1@example.test>';
  f.db.prepare("UPDATE notification_outbox SET status='sent_to_server',message_id=?,attempts=1,sent_at=? WHERE id=?").run(ackId,f.source.instant,ack.id);
  attempt.run(ack.id,f.source.instant);
  return {...f,reminderId,ackId,reminder,ack,oldId,newId:f.config().notification_cycle_id,offlineCode:batch.codes[0]};
}

function mailboxFixture(ids,{missing=false,wrongHeader=false}={}){
  const calls=[];
  const createClient=options=>{
    assert.equal(options.logger,false);assert.equal(options.logRaw,false);assert.equal(options.tls.rejectUnauthorized,true);
    return {on(){},async connect(){calls.push('connect');},async getMailboxLock(name,settings){assert.equal(name,'INBOX');assert.deepEqual(settings,{readOnly:true});return{release(){calls.push('release');}};},
      async search(query,settings){assert.deepEqual(settings,{uid:true});const id=query.header['message-id'];assert.ok([ids.reminder,ids.acknowledgement].includes(id));calls.push(id);return missing&&id===ids.acknowledgement?[]:[id===ids.reminder?1:2];},
      async fetchOne(uid,query,settings){assert.deepEqual(query,{uid:true,headers:['message-id']});assert.deepEqual(settings,{uid:true});const id=uid===1?ids.reminder:ids.acknowledgement;return{headers:Buffer.from(`Message-ID: ${wrongHeader?'prefix '+id+' suffix':id}\r\n\r\n`)};},
      async logout(){calls.push('logout');}};
  };
  return {calls,createClient,env:{CHECKIN_IMAP_HOST:'imap.example.test',CHECKIN_IMAP_USERNAME:'private-owner',CHECKIN_IMAP_PASSWORD:'private-mail-password'}};
}

test('read-only evidence remains pending with no enrollment and performs no mailbox I/O',async t=>{
  const f=stage(t);let contacted=false;
  const before=f.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  const report=await collectEvidence({sessionFile:f.sessionFile,checkMailbox:true,createClient(){contacted=true;throw new Error('must not connect');}});
  assert.equal(report.outcome,'pending');assert.equal(report.database_verified,false);assert.equal(report.round_trip_verified,false);
  assert.ok(Object.values(report.invariants).every(value=>value===false));assert.equal(contacted,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,before);
  const {db}=openSession(f.sessionFile);assert.throws(()=>db.exec('DELETE FROM users'),/readonly|read-only/i);db.close();
});

test('actual verifier transaction proves database state; exact read-only mailbox observations complete the gate',async t=>{
  const f=await acceptedFixture(t);
  const local=await collectEvidence({sessionFile:f.sessionFile});
  assert.equal(local.database_verified,true);assert.equal(local.outcome,'pending');assert.equal(local.reason,'mailbox_observation_required');
  const fixture=mailboxFixture({reminder:f.reminderId,acknowledgement:f.ackId});
  const before=f.db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(f.ack.id).status;
  const report=await collectEvidence({sessionFile:f.sessionFile,checkMailbox:true,...fixture});
  assert.equal(report.outcome,'verified');assert.equal(report.round_trip_verified,true);assert.ok(Object.values(report.invariants).every(Boolean));
  assert.deepEqual(report.counts,{acceptance_runs:1,accepted_replies:1,consumed_codes:1,used_challenges:1});
  assert.equal(report.timestamps.accepted_at,f.source.instant);
  assert.equal(f.db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(f.ack.id).status,before);
  assert.equal(fixture.calls.at(-1),'logout');
  const serialized=JSON.stringify(report);
  for(const secret of [f.offlineCode,f.reminder.value,f.reminder.challenge.code_hash,'owner@example.test','private-mail-password',f.reminderId,'synthetic-inbound-identity'])assert.equal(serialized.includes(secret),false);
  f.db.prepare("UPDATE notification_outbox SET status='queued' WHERE id=?").run(f.ack.id);
  const awaiting=await collectEvidence({sessionFile:f.sessionFile});
  assert.equal(awaiting.outcome,'pending');assert.equal(awaiting.reason,'awaiting_acknowledgement_submission');
  assert.equal(awaiting.invariants.acknowledgement_submitted,false);
});

test('missing or substring-only mailbox matches never count as independently confirmed receipt',async t=>{
  const f=await acceptedFixture(t),ids={reminder:f.reminderId,acknowledgement:f.ackId};
  for(const options of [{missing:true},{wrongHeader:true}]){
    const report=await collectEvidence({sessionFile:f.sessionFile,checkMailbox:true,...mailboxFixture(ids,options)});
    assert.equal(report.database_verified,true);assert.equal(report.outcome,'pending');assert.equal(report.round_trip_verified,false);
    assert.equal(report.invariants.acknowledgement_observed_in_mailbox,false);
  }
});

test('tampered transaction, deadlines, old jobs, beneficiary state or acknowledgement cannot verify',async t=>{
  const f=await acceptedFixture(t);
  const cases=[
    ["UPDATE users SET last_check_in='2026-01-01T00:00:00.000Z' WHERE id=1",'last_checkin_matches_receipt',()=>f.db.prepare('UPDATE users SET last_check_in=? WHERE id=1').run(f.source.instant)],
    ["UPDATE checkin_challenges SET inbound_identity='tampered' WHERE id=?",'challenge_used_once_and_linked',()=>f.db.prepare("UPDATE checkin_challenges SET inbound_identity='synthetic-inbound-identity' WHERE id=?").run(f.reminder.challenge.id),f.reminder.challenge.id],
    ["UPDATE notification_cycles SET due_at='2026-01-01T00:00:00.000Z' WHERE id=?",'new_cycle_matches_30_plus_7',()=>f.db.prepare('UPDATE notification_cycles SET due_at=? WHERE id=?').run(new Date(Date.parse(f.source.instant)+30*DAY).toISOString(),f.newId),f.newId],
    ["UPDATE notification_outbox SET status='queued' WHERE cycle_id=? AND reminder_number=2",'old_reminders_stopped',()=>f.db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE cycle_id=? AND reminder_number=2").run(f.oldId),f.oldId],
    ["UPDATE notification_outbox SET status='cancelled' WHERE cycle_id=? AND reminder_number=2",'new_five_reminders_scheduled',()=>f.db.prepare("UPDATE notification_outbox SET status='queued' WHERE cycle_id=? AND reminder_number=2").run(f.newId),f.newId],
    ["UPDATE notification_outbox SET status='dead_letter' WHERE cycle_id=? AND reminder_number=2",'new_five_reminders_scheduled',()=>f.db.prepare("UPDATE notification_outbox SET status='queued' WHERE cycle_id=? AND reminder_number=2").run(f.newId),f.newId],
    ["UPDATE checkin_challenges SET expires_at='2099-01-01T00:00:00.000Z' WHERE id=?",'challenge_expiry_bounded',()=>f.db.prepare('UPDATE checkin_challenges SET expires_at=? WHERE id=?').run(f.reminder.challenge.expires_at,f.reminder.challenge.id),f.reminder.challenge.id],
    ["UPDATE notification_cycles SET expiry_at='2026-01-01T00:00:00.000Z' WHERE id=?",'receipt_before_release',()=>f.db.prepare('UPDATE notification_cycles SET expiry_at=? WHERE id=?').run(new Date(Date.parse(START)+37*DAY).toISOString(),f.oldId),f.oldId],
    ['UPDATE beneficiaries SET access_granted=1 WHERE id=1','emergency_request_preserved',()=>f.db.exec('UPDATE beneficiaries SET access_granted=0 WHERE id=1')],
    ['UPDATE beneficiaries SET access_granted_at=NULL WHERE id=2','prior_grant_preserved',()=>f.db.prepare('UPDATE beneficiaries SET access_granted_at=? WHERE id=2').run(f.db.prepare('SELECT started_at FROM acceptance_runs').get().started_at)],
    ["UPDATE notification_outbox SET data_json='{}' WHERE id=?",'acknowledgement_matches_new_deadlines',()=>f.db.prepare('UPDATE notification_outbox SET data_json=? WHERE id=?').run(f.ack.data_json,f.ack.id),f.ack.id]
  ];
  for(const [sql,key,restore,argument]of cases){
    f.db.prepare(sql).run(...(argument===undefined?[]:[argument]));
    const report=await collectEvidence({sessionFile:f.sessionFile});
    assert.equal(report.outcome,'failed',key);assert.equal(report.invariants[key],false,key);assert.equal(report.round_trip_verified,false);
    restore();
  }
  assert.equal((await collectEvidence({sessionFile:f.sessionFile})).database_verified,true);
  const unsafe='ZZZ PRIVATE LOG CONTENT MUST NEVER APPEAR';
  f.db.prepare('UPDATE inbound_message_log SET received_at=? WHERE identity=?').run(unsafe,'synthetic-inbound-identity');
  const sanitized=await collectEvidence({sessionFile:f.sessionFile});
  assert.equal(sanitized.outcome,'failed');assert.equal(sanitized.timestamps.accepted_at,null);
  assert.equal(JSON.stringify(sanitized).includes(unsafe),false);
  f.db.exec('DROP TABLE checkin_challenges');
  const child=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/email-acceptance-evidence.js'),'--session',f.sessionFile],{encoding:'utf8'});
  assert.equal(child.status,1);assert.equal(JSON.parse(child.stdout).outcome,'error');
  assert.equal(child.stdout.includes(f.staging),false);assert.equal(child.stderr,'');
});

test('session guard rejects production paths, database symlinks/hardlinks and ambiguous owner selection',async t=>{
  const f=stage(t),dbPath=path.join(f.staging,'data/vault.db');
  const otherSession=path.join(f.staging,'other-session.json');
  fs.writeFileSync(otherSession,JSON.stringify({staging:path.resolve(__dirname,'..')}));
  await assert.rejects(collectEvidence({sessionFile:otherSession}));
  fs.linkSync(dbPath,path.join(f.staging,'hardlink.db'));
  await assert.rejects(collectEvidence({sessionFile:f.sessionFile}));fs.unlinkSync(path.join(f.staging,'hardlink.db'));
  const data=path.join(f.staging,'data');fs.renameSync(data,path.join(f.staging,'actual-data'));fs.symlinkSync(path.join(f.staging,'actual-data'),data,'dir');
  await assert.rejects(collectEvidence({sessionFile:f.sessionFile}));fs.unlinkSync(data);fs.renameSync(path.join(f.staging,'actual-data'),data);
  f.db.exec("INSERT INTO acceptance_runs VALUES(1,'synthetic','cycle1','synthetic','[]');INSERT INTO acceptance_runs VALUES(2,'synthetic','cycle2','synthetic','[]')");
  await assert.rejects(collectEvidence({sessionFile:f.sessionFile}),/select_one_test_owner/);
  assert.equal((await collectEvidence({sessionFile:f.sessionFile,userId:3})).outcome,'pending');
});
