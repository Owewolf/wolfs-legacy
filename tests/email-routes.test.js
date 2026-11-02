'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const express=require('express');
const {createFixture}=require('./helpers/email-fixture');
const {createNotificationsRouter}=require('../server/routes/notifications');
const {derivedCode}=require('../server/notifications/service');

process.env.JWT_SECRET='fixture-only-email-routes';
async function setup(t) {
  const f=createFixture(t,{verified:false,replyEnabled:false});
  f.env={...f.env,SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_USERNAME:'fixture-user',SMTP_PASSWORD:'fixture-app-password',
    CHECKIN_IMAP_HOST:'imap.example.test',CHECKIN_IMAP_USERNAME:'fixture-user',CHECKIN_IMAP_PASSWORD:'fixture-app-password'};
  f.db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT; ALTER TABLE users ADD COLUMN sms_2fa_enabled INTEGER DEFAULT 0');
  f.db.prepare('UPDATE users SET password_hash=?').run(await bcrypt.hash('fixture-current-password',4));
  const app=express();app.locals.getDb=()=>f.db;app.use(express.json());
  app.use('/api/notifications',createNotificationsRouter({getDb:()=>f.db,env:f.env,now:f.now}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  f.request=async(path='',{method='GET',body,userId=1,auth=true,mfa}={})=>{
    const res=await fetch(`http://127.0.0.1:${server.address().port}/api/notifications${path}`,{method,
      headers:{...(auth?{Authorization:'Bearer '+jwt.sign({id:userId,...(mfa?{mfa}:{})},process.env.JWT_SECRET)}:{}),'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:res.status,headers:res.headers,data:await res.json()};
  };
  return f;
}

test('notification API requires authentication, current password and owner-scoped state',async t=>{
  const f=await setup(t);
  assert.equal((await f.request('',{auth:false})).status,401);
  assert.equal((await f.request('',{userId:999})).status,401);
  assert.equal((await f.request('/verify/start',{method:'POST',body:{recipient:'owner@example.test',password:'wrong'}})).status,401);
  assert.equal(f.jobs('verify_address').length,0);
  const started=await f.request('/verify/start',{method:'POST',body:{recipient:'owner@example.test',password:'fixture-current-password'}});
  assert.equal(started.status,200);
  assert.equal(started.headers.get('cache-control'),'no-store');
  assert.equal(f.jobs('verify_address').length,1);
  const s=f.service.settings(1),token=derivedCode(f.env,'verify',s.verify_nonce);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM notification_outbox').all()).includes(token));
  assert.equal((await f.request('/verify/complete',{method:'POST',userId:2,body:{code:token}})).status,400);
  assert.equal(f.service.settings(1).verified_at,null);
  assert.equal((await f.request('/verify/complete',{method:'POST',body:{code:token}})).status,200);
  const other=await f.request('',{userId:2});
  assert.equal(other.data.settings,null);assert.equal('remaining_codes' in other.data,false);assert.deepEqual(other.data.outbox,[]);
  const own=await f.request();assert.equal(own.data.settings.recipient,'owner@example.test');
  assert.equal(own.data.settings.reply_enabled,true);
  assert.equal(f.jobs().filter(job=>job.status==='queued').length,5);
  assert.equal(own.data.transport_configured,true);
  assert.ok(!JSON.stringify(own.data).includes('fixture-app-password'));
  assert.ok(!JSON.stringify(own.data).includes(f.env.NOTIFICATION_SECRET));
  assert.ok(!JSON.stringify(own.data).includes('verify_hash'));
});

test('notification settings require the verified SMS factor when it is enabled for the owner',async t=>{
  const f=await setup(t);
  f.db.prepare('UPDATE users SET sms_2fa_enabled=1 WHERE id=1').run();
  assert.equal((await f.request()).status,403);
  assert.equal((await f.request('',{mfa:'sms_otp'})).status,200);
});

test('verified owner enables reminder replies without offline codes; retired endpoint returns no codes',async t=>{
  const f=await setup(t);
  assert.equal((await f.request('/recovery-codes',{method:'POST',auth:false})).status,401);
  const retired=await f.request('/recovery-codes',{method:'POST'});
  assert.equal(retired.status,410);
  assert.equal(retired.headers.get('cache-control'),'no-store');
  assert.equal('codes' in retired.data,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes').get().n,0);
  const base={reply_enabled:true,password:'fixture-current-password',timezone:'Africa/Johannesburg',reminder_clock:null};
  assert.equal((await f.request('/settings',{method:'PUT',body:base})).status,400);
  f.db.prepare("UPDATE notification_settings SET verified_at=?,config_status='ready' WHERE user_id=1").run(f.instant);
  assert.equal((await f.request('/settings',{method:'PUT',body:{...base,password:'wrong'}})).status,401);
  assert.equal((await f.request('/settings',{method:'PUT',body:base})).status,200);
  assert.equal(f.service.settings(1).reply_enabled,1);assert.equal(f.jobs().filter(j=>j.status==='queued').length,5);
  assert.equal((await f.request('/test',{method:'POST',body:{password:'fixture-current-password'}})).data.status,'queued');
  assert.equal(f.jobs('email_test').length,1);
  assert.equal((await f.request('/settings',{method:'PUT',body:{...base,timezone:'America/New_York'}})).status,400);
  assert.equal((await f.request('/settings',{method:'PUT',body:{...base,reminder_clock:'25:00'}})).status,400);
  assert.equal((await f.request('/settings',{method:'PUT',body:{...base,reply_enabled:false}})).status,200);
  assert.equal(f.jobs().filter(j=>j.status==='queued').length,0);
  assert.equal(f.beneficiaries()[0].emergency_access_requested,1);
});

test('verification cannot automatically enable reminders without configured inbound transport',async t=>{
  const f=await setup(t);
  await f.request('/verify/start',{method:'POST',body:{recipient:'owner@example.test',password:'fixture-current-password'}});
  const value=derivedCode(f.env,'verify',f.service.settings(1).verify_nonce);
  f.env.CHECKIN_IMAP_PASSWORD='';
  assert.equal((await f.request('/verify/complete',{method:'POST',body:{code:value}})).status,503);
  assert.equal(f.service.settings(1).verified_at,null);
  assert.equal(f.service.settings(1).reply_enabled,0);
  f.env.CHECKIN_IMAP_PASSWORD='fixture-app-password';
  assert.equal((await f.request('/verify/complete',{method:'POST',body:{code:value}})).status,200);
  const cycle=f.config().notification_cycle_id;
  const jobs=f.jobs();
  assert.equal((await f.request('/verify/complete',{method:'POST',body:{code:value}})).status,400);
  assert.equal(f.config().notification_cycle_id,cycle);
  assert.deepEqual(f.jobs(),jobs);
});

test('verification is short-lived, rate limited and superseding rather than a direct verified flag',async t=>{
  const f=await setup(t);
  const body={recipient:'owner@example.test',password:'fixture-current-password'};
  await f.request('/verify/start',{method:'POST',body});
  const first=derivedCode(f.env,'verify',f.service.settings(1).verify_nonce);
  await f.request('/verify/start',{method:'POST',body});
  const second=derivedCode(f.env,'verify',f.service.settings(1).verify_nonce);
  assert.notEqual(first,second);
  assert.equal((await f.request('/verify/complete',{method:'POST',body:{code:first}})).status,400);
  f.setNow(Date.parse(f.instant)+30*60000);
  assert.equal((await f.request('/verify/complete',{method:'POST',body:{code:second}})).status,400);
  assert.equal(f.service.settings(1).verified_at,null);
  assert.equal(f.jobs('verify_address').filter(j=>j.status==='queued').length,1);
  for(let i=0;i<6;i++) await f.request('/verify/complete',{method:'POST',body:{code:'bad'}});
  assert.equal((await f.request('/verify/complete',{method:'POST',body:{code:'bad'}})).status,429);
});

test('mail disabled, wrong reminder count or missing TLS credentials cannot enable mail feature',async t=>{
  const f=await setup(t);
  const body={recipient:'owner@example.test',password:'fixture-current-password'};
  f.env.NOTIFICATIONS_ENABLED='false';assert.equal((await f.request('/verify/start',{method:'POST',body})).status,503);
  f.env.NOTIFICATIONS_ENABLED='true';f.env.NOTIFICATION_REMINDER_DAYS='6';assert.equal((await f.request('/verify/start',{method:'POST',body})).status,503);
  f.env.NOTIFICATION_REMINDER_DAYS='5';f.env.SMTP_PASSWORD='';assert.equal((await f.request('/verify/start',{method:'POST',body})).status,503);
  assert.equal(f.jobs('verify_address').length,0);assert.equal(f.service.settings(1).verified_at,null);
});
