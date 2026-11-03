'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const Database=require('better-sqlite3');
const bcrypt=require('bcryptjs');

async function isolatedServer(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wolfs-legacy-startup-'));
  fs.chmodSync(root,0o700);
  const checkout=path.resolve(__dirname,'..');
  for(const directory of ['server','public'])fs.cpSync(path.join(checkout,directory),path.join(root,directory),{recursive:true});
  fs.symlinkSync(path.join(checkout,'node_modules'),path.join(root,'node_modules'),'dir');
  const media=path.join(root,'managed-documents');fs.mkdirSync(media,{mode:0o700});
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const env={...process.env};
  for(const key of Object.keys(env))if(/^(SMTP_|IMAP_|HOMEBANK_|CHECKIN_|NOTIFICATION)/.test(key))delete env[key];
  Object.assign(env,{PORT:String(port),LISTEN_HOST:'127.0.0.1',DOCUMENT_STORAGE_ROOT:media,
    JWT_SECRET:'synthetic-startup-secret-private-fixture',ENCRYPTION_KEY:'ca'.repeat(32),NOTIFICATIONS_ENABLED:'false',AUTH_SMS_REQUIRED:'false',
    COLLECTOR_SMS_ENABLED:'false',SMS_ENABLED:'false',BACKGROUND_JOBS_ENABLED:'true'});
  const base='http://127.0.0.1:'+port;
  let child=null,output='';
  async function start() {
    assert.equal(child,null,'stop the fixture before starting it again');
    child=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    let healthy=false;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null)throw new Error('Isolated startup failed: '+output);
      try{const res=await fetch(base+'/health',{signal:AbortSignal.timeout(1000)});healthy=res.ok;if(healthy)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.ok(healthy,'isolated server became healthy');
  }
  async function stop() {
    if(!child)return;
    const processToStop=child;child=null;
    if(processToStop.exitCode!==null)return processToStop.exitCode;
    const exited=once(processToStop,'exit');processToStop.kill('SIGTERM');
    const [exitCode]=await exited;return exitCode;
  }
  t.after(async()=>{try{await stop();}finally{fs.rmSync(root,{recursive:true,force:true});}});
  await start();
  return {root,base,start,stop,output:()=>output};
}

async function seedExistingAndLogin(root,base,credentials) {
  const headers={'Content-Type':'application/json'};
  const db=new Database(path.join(root,'data','vault.db'));
  try {
    const result=db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)')
      .run(credentials.email,bcrypt.hashSync(credentials.password,4),credentials.name);
    db.prepare('INSERT INTO dead_switch_config(user_id) VALUES(?)').run(result.lastInsertRowid);
  } finally {db.close();}
  const registration=await fetch(base+'/api/auth/register',{method:'POST',headers,body:JSON.stringify(credentials)});
  assert.equal(registration.status,403,'public registration cannot provision an unapproved user');
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers,
    body:JSON.stringify({email:credentials.email,password:credentials.password})});
  assert.equal(login.status,200);
  const {token}=await login.json();assert.ok(token);
  return token;
}

test('isolated production entrypoint starts, serves both legacy APIs and private-media CSP, and exits cleanly',async t=>{
  const {root,base,stop,output}=await isolatedServer(t);
  const page=await fetch(base+'/');assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/media-src 'self' blob:/);
  assert.match(await page.text(),/js\/legacy.js/);
  const token=await seedExistingAndLogin(root,base,{name:'Synthetic owner',email:'startup@example.test',password:'SyntheticLongPassword91!'});
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
  assert.equal(await stop(),0);
  assert.ok(!output().includes('SyntheticLongPassword91!'));
});

test('production startup repairs dedicated wishes with immediate token retrieval and preserves edits across restart',async t=>{
  const fixture=await isolatedServer(t),{base,root}=fixture;
  const token=await seedExistingAndLogin(root,base,{name:'Synthetic repair owner',email:'startup-repair@example.test',password:'SyntheticLongPassword92!'});
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  assert.equal(await fixture.stop(),0);

  // Reproduce an installation with a beneficiary saved before automatic wishes
  // existed. Only this disposable copy is opened; no application DB is touched.
  const dbPath=path.join(root,'data','vault.db');
  const seed=new Database(dbPath);
  let beneficiaryId;
  const existingToken='synthetic-startup-existing-beneficiary-token';
  const {hashToken}=require('../server/crypto');
  try {
    const owner=seed.prepare('SELECT id FROM users WHERE email=?').get('startup-repair@example.test');
    beneficiaryId=Number(seed.prepare('INSERT INTO beneficiaries(user_id,name,email,access_granted,access_token,token_expires_at) VALUES(?,?,?,1,?,?)')
      .run(owner.id,'Synthetic existing beneficiary','existing@example.test',hashToken(existingToken),'2099-01-01T00:00:00.000Z').lastInsertRowid);
    assert.equal(seed.prepare('SELECT COUNT(*) AS n FROM legacy_contents').get().n,0);
  } finally {seed.close();}

  await fixture.start();
  const repairedResponse=await fetch(base+'/api/final-wishes/legacy',{headers});
  assert.equal(repairedResponse.status,200);
  const repaired=await repairedResponse.json();
  assert.equal(repaired.length,1,'the first owner list after startup includes the existing beneficiary wish');
  const existingWish=repaired[0];
  assert.equal(existingWish.title,'Synthetic existing beneficiary');
  assert.equal(existingWish.metadata.final_wishes.content_type,'');
  assert.equal(existingWish.metadata.final_wishes.category,'Beneficiary Instructions');
  assert.equal(existingWish.review_enabled,false);
  assert.equal(existingWish.next_review_at,null);
  assert.equal(existingWish.status,'draft');
  assert.equal(existingWish.release_policy,'owner_only');
  assert.deepEqual(existingWish.beneficiary_ids,[beneficiaryId]);
  assert.equal(existingWish.final_wishes_entry_id,null);
  assert.equal(existingWish.auto_generated,true);
  assert.deepEqual(existingWish.locked_beneficiary,{id:beneficiaryId,name:'Synthetic existing beneficiary'});
  const repairedTokenView=await fetch(base+'/api/beneficiary-access/legacy/'+existingWish.id,{headers:{Authorization:'Bearer '+existingToken}});
  assert.equal(repairedTokenView.status,200);
  assert.equal((await repairedTokenView.json()).id,existingWish.id);

  const createdResponse=await fetch(base+'/api/beneficiaries',{method:'POST',headers,
    body:JSON.stringify({name:'Synthetic future beneficiary',email:'future@example.test',relationship:'Friend'})});
  assert.equal(createdResponse.status,200);
  const beneficiary=await createdResponse.json();
  assert.ok(beneficiary.final_wish_id,'the new-beneficiary response identifies its editable wish');
  assert.notEqual(beneficiary.final_wish_id,existingWish.id);
  const newWishResponse=await fetch(base+'/api/final-wishes/legacy/'+beneficiary.final_wish_id,{headers});
  assert.equal(newWishResponse.status,200);
  const newWish=await newWishResponse.json();
  assert.equal(newWish.title,'Synthetic future beneficiary');
  assert.equal(newWish.metadata.final_wishes.content_type,'');
  assert.equal(newWish.metadata.final_wishes.category,'Beneficiary Instructions');
  assert.equal(newWish.review_enabled,false);
  assert.equal(newWish.next_review_at,null);
  assert.deepEqual(newWish.beneficiary_ids,[beneficiary.id]);
  assert.equal(newWish.status,'draft');
  assert.equal(newWish.release_policy,'owner_only');
  assert.equal(newWish.auto_generated,true);
  const recipientHeaders={Authorization:'Bearer '+beneficiary.accessToken};
  const noAccess=await fetch(base+'/api/beneficiaries/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:beneficiary.accessToken})});
  assert.equal(noAccess.status,200);
  assert.equal(noAccess.headers.get('cache-control'),'private, no-store');
  const portal=await noAccess.json();
  assert.equal(portal.status,'no_access');
  assert.equal(portal.personal_final_wish_available,true);
  assert.ok(!portal.entries?.length);
  const initialRecipientList=await fetch(base+'/api/beneficiary-access/legacy',{headers:recipientHeaders});
  assert.equal(initialRecipientList.status,200);
  assert.deepEqual((await initialRecipientList.json()).map(item=>item.id),[newWish.id]);

  for(const [wish,name] of [[existingWish,'existing'],[newWish,'future']]) {
    const editedResponse=await fetch(base+'/api/final-wishes/legacy/'+wish.id,{method:'PATCH',headers,
      body:JSON.stringify({title:'Edited wish for '+name,body_markdown:'Private wishes for the '+name+' beneficiary.'})});
    assert.equal(editedResponse.status,200);
    const edited=await editedResponse.json();
    assert.equal(edited.title,'Edited wish for '+name);
    assert.equal(edited.revision,2);
    assert.equal(edited.release_policy,'owner_only');
    assert.deepEqual(edited.beneficiary_ids,wish.beneficiary_ids);
    const tokenView=await fetch(base+'/api/beneficiary-access/legacy/'+wish.id,{headers:{Authorization:'Bearer '+(name==='future'?beneficiary.accessToken:existingToken)}});
    assert.equal(tokenView.status,200);
    const recipientItem=await tokenView.json();
    assert.equal(recipientItem.id,wish.id);
    assert.equal(recipientItem.body_markdown,'Private wishes for the '+name+' beneficiary.');
  }

  assert.equal(await fixture.stop(),0);
  await fixture.start();
  const repeatedResponse=await fetch(base+'/api/final-wishes/legacy',{headers});
  assert.equal(repeatedResponse.status,200);
  const repeated=await repeatedResponse.json();
  assert.deepEqual(repeated.map(x=>x.id).sort(),[existingWish.id,newWish.id].sort(),'restart does not add duplicate drafts');
  for(const [wish,name] of [[existingWish,'existing'],[newWish,'future']]) {
    const saved=repeated.find(x=>x.id===wish.id);
    assert.equal(saved.title,'Edited wish for '+name);
    assert.equal(saved.body_markdown,'Private wishes for the '+name+' beneficiary.');
    assert.equal(saved.revision,2,'startup preserves the owner’s edits');
    const afterRestart=await fetch(base+'/api/beneficiary-access/legacy/'+wish.id,{headers:{Authorization:'Bearer '+(name==='future'?beneficiary.accessToken:existingToken)}});
    assert.equal(afterRestart.status,200);
    assert.equal((await afterRestart.json()).body_markdown,saved.body_markdown);
  }
  assert.equal(await fixture.stop(),0);
  const verify=new Database(dbPath,{readonly:true});
  try {
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM legacy_contents').get().n,2);
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM legacy_beneficiary_auto_wishes').get().n,2);
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM vault_entries').get().n,0,'wishes stay outside the general vault');
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM legacy_content_beneficiaries WHERE released_at IS NOT NULL').get().n,0);
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n,0);
    assert.equal(verify.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(beneficiaryId).access_granted,1,
      'backfill preserves existing access state');
    assert.equal(verify.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(beneficiary.id).access_granted,0);
    for(const row of verify.prepare('SELECT payload_encrypted FROM legacy_contents').all()) {
      assert.ok(!row.payload_encrypted.includes('Private wishes'));
      assert.ok(!row.payload_encrypted.includes('Synthetic'));
    }
  } finally {verify.close();}
  assert.ok(!fixture.output().includes('SyntheticLongPassword92!'));
});
