'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const firefox = [process.env.FIREFOX_BIN, '/usr/bin/firefox', '/usr/bin/firefox-esr']
  .filter(Boolean).find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const publicRoot = path.join(__dirname, '..', 'public');

// The actual frontend runs against intercepted, synthetic responses. This test
// never opens a database, calls a provider or sends an SMS.
const fixture = `
localStorage.removeItem('lv_token');
const fixtureCalls=[];
const fixtureRecovery=['SYNTHETIC-FIRST-RECOVERY','<img src=x onerror="window.fixtureInjected=true">'];
let fixtureMode='registration',fixtureResends=0,fixturePending=null;
const fixtureOriginalFetch=window.fetch.bind(window);
const fixtureUser={id:1,name:'Synthetic owner',email:'owner@example.test'};
const fixtureChallenge=(extra={})=>({requires_second_factor:true,challenge_id:'synthetic-challenge-id',challenge_token:'synthetic-challenge-token',masked_phone:'+27******567',resend_available_at:new Date(Date.now()+1200).toISOString(),recovery_code_allowed:false,...extra});
window.fetch=async(input,options={})=>{
  const url=String(input);
  if(!url.startsWith('/api/')){
    if(url.startsWith('/')||url.startsWith(location.origin+'/'))return fixtureOriginalFetch(input,options);
    throw new Error('External requests are disabled in the synthetic SMS fixture');
  }
  const route=url.slice(4),method=options.method||'GET';
  const body=options.body?JSON.parse(options.body):undefined;
  const auth=new Headers(options.headers).get('Authorization');
  fixtureCalls.push({route,method,auth,body});
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  if(route==='/auth/registration-invitation'&&method==='POST')return response({name:'Synthetic owner',email:fixtureMode==='registration-delivery-failure'?'existing@example.test':'owner@example.test',phone:'+27821234567',request_id:'synthetic-request-id'});
  if(route==='/auth/register'){
    if(fixtureMode==='registration-delivery-failure')return response({error:'Account created, but the SMS code could not be sent. Sign in to request a new code.',account_created:true},503);
    if(fixtureMode==='optional-registration')return response({success:true,sms_required:false},201);
    return response(fixtureChallenge({account_created:true}),201);
  }
  if(route==='/auth/login'){
    if(fixtureMode==='missing-phone')return response({requires_phone_setup:true,setup_token:'synthetic-phone-setup-token',expires_at:new Date(Date.now()+300000).toISOString()});
    if(fixtureMode==='stale-login')return new Promise(resolve=>{fixturePending=()=>resolve(response(fixtureChallenge()));});
    if(fixtureMode==='unmarked-token')return response({token:'synthetic-unmarked-token',user:fixtureUser});
    if(fixtureMode==='optional-login')return response({sms_required:false,token:'synthetic-optional-token',user:fixtureUser});
    return response(fixtureChallenge({recovery_code_allowed:true}));
  }
  if(route==='/auth/login/phone'){
    if(body.phone==='bad')return response({error:'Enter a valid cell phone number'},400);
    return response(fixtureChallenge());
  }
  if(route==='/auth/login/challenge/resend'){
    fixtureResends++;
    if(fixtureResends===1)return response({error:'Please wait before requesting another code',resend_available_at:new Date(Date.now()+1200).toISOString()},429);
    return response({challenge_token:'synthetic-rotated-challenge-token',resend_available_at:new Date(Date.now()+60000).toISOString()});
  }
  if(route==='/auth/login/challenge/verify'){
    if(body.otp==='000000')return response({error:'The SMS code is incorrect'},400);
    if(fixtureMode==='registration')return response({token:'synthetic-registered-session',user:fixtureUser,recovery_codes:fixtureRecovery});
    return response({token:'synthetic-verified-session',user:fixtureUser});
  }
  if(route==='/synthetic/denied-other')return response({error:'Synthetic ordinary denial',code:'OTHER_DENIAL'},403);
  if(route==='/synthetic/denied-sms')return response({error:'Second-factor verification required',code:'SMS_VERIFICATION_REQUIRED'},403);
  if(route==='/auth/me')return response(fixtureUser);
  if(route==='/auth/2fa/status')return response({enabled:true,required:true,masked_phone:'+27******567',recovery_codes_remaining:2});
  if(route==='/vault/summary'||route==='/final-wishes/legacy')return response([]);
  if(route==='/notifications')return response({settings:null,health:[],outbox:[],transport_configured:false,reply_transport_configured:false});
  return response({error:'Unexpected synthetic API route: '+route},404);
};
`;

const browserChecks = `
(async()=>{
  const checks=[];
  function check(value,label){if(!value)throw new Error(label);checks.push(label);}
  const flush=()=>new Promise(resolve=>setTimeout(resolve,40));
  async function until(predicate,label){for(let n=0;n<150;n++){if(predicate())return;await flush();}throw new Error('Timed out: '+label);}
  const submit=form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  const noSession=()=>!API.token&&!localStorage.getItem('lv_token');
  const stored=()=>JSON.stringify({...localStorage,...sessionStorage});
  async function login(mode){
    fixtureMode=mode;API.setToken(null);state.user=null;window.location.hash='login';
    await until(()=>document.getElementById('login-form'),'login form');
    const form=document.getElementById('login-form');
    form.querySelector('[name="email"]').value='owner@example.test';form.querySelector('[name="password"]').value='synthetic-password';
    submit(form);
  }
  await until(()=>document.getElementById('reg-form'),'registration');
  let form=document.getElementById('reg-form');
  check(document.getElementById('invitation-phone').textContent==='+27821234567'&&!form.querySelector('[name="phone"]')&&!form.querySelector('[name="email"]'),'approved registration displays server-bound identity without allowing contact changes');
  form.querySelector('[name="password"]').value='synthetic-password';
  submit(form);await until(()=>document.getElementById('otp-form'),'registration challenge');
  let call=fixtureCalls.find(call=>call.route==='/auth/register');
  check(call.body.invitation_token==='synthetic-invitation-token'&&call.body.password==='synthetic-password'&&Object.keys(call.body).sort().join(',')==='invitation_token,password','registration sends only the one-use invitation and password');
  check(noSession()&&document.getElementById('reg-form').hidden&&document.getElementById('register-password').value==='','registration requires SMS before storing a session and clears its password');
  check(!document.getElementById('login-recovery-code')&&document.getElementById('otp-resend-btn').disabled,'first enrollment only offers SMS and enforces its resend cooldown');
  form=document.getElementById('otp-form');form.querySelector('[name="otp"]').value='000000';submit(form);
  await until(()=>document.getElementById('toast-container')?.textContent.includes('incorrect'),'incorrect OTP error');
  check(noSession()&&document.getElementById('login-otp').value===''&&document.getElementById('otp-form'),'an incorrect OTP leaves the challenge available without a session');
  await until(()=>!document.getElementById('otp-resend-btn').disabled,'initial resend cooldown');
  document.getElementById('otp-resend-btn').click();
  await until(()=>fixtureResends===1&&document.getElementById('otp-resend-btn').disabled&&document.getElementById('otp-meta').textContent.includes('in '),'server resend cooldown');
  check(noSession()&&document.getElementById('otp-meta').textContent.includes('in '),'a server resend limit updates the visible cooldown without creating a session');
  await until(()=>!document.getElementById('otp-resend-btn').disabled,'retry resend cooldown');
  document.getElementById('otp-resend-btn').click();
  await until(()=>fixtureResends===2&&document.getElementById('toast-container')?.textContent.includes('new code'),'resend succeeds');
  form=document.getElementById('otp-form');form.querySelector('[name="otp"]').value='123456';submit(form);
  await until(()=>document.getElementById('login-recovery-continue'),'one-time recovery codes');
  call=fixtureCalls.filter(call=>call.route==='/auth/login/challenge/verify').at(-1);
  check(call.body.challenge_token==='synthetic-rotated-challenge-token','verification uses the latest resend challenge credentials');
  let panel=document.getElementById('login-recovery-codes');
  check(fixtureRecovery.every(code=>panel.textContent.includes(code))&&!panel.querySelector('img')&&!window.fixtureInjected,'first-verification recovery codes are readable escaped text');
  check(document.activeElement===panel&&noSession()&&window.location.hash==='#register/invite/synthetic-invitation-token','recovery codes receive focus and keep the verified session in memory until confirmation');
  await new Promise(resolve=>setTimeout(resolve,200));
  check(panel.isConnected&&fixtureRecovery.every(code=>panel.textContent.includes(code)),'one-time recovery codes remain visible while waiting for explicit confirmation');
  check(!/synthetic-challenge|synthetic-phone-setup|SYNTHETIC-FIRST-RECOVERY|synthetic-password|123456/.test(stored()),'challenge credentials, OTPs, passwords and recovery codes are never persisted in browser storage');
  document.getElementById('login-recovery-continue').click();
  await until(()=>document.getElementById('logout-btn'),'registered vault');
  check(API.token==='synthetic-registered-session'&&localStorage.getItem('lv_token')==='synthetic-registered-session'&&panel.textContent==='','explicit recovery-code confirmation stores the verified session and clears the code display');
  check(fixtureCalls.find(call=>call.route==='/vault/summary').auth==='Bearer synthetic-registered-session','vault requests use only the verified session');
  await login('missing-phone');await until(()=>document.getElementById('login-phone-form'),'legacy missing-phone setup');
  check(noSession()&&document.getElementById('login-phone').required&&!stored().includes('synthetic-phone-setup-token'),'missing saved phone requests a cell phone while keeping the setup token in memory');
  form=document.getElementById('login-phone-form');form.querySelector('[name="phone"]').value='bad';submit(form);
  await until(()=>document.getElementById('toast-container')?.textContent.includes('valid cell phone'),'invalid setup phone');
  check(noSession()&&document.getElementById('login-phone-form'),'invalid phone setup remains editable and does not sign in');
  form.querySelector('[name="phone"]').value='0821234567';submit(form);
  await until(()=>document.getElementById('otp-form'),'setup SMS challenge');
  call=fixtureCalls.filter(call=>call.route==='/auth/login/phone').at(-1);
  check(call.body.phone==='0821234567'&&call.body.setup_token==='synthetic-phone-setup-token'&&!call.auth,'phone setup exchanges its memory-only token for a normal SMS challenge');
  document.getElementById('otp-back-btn').click();await until(()=>document.getElementById('login-form')&&!document.getElementById('otp-form'),'cancel setup');
  check(noSession()&&!document.getElementById('login-phone-form')&&document.getElementById('login-email').value==='owner@example.test','starting over clears phone setup and challenge while preserving only the email field');
  await login('missing-phone');await until(()=>document.getElementById('login-phone-form'),'retry phone setup');
  form=document.getElementById('login-phone-form');form.querySelector('[name="phone"]').value='+27821234567';submit(form);
  await until(()=>document.getElementById('otp-form'),'retry phone SMS');
  form=document.getElementById('otp-form');form.querySelector('[name="otp"]').value='123456';submit(form);
  await until(()=>document.getElementById('logout-btn'),'phone setup verified vault');
  check(API.token==='synthetic-verified-session'&&fixtureCalls.filter(call=>call.route==='/auth/login/phone').length===3,'a missing-phone account enters the vault only after completing its normal SMS challenge');
  await login('saved-phone');await until(()=>document.getElementById('otp-form'),'saved-phone login');
  check(noSession()&&!document.getElementById('login-phone-form')&&document.getElementById('login-2fa-panel').textContent.includes('+27******567'),'future login uses the saved phone and never asks for a replacement number');
  call=fixtureCalls.filter(call=>call.route==='/auth/login').at(-1);
  check(Object.keys(call.body).sort().join(',')==='email,password','future login submits credentials and lets the server select the saved phone');
  form=document.getElementById('otp-form');form.querySelector('[name="recovery_code"]').value='synthetic-recovery-login';submit(form);
  await until(()=>document.getElementById('logout-btn'),'recovery login vault');
  call=fixtureCalls.filter(call=>call.route==='/auth/login/challenge/verify').at(-1);
  check(call.body.recovery_code==='synthetic-recovery-login'&&!Object.hasOwn(call.body,'otp')&&API.token==='synthetic-verified-session','an existing account can verify with a recovery code before receiving its session');
  window.location.hash='settings';await until(()=>document.getElementById('twofa-enroll-form'),'required settings');
  check(!document.getElementById('twofa-disable-form')&&document.getElementById('twofa-enroll-form').textContent.includes('Change Phone'),'required SMS settings offer a verified phone change and no disable action');
  await API.request('GET','/synthetic/denied-other').catch(()=>{});
  check(API.token==='synthetic-verified-session'&&window.location.hash==='#settings','an ordinary forbidden response does not clear authentication or redirect');
  await API.request('GET','/synthetic/denied-sms').catch(()=>{});
  await until(()=>document.getElementById('login-form'),'required verification redirect');
  check(noSession()&&!state.user&&window.location.hash==='#login','a server SMS-verification-required response clears a pre-activation session and requests sign-in');
  await login('stale-login');await until(()=>fixturePending,'pending login');window.location.hash='register';
  await until(()=>document.getElementById('reg-form'),'new route during login');fixturePending();await flush();await flush();
  check(noSession()&&!document.getElementById('otp-form')&&document.getElementById('reg-form'),'a late login response cannot revive a canceled auth flow or store a session');
  await login('unmarked-token');await until(()=>document.getElementById('toast-container')?.textContent.includes('SMS verification is required'),'obsolete API response rejection');
  check(noSession()&&window.location.hash==='#login','an unmarked password-only response cannot bypass required SMS verification');
  await login('optional-login');await until(()=>document.getElementById('logout-btn'),'explicit optional login');
  check(API.token==='synthetic-optional-token','an explicitly optional server preserves password-only development login compatibility');
  API.setToken(null);state.user=null;fixtureMode='optional-registration';window.location.hash='register/invite/synthetic-unmarked-invitation';await until(()=>document.getElementById('register-password'),'unmarked registration');
  form=document.getElementById('reg-form');form.querySelector('[name="password"]').value='synthetic-password';submit(form);
  await until(()=>document.getElementById('toast-container')?.textContent.includes('SMS verification is required'),'unmarked registration response');
  check(noSession()&&window.location.hash==='#register/invite/synthetic-unmarked-invitation','an invitation registration cannot skip required SMS even if the server returns an obsolete optional response');
  API.setToken(null);state.user=null;fixtureMode='registration-delivery-failure';window.location.hash='register/invite/synthetic-delivery-invitation';await until(()=>document.getElementById('register-password')&&document.getElementById('invitation-email')?.textContent==='existing@example.test','delivery failure registration');
  form=document.getElementById('reg-form');form.querySelector('[name="password"]').value='synthetic-password';submit(form);
  await until(()=>document.getElementById('login-form'),'created account recovery after SMS failure');
  check(noSession()&&window.location.hash==='#login'&&document.getElementById('login-email').value==='existing@example.test'&&document.getElementById('login-password').value==='','an approved account with SMS delivery failure returns to sign-in with its email and no password');
  await fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:true,checks})});
})().catch(async error=>{await fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})});});
`;

test('required SMS registration, saved-phone sign-in, recovery confirmation and phone setup run in Firefox', {
  timeout: 60000,
  skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN to run the real browser checks',
}, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-sms-required-ui-'));
  let browser, timer, resolveResult, rejectResult;
  let browserErrors = '';
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const server = http.createServer((req, res) => {
    if (req.url === '/ui-test-result' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        try { resolveResult(JSON.parse(body)); res.end('ok'); }
        catch (error) { rejectResult(error); res.writeHead(400).end(); }
      });
      return;
    }
    if (req.url === '/') {
      const index = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
      res.setHeader('Content-Type', 'text/html');
      res.end(index.replace('<div id="app"></div>', `<div id="app"></div><script>${fixture}</script>`)
        .replace('</body>', `<script>${browserChecks}</script></body>`));
      return;
    }
    const pathname = String(req.url || '').split('?')[0];
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  t.after(async () => {
    clearTimeout(timer);
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => browser.once('close', resolve)),
        new Promise(resolve => setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 2000).unref()),
      ]);
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, `http://127.0.0.1:${server.address().port}/#register/invite/synthetic-invitation-token`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  browser.stderr.on('data', chunk => { browserErrors = (browserErrors + String(chunk)).slice(-2000); });
  browser.once('error', rejectResult);
  browser.once('exit', code => { if (code !== null && code !== 0) rejectResult(new Error(`Firefox exited ${code}: ${browserErrors}`)); });
  timer = setTimeout(() => rejectResult(new Error(`Firefox required SMS UI checks timed out: ${browserErrors}`)), 45000);
  const report = await result;
  assert.equal(report.ok, true, [report.error, report.stack].filter(Boolean).join('\n'));
  assert.equal(report.checks.length, 29);
  t.diagnostic(report.checks.join('; '));
});
