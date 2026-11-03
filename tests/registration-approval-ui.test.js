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

// The real frontend runs with synthetic in-browser API responses. No database,
// provider credentials, outgoing SMS or production account is used.
const fixture = String.raw`
localStorage.removeItem('lv_token');
const fixtureCalls=[];
let fixtureStatus='pending',fixtureActor='owner';
const fixtureOwner={id:1,name:'Synthetic owner',email:'owner@example.test',is_registration_owner:true};
const fixtureApplicant={id:2,name:'Synthetic applicant',email:'applicant@example.test',is_registration_owner:false};
const fixtureRequests=[
 {id:'request-approve',name:'<img src=x onerror="window.fixtureInjected=true">',email:'applicant@example.test',phone:'+27821234567',status:'pending',notification_status:'failed',notification_attempts:1,created_at:'2026-11-03T12:00:00Z'},
 {id:'request-reject',name:'Another applicant',email:'another@example.test',phone:'+27821234568',status:'pending',created_at:'2026-11-03T12:01:00Z'},
 {id:'request-unavailable',name:'Changed family details',email:'changed@example.test',phone:'+27821234569',status:'unavailable',notification_status:'failed',notification_attempts:1,created_at:'2026-11-03T12:02:00Z'},
 {id:'request-temporary',name:'Temporary family outage',email:'temporary@example.test',phone:'+27821234570',status:'temporarily_unavailable',notification_status:'failed',notification_attempts:1,created_at:'2026-11-03T12:03:00Z'}
];
const fixtureNativeFetch=window.fetch.bind(window);
window.fetch=async(input,options={})=>{
 const url=String(input);
 if(!url.startsWith('/api/')){
  if(url.startsWith('/')||url.startsWith(location.origin+'/'))return fixtureNativeFetch(input,options);
  throw new Error('External fetch is disabled in the approval fixture');
 }
 const route=url.slice(4),method=options.method||'GET';
 const headers=new Headers(options.headers);
 const body=options.body?JSON.parse(options.body):undefined;
 fixtureCalls.push({route,method,body,auth:headers.get('Authorization'),secret:headers.get('X-Registration-Secret')});
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 if(route==='/auth/registration-requests')return response({message:'Request submitted. Account creation requires owner approval.',request_id:'private-request',status_secret:'synthetic-private-status-secret'},202);
 if(route.startsWith('/auth/registration-requests/status?'))return response({request_id:'private-request',status:fixtureStatus,...(fixtureStatus==='approved'?{invitation_url:location.origin+'/#register/invite/synthetic-approved-invitation'}:{})});
 if(route==='/auth/registration-invitation'&&method==='POST'){
  if(body?.invitation_token.includes('expired'))return response({error:'This invitation has expired.',code:'INVITATION_EXPIRED'},410);
  return response({name:fixtureApplicant.name,email:fixtureApplicant.email,phone:'+27821234567',request_id:'private-request'});
 }
 const challenge={requires_second_factor:true,challenge_id:'synthetic-challenge',challenge_token:'synthetic-challenge-secret',masked_phone:'+27******567',recovery_code_allowed:false,resend_available_at:new Date(Date.now()+60000).toISOString()};
 if(route==='/auth/login')return response(challenge);
 if(route==='/auth/register')return response(challenge,201);
 if(route==='/auth/login/challenge/verify')return response({token:fixtureActor==='owner'?'synthetic-owner-session':'synthetic-applicant-session',user:fixtureActor==='owner'?fixtureOwner:fixtureApplicant});
 if(route==='/auth/me')return response(fixtureActor==='owner'?fixtureOwner:fixtureApplicant);
 if(route.startsWith('/auth/admin/registration-requests')){
  if(headers.get('Authorization')!=='Bearer synthetic-owner-session')return response({error:'Owner access required'},403);
  if(method==='GET')return response({requests:fixtureRequests});
  const id=route.split('/')[4],action=route.split('/')[5];
  const row=fixtureRequests.find(row=>row.id===id);
  if(route.endsWith('/notification/retry')){row.notification_status='submitted';return response({ok:true});}
  row.status=action==='approve'?'approved':'rejected';
  if(action==='approve')row.invitation_url=location.origin+'/#register/invite/synthetic-approved-invitation';
  return response({status:row.status,...(action==='approve'?{invitation_url:location.origin+'/#register/invite/synthetic-approved-invitation'}:{})});
 }
 if(route==='/synthetic/blocked')return response({error:'Account access is blocked',code:'ACCOUNT_BLOCKED'},403);
 if(route==='/synthetic/revoked')return response({error:'Sign in again',code:'SESSION_REVOKED'},401);
 if(route==='/vault/summary'||route==='/final-wishes/legacy')return response([]);
 return response({error:'Unexpected fixture route: '+route},404);
};
`;

const checks = String.raw`
(async()=>{
 const checks=[];
 const check=(value,label)=>{if(!value)throw new Error(label);checks.push(label);};
 const pause=()=>new Promise(resolve=>setTimeout(resolve,30));
 const until=async(predicate,label)=>{for(let n=0;n<200;n++){if(predicate())return;await pause();}throw new Error('Timed out: '+label);};
 const submit=form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 const fits=label=>check(document.documentElement.scrollWidth<=innerWidth+1,label+' fits the viewport');
 const calls=route=>fixtureCalls.filter(call=>call.route.startsWith(route));
 const decisions=()=>calls('/auth/admin/registration-requests').filter(call=>call.method==='POST'&&!call.route.endsWith('/notification/retry'));
 const noSession=()=>!API.token&&!localStorage.getItem('lv_token');
 const route=async(hash,selector)=>{const previousView=document.getElementById('app').firstElementChild;location.hash=hash;await until(()=>!previousView?.isConnected&&document.querySelector(selector),hash);await pause();};
 await until(()=>document.getElementById('reg-form'),'public request');
 const form=document.getElementById('reg-form');
 check(!form.querySelector('[type="password"]')&&form.textContent.includes('Request Access'),'public access request collects no password');
 check(document.querySelector('.auth-box .subtitle').textContent.includes('family beneficiaries')&&document.querySelector('.auth-box .subtitle').textContent.includes('email and cell phone must match'),'public request explains family eligibility and both matching saved contacts');
 const phone=form.querySelector('[name="phone"]');
 check(phone.type==='tel'&&phone.required&&phone.autocomplete==='tel'&&document.getElementById('register-phone-hint').textContent.includes('+27'),'request phone field has accessible country-code guidance');
 fits('Access request');
 form.elements.name.value='Synthetic applicant';form.elements.email.value='applicant@example.test';form.elements.phone.value='0821234567';
 submit(form);submit(form);
 await until(()=>document.getElementById('registration-status-refresh'),'private pending view');
 await until(()=>calls('/auth/registration-requests/status').length&&!document.getElementById('registration-status-refresh').disabled,'initial status');
 check(calls('/auth/registration-requests').filter(call=>call.method==='POST').length===1&&calls('/auth/register').length===0&&noSession(),'a double submit makes one access request and creates no account or session');
 const requested=calls('/auth/registration-requests').find(call=>call.method==='POST');
 check(Object.keys(requested.body).sort().join(',')==='email,name,phone','public request sends only the claimed name and contact details');
 let statusCall=calls('/auth/registration-requests/status').at(-1);
 check(statusCall.secret==='synthetic-private-status-secret'&&!statusCall.route.includes('synthetic-private-status-secret'),'private status sends its secret in a header');
 check(document.activeElement===document.getElementById('registration-status')&&!document.getElementById('registration-complete-link'),'pending confirmation receives focus and provides no registration action');
 check(document.getElementById('registration-status-link').value.includes('#register/status/')&&!JSON.stringify({...localStorage,...sessionStorage}).includes('synthetic-private-status-secret'),'private status can be saved without storing the secret in browser storage');
 fits('Pending request');
 fixtureStatus='rejected';document.getElementById('registration-status-refresh').click();
 await until(()=>document.getElementById('registration-status').textContent.includes('declined'),'rejected status');
 check(document.getElementById('registration-status-refresh').hidden&&!document.getElementById('registration-complete-link')&&!document.getElementById('otp-resend-btn')&&!document.getElementById('reg-form'),'rejected request offers no reapplication, account creation or SMS resend');
 fits('Rejected request');
 fixtureStatus='expired';await route('register/status/private-request/synthetic-private-status-secret-expired','#registration-status');
 await until(()=>document.getElementById('registration-status').textContent.includes('expired'),'expired approval');
 check(document.getElementById('registration-status-refresh').hidden&&!document.getElementById('registration-complete-link'),'expired approval explains the invitation expiry without reopening registration');
 fixtureStatus='unavailable';await route('register/status/private-request/synthetic-private-status-secret-unavailable','#registration-status');
 await until(()=>document.getElementById('registration-status').textContent.includes('no longer eligible'),'changed family eligibility');
 check(document.getElementById('registration-status-refresh').hidden&&!document.getElementById('registration-complete-link')&&document.getElementById('registration-new-request-link').getAttribute('href')==='#register'&&document.getElementById('registration-status').textContent.includes('saved email and cell phone'),'invalidated request explains correcting family details and offers only a fresh application');
 fixtureStatus='approved';await route('register/status/private-request/synthetic-private-status-secret-approved','#registration-complete-link');
 check(document.getElementById('registration-complete-link').href.startsWith(location.origin+'/#register/invite/'),'approved status offers an invitation on this application');
 fits('Approved request');
 await route('admin/registration-requests/request-approve','#login-form');
 check(location.hash==='#login'&&calls('/auth/admin/registration-requests').length===0,'SMS review link requires normal owner authentication before loading applicant data');
 let login=document.getElementById('login-form');login.elements.email.value='owner@example.test';login.elements.password.value='synthetic-owner-password';submit(login);
 await until(()=>document.getElementById('otp-form'),'owner OTP');
 check(noSession()&&calls('/auth/admin/registration-requests').length===0,'password-only owner login cannot inspect or decide registration requests');
 document.getElementById('otp-form').elements.otp.value='123456';submit(document.getElementById('otp-form'));
 await until(()=>document.querySelector('[data-decision="approve"]'),'authenticated request review');
 check(location.hash==='#admin/registration-requests/request-approve'&&API.token==='synthetic-owner-session','SMS verification returns the owner to the requested review page');
 check(document.querySelector('[data-nav="admin/registration-requests"]')&&!document.querySelector('.registration-request img')&&!window.fixtureInjected,'only the owner sees management navigation and applicant names render as text');
 fits('Owner request review');
 const card=document.querySelector('[data-request-id="request-approve"]');
 card.querySelector('[data-decision="notification/retry"]').click();
 check(!calls('/auth/admin/registration-requests').some(call=>call.route.endsWith('/notification/retry')),'failed owner SMS retry requires explicit owner confirmation');
 submit(card.querySelector('form'));await until(()=>card.querySelector('[data-notification-status]').textContent.includes('submitted'),'owner notification retry');
 check(calls('/auth/admin/registration-requests').find(call=>call.route.endsWith('/notification/retry')).body.confirmed===true&&card.querySelector('[data-request-status]').textContent==='pending'&&!card.querySelector('[data-decision="notification/retry"]'),'owner notification retry keeps the request pending and removes its spent retry control');
 card.querySelector('[data-decision="approve"]').click();
 check(decisions().length===0&&document.activeElement===card.querySelector('button[type="submit"]'),'approval waits for explicit confirmation and focuses its control');
 card.querySelector('[data-cancel]').click();
 check(!card.querySelector('form')&&decisions().length===0,'canceling approval makes no decision');
 card.querySelector('[data-decision="approve"]').click();
 const approvalForm=card.querySelector('form');submit(approvalForm);submit(approvalForm);
 await until(()=>card.querySelector('input[readonly]'),'private owner invitation');
 const approval=decisions()[0];
 check(approval.auth==='Bearer synthetic-owner-session'&&approval.body.confirmed===true&&decisions().length===1,'confirmed approval uses the verified owner session and suppresses duplicate clicks');
 check(card.querySelector('input[readonly]').value.includes('#register/invite/')&&calls('/auth/register').length===0,'approval gives the owner a private invitation without creating an applicant account');
 fits('Owner invitation');
 await route('admin/registration-requests','#registration-filter');
 const filter=document.getElementById('registration-filter');filter.value='approved';filter.dispatchEvent(new Event('change'));
 await until(()=>document.querySelector('[data-request-id="request-approve"] input[readonly]'),'approved list invitation');
 check(document.querySelector('[data-request-id="request-approve"] input[readonly]').value.includes('#register/invite/'),'owner can recover an eligible invitation when reopening approved requests');
 await route('admin/registration-requests/request-unavailable','[data-request-id="request-unavailable"]');
 const unavailableCard=document.querySelector('[data-request-id="request-unavailable"]');
 check(unavailableCard.querySelector('[data-request-status] .badge')?.textContent==='Unavailable'&&!unavailableCard.querySelector('[data-decision],input[readonly]')&&unavailableCard.textContent.includes('submit a new request'),'owner sees the unavailable family request without approve or SMS retry controls');
 await route('admin/registration-requests/request-temporary','[data-request-id="request-temporary"]');
 const temporaryCard=document.querySelector('[data-request-id="request-temporary"]');
 check(temporaryCard.querySelector('[data-request-status] .badge')?.textContent==='Temporarily Unavailable'&&!temporaryCard.querySelector('[data-decision],input[readonly]')&&temporaryCard.textContent.includes('Restore the family configuration')&&!temporaryCard.textContent.includes('new request'),'temporary family outage asks owner to restore configuration and refresh without new applications or decision controls');
 await route('admin/registration-requests/request-reject','[data-request-id="request-reject"]');
 document.querySelector('[data-decision="reject"]').click();
 let rejectionForm=document.querySelector('.registration-confirm-form');
 check(rejectionForm.textContent.includes('Existing legitimate accounts are protected'),'rejection clearly distinguishes application denial from existing account access');
 rejectionForm.elements.reason.value='Synthetic private reason';submit(rejectionForm);
 await until(()=>document.querySelector('.registration-decision')?.textContent.includes('Further registration requests'),'confirmed rejection');
 const rejection=calls('/auth/admin/registration-requests').find(call=>call.route.endsWith('/reject'));
 check(rejection.body.confirmed===true&&rejection.body.reason==='Synthetic private reason','rejection submits an explicit owner decision and private reason');
 fits('Owner rejection');
 API.setToken(null);state.user=null;fixtureActor='applicant';
 await route('register/invite/expired-invitation','#invitation-loading[role="alert"]');
 check(!document.getElementById('register-password')&&document.activeElement===document.getElementById('invitation-loading'),'expired invitation fails closed with a focused accessible error');
 await route('register/invite/synthetic-approved-invitation','#register-password');
 const invitationLookup=calls('/auth/registration-invitation').at(-1);
 check(invitationLookup.method==='POST'&&invitationLookup.route==='/auth/registration-invitation'&&invitationLookup.body.invitation_token==='synthetic-approved-invitation','invitation lookup keeps its bearer token in the request body and out of logged URLs');
 check(document.getElementById('invitation-phone').textContent==='+27821234567'&&!document.querySelector('[name="email"]')&&!document.querySelector('[name="phone"]'),'invitation identity comes from the server and cannot be changed in the form');
 fits('Invited password form');
 document.getElementById('reg-form').elements.password.value='synthetic-applicant-password';submit(document.getElementById('reg-form'));
 await until(()=>document.getElementById('otp-form'),'applicant OTP');
 const registration=calls('/auth/register')[0];
 check(registration.body.invitation_token==='synthetic-approved-invitation'&&Object.keys(registration.body).sort().join(',')==='invitation_token,password','invited registration binds password creation to the one-use token');
 check(noSession()&&document.getElementById('register-password').value===''&&!document.getElementById('login-recovery-code'),'approved applicant still needs their SMS code before any session is stored');
 fits('Applicant OTP');
 document.getElementById('otp-form').elements.otp.value='123456';submit(document.getElementById('otp-form'));
 await until(()=>document.getElementById('logout-btn'),'verified applicant vault');
 check(API.token==='synthetic-applicant-session'&&!document.querySelector('[data-nav="admin/registration-requests"]'),'verified applicant enters their vault without owner management controls');
 await route('admin/registration-requests','#registration-admin-status[role="alert"]');
 check(!document.querySelector('[data-decision]')&&!document.querySelector('[data-nav="admin/registration-requests"]'),'ordinary users cannot open the owner review controls through a direct route');
 await API.request('GET','/synthetic/blocked').catch(()=>{});
 await until(()=>document.getElementById('login-form'),'blocked session reset');
 check(noSession()&&!state.user&&location.hash==='#login','an account-blocked response clears the stored session and returns to sign-in');
 API.setToken('synthetic-applicant-session');state.user=fixtureApplicant;await route('vault','#logout-btn');
 await API.request('GET','/synthetic/revoked').catch(()=>{});
 await until(()=>document.getElementById('login-form'),'revoked session reset');
 check(noSession()&&!state.user&&location.hash==='#login','a revoked session cannot retain authenticated UI access');
 check(!/synthetic-challenge|synthetic-owner-password|synthetic-applicant-password|synthetic-approved-invitation|123456/.test(JSON.stringify({...localStorage,...sessionStorage})),'passwords, invitations, status secrets and SMS challenge secrets stay out of browser storage');
 await fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:true,width:innerWidth,checks})});
})().catch(async error=>fetch('/ui-test-result',{method:'POST',body:JSON.stringify({ok:false,error:error.message,stack:error.stack})}));
`;

for (const width of [390, 1100]) {
  test(`owner registration request, decision, invitation and SMS activation work in Firefox at ${width}px`, {
    timeout: 60000,
    skip: firefox ? false : 'Firefox not installed; set FIREFOX_BIN for browser acceptance',
  }, async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-approval-ui-'));
    let browser, timer, resolveResult, rejectResult;
    let browserErrors = '';
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const server = http.createServer((req, res) => {
      if (req.url === '/ui-test-result' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
        req.on('end', () => { try { resolveResult(JSON.parse(body)); res.end('ok'); } catch (error) { rejectResult(error); res.writeHead(400).end(); } });
        return;
      }
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html><body style="margin:0"><iframe width="${width}" height="1000" title="Registration approval acceptance" style="border:0;display:block" src="/fixture#register"></iframe></body></html>`);
        return;
      }
      if (req.url === '/fixture') {
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8')
          .replace('<div id="app"></div>', `<div id="app"></div><script>${fixture}</script>`)
          .replace('</body>', `<script>${checks}</script></body>`));
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
        await Promise.race([new Promise(resolve => browser.once('close', resolve)), new Promise(resolve => setTimeout(() => { browser.kill('SIGKILL'); resolve(); }, 2000).unref())]);
      }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, '--width', String(Math.max(width, 1200)), '--height', '1100', `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', chunk => { browserErrors = (browserErrors + String(chunk)).slice(-2000); });
    browser.once('error', rejectResult);
    browser.once('exit', code => { if (code !== null && code !== 0) rejectResult(new Error(`Firefox exited ${code}: ${browserErrors}`)); });
    timer = setTimeout(() => rejectResult(new Error(`Approval UI checks timed out: ${browserErrors}`)), 45000);
    const report = await result;
    assert.equal(report.ok, true, [report.error, report.stack].filter(Boolean).join('\n'));
    assert.equal(report.width, width);
    assert.ok(report.checks.length >= 35);
    t.diagnostic(report.checks.join('; '));
  });
}
