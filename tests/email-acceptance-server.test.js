'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const Database=require('better-sqlite3');
const crypto=require('node:crypto');
const {prepareAcceptance,waitForReady}=require('../scripts/email-acceptance-server');
const {seedMailbox}=require('../scripts/email-acceptance/mailbox');

async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('acceptance harness isolates paths/secrets and protects one-time real reminder setup',async t=>{
  const prepared=prepareAcceptance({port:await freePort(),mailEnv:{SMTP_PASSWORD:'synthetic-secret',HOMEBANK_DIRECTORY:'/private-source',
    DOCUMENT_STORAGE_ROOT:'/private-documents',JWT_SECRET:'must-not-inherit',NOTIFICATION_ALERT_COMMAND:'/must-not-run'}});
  const child=spawn(process.execPath,[prepared.bootstrapFile],{cwd:prepared.staging,env:prepared.childEnv,stdio:'ignore'});
  t.after(async()=>{
    if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}
    fs.rmSync(prepared.staging,{recursive:true,force:true});
  });
  assert.equal(prepared.childEnv.LISTEN_HOST,'127.0.0.1');
  assert.equal(prepared.childEnv.NOTIFICATIONS_ENABLED,'false');
  assert.equal(prepared.childEnv.SMTP_PASSWORD,'synthetic-secret');
  assert.notEqual(prepared.childEnv.JWT_SECRET,'must-not-inherit');
  assert.equal(prepared.childEnv.NOTIFICATION_ALERT_COMMAND,undefined);
  assert.equal(prepared.childEnv.HOMEBANK_DIRECTORY,path.join(prepared.staging,'empty-homebank'));
  assert.equal(prepared.childEnv.DOCUMENT_STORAGE_ROOT,path.join(prepared.staging,'managed-documents'));
  assert.equal(fs.existsSync(path.join(prepared.staging,'.env')),false);
  assert.equal(fs.existsSync(path.join(prepared.staging,'data/vault.db')),false);
  assert.ok(new Date(prepared.childEnv.EMAIL_ACCEPTANCE_EXPIRES_AT)-Date.now()<=2*60*60*1000);
  const template=require(path.join(prepared.staging,'server/notifications/templates')).renderTemplate('reminder',{
    daysRemaining:5,reminderNumber:1,releaseAt:'2026-11-05T12:00:00Z',challengeExpiresAt:'2026-11-01T12:00:00Z',challenge:'WL-FAKE-EXAMPLE',confirmationMailbox:'reply@example.invalid'});
  assert.match(template.subject,/^\[ACCEPTANCE TEST\]/);
  assert.match(template.text,/Disposable synthetic vault/);
  assert.match(template.html,/Disposable synthetic vault/);
  const action=template.text.match(/mailto:[^\r\n]+/)[0];
  assert.equal(new URL(action).searchParams.get('body'),'CONFIRM WL-FAKE-EXAMPLE');
  await waitForReady(child,prepared.port,prepared.childEnv.EMAIL_ACCEPTANCE_ID);
  const base=`http://127.0.0.1:${prepared.port}`;
  const request=(route,body,token)=>fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',
    ...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const missing=await request('/api/does-not-exist');
  assert.equal(missing.status,404);
  assert.match(missing.headers.get('content-type'),/application\/json/);
  assert.deepEqual(await missing.json(),{error:'API endpoint not found'});
  assert.equal((await request('/api/notifications/acceptance/status')).status,401);
  const password=prepared.syntheticOwner.password;
  const registered=await request('/api/auth/register',{name:'Synthetic acceptance owner',email:'owner@example.invalid',password});
  assert.equal(registered.status,403,'the mail harness cannot bypass owner approval through public registration');
  const login=await request('/api/auth/login',{email:'owner@example.invalid',password});
  assert.equal(login.status,200);
  const {token}=await login.json();
  assert.ok(token);
  assert.deepEqual(await(await request('/api/notifications/acceptance/status',null,token)).json(),{started:false});
  assert.equal((await request('/api/notifications/acceptance/reminder',{password:'wrong'},token)).status,401);
  assert.equal((await request('/api/notifications/acceptance/reminder',{password},token)).status,400);
  const db=new Database(path.join(prepared.staging,'data/vault.db'));
  t.after(()=>db.close());
  db.prepare(`INSERT INTO notification_settings(user_id,recipient,verified_at,reply_enabled,config_status)
    VALUES(1,'owner@example.invalid',?,1,'ready')`).run(new Date().toISOString());
  const response=await request('/api/notifications/acceptance/reminder',{password},token);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'queued');
  const run=db.prepare('SELECT * FROM acceptance_runs').get();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE cycle_id=? AND event_type='reminder'").get(run.cycle_id).n,5);
  const first=db.prepare("SELECT schedule_at FROM notification_outbox WHERE cycle_id=? AND reminder_number=1").get(run.cycle_id);
  assert.ok(new Date(first.schedule_at)>=new Date(run.started_at));
  const expiry=db.prepare('SELECT expiry_at FROM notification_cycles WHERE id=?').get(run.cycle_id).expiry_at;
  assert.ok(new Date(expiry)-new Date(run.started_at)>=5*86400000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM beneficiaries WHERE emergency_access_requested=1 AND access_granted=0').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM beneficiaries WHERE emergency_access_requested=0 AND access_granted=1').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vault_entries').get().n,0);
  const status=await(await request('/api/notifications/acceptance/status',null,token)).json();
  assert.equal(status.accepted_replies,0);
  assert.equal(status.consumed_confirmations,0);
  assert.equal((await request('/api/notifications/acceptance/reminder',{password},token)).status,409);
  const html=await(await fetch(base)).text();
  assert.match(html,/\/js\/acceptance\.js/);
  assert.equal(JSON.stringify(status).includes('synthetic-secret'),false);
});

test('acceptance preflight seeds current UID tail read-only without fetching historical messages',async()=>{
  const db=new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER); CREATE TABLE inbound_checkpoints(account TEXT,mailbox TEXT,uid_validity TEXT,last_uid INTEGER)');
  const env={CHECKIN_IMAP_HOST:'imap.example.invalid',CHECKIN_IMAP_USERNAME:'synthetic',CHECKIN_IMAP_PASSWORD:'synthetic-secret'};
  const calls=[];
  const checkpoint=await seedMailbox(db,env,{createClient:options=>{
    assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.logger,false);
    return {mailbox:{uidValidity:123n,uidNext:98765},on(){},async connect(){calls.push('connect');},
      async getMailboxLock(mailbox,settings){assert.equal(mailbox,'INBOX');assert.deepEqual(settings,{readOnly:true});calls.push('readOnly');return{release(){calls.push('release');}};},
      async logout(){calls.push('logout');}};
  }});
  assert.deepEqual(calls,['connect','readOnly','release','logout']);
  assert.equal(checkpoint.last_uid,98764);
  assert.equal(checkpoint.account,crypto.createHash('sha256').update(JSON.stringify(['imap.example.invalid',993,'synthetic'])).digest('hex'));
  assert.equal(db.prepare('SELECT last_uid FROM inbound_checkpoints').get().last_uid,98764);
  db.exec('INSERT INTO users VALUES(1)');
  await assert.rejects(seedMailbox(db,env),/Fresh acceptance database/);
  db.close();
});
