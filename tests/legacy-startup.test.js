'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');

test('isolated production entrypoint starts, serves both legacy APIs and private-media CSP, and exits cleanly',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wolfs-legacy-startup-'));
  fs.chmodSync(root,0o700);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const checkout=path.resolve(__dirname,'..');
  for(const directory of ['server','public'])fs.cpSync(path.join(checkout,directory),path.join(root,directory),{recursive:true});
  fs.symlinkSync(path.join(checkout,'node_modules'),path.join(root,'node_modules'),'dir');
  const media=path.join(root,'managed-documents');fs.mkdirSync(media,{mode:0o700});
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(SMTP_|IMAP_|HOMEBANK_|CHECKIN_|NOTIFICATION)/.test(key))delete env[key];
  Object.assign(env,{PORT:String(port),LISTEN_HOST:'127.0.0.1',DOCUMENT_STORAGE_ROOT:media,
    JWT_SECRET:'synthetic-startup-secret-private-fixture',ENCRYPTION_KEY:'ca'.repeat(32),NOTIFICATIONS_ENABLED:'false'});
  const child=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const base='http://127.0.0.1:'+port;
  let healthy=false;
  for(let i=0;i<100;i++) {
    if(child.exitCode!==null)throw new Error('Isolated startup failed: '+output);
    try{const res=await fetch(base+'/health');healthy=res.ok;if(healthy)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.ok(healthy,'isolated server became healthy');
  const page=await fetch(base+'/');assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/media-src 'self' blob:/);
  assert.match(await page.text(),/js\/legacy.js/);
  const registration=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'Synthetic owner',email:'startup@example.test',password:'SyntheticLongPassword91!'})});
  assert.equal(registration.status,200);const {token}=await registration.json();assert.ok(token);
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const config=await fetch(base+'/api/final-wishes/config',{headers});assert.equal(config.status,200);
  assert.ok((await config.json()).accepted.includes('.wav'));
  const created=await fetch(base+'/api/final-wishes/legacy',{method:'POST',headers,
    body:JSON.stringify({type:'letter',title:'Synthetic startup letter',body_markdown:'**Safe** text'})});
  assert.equal(created.status,201);const item=await created.json();assert.equal(item.release_policy,'owner_only');
  const beneficiary=await fetch(base+'/api/beneficiary-access/legacy',{headers:{Authorization:'Bearer invalid-synthetic-token'}});
  assert.equal(beneficiary.status,403);
  const old=await fetch(base+'/api/vault/export',{headers});assert.equal(old.status,200);
  assert.ok(!(await old.text()).includes(item.id));
  const unknown=await fetch(base+'/api/does-not-exist');assert.equal(unknown.status,404);assert.match(unknown.headers.get('content-type'),/json/);
  child.kill('SIGTERM');const [exitCode]=await once(child,'exit');assert.equal(exitCode,0);
  assert.ok(!output.includes('SyntheticLongPassword91!'));
});
