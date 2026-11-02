'use strict';

// Every database is synthetic and held in memory. The constructor guard below
// prevents route initialization from opening any deployed vault database.
const {before,beforeEach,after,test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {once}=require('node:events');
const Database=require('better-sqlite3');
const express=require('express');
const jwt=require('jsonwebtoken');

process.env.ENCRYPTION_KEY='82'.repeat(32);
process.env.JWT_SECRET='synthetic-permanent-delete-secret';
process.env.HOMEBANK_OWNER_EMAIL='separate-homebank-owner@example.test';
process.env.NOTIFICATIONS_ENABLED='false';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'wolfs-permanent-delete-'));
const mediaRoot=path.join(temporary,'managed');
fs.mkdirSync(mediaRoot,{mode:0o700});
process.env.DOCUMENT_STORAGE_ROOT=mediaRoot;
const {encrypt}=require('../server/crypto');
const legacy=require('../server/legacy-content');
const store=require('../server/document-store');
const {initLegacySchema}=require('../server/legacy-schema');
const {ensureBeneficiaryFinalWish,backfillBeneficiaryFinalWishes}=require('../server/beneficiary-final-wishes');
const OWNER=781,OTHER=782;
let db,server,base;

function create(fields={},owner=OWNER) {
  return legacy.save(db,owner,{type:'instruction',title:'Synthetic wish',...fields});
}
function beneficiary(owner=OWNER,name='Synthetic recipient') {
  return Number(db.prepare('INSERT INTO beneficiaries(user_id,name) VALUES(?,?)').run(owner,name).lastInsertRowid);
}
function document(owner=OWNER) {
  const id=crypto.randomUUID(),relative=`owner-${owner}/${id}.txt`;
  const filename=path.join(store.ownerDirectory(owner),id+'.txt');
  fs.writeFileSync(filename,'Synthetic managed copy',{mode:0o600});
  db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,
    stored_filename,mime_type,size_bytes,sha256,legacy_restricted) VALUES(?,?,?,?,?,'text/plain',22,'synthetic-hash',1)`)
    .run(id,owner,encrypt('Synthetic.txt'),encrypt('Synthetic.txt'),relative);
  return {id,filename};
}
function attach(item,doc) {
  db.prepare('INSERT INTO legacy_content_attachments(content_id,document_id) VALUES(?,?)').run(item.id,doc.id);
}
function history(item,doc) {
  db.prepare(`INSERT INTO legacy_content_versions(content_id,revision,payload_encrypted,editor_id,created_at)
    VALUES(?,?,?,?,'2026-01-01')`).run(item.id,100,encrypt(JSON.stringify({attachments:[{document_id:doc.id}]})),OWNER);
}
async function request(id,{owner=OWNER,method='DELETE',body=method==='DELETE'?{confirm_delete:true}:undefined}={}) {
  const response=await fetch(base+'/api/final-wishes/legacy/'+id,{method,
    headers:{Authorization:'Bearer '+jwt.sign({id:owner},process.env.JWT_SECRET), 'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
function count(table,id) {return db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE content_id=?').get(id).n;}

before(async()=>{
  db=new Database(':memory:');
  const cache=require.cache[require.resolve('better-sqlite3')],original=cache.exports;
  cache.exports=function FixtureDatabase(filename){
    assert.equal(filename,path.resolve(__dirname,'../data/vault.db'));
    return db;
  };
  try {assert.equal(require('../server/db').getDb(),db);}finally{cache.exports=original;}
  db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run(OWNER,'owner@example.test','Synthetic owner','synthetic-hash');
  db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run(OTHER,'other@example.test','Synthetic other','synthetic-hash');
  const app=express();app.use(express.json());
  app.use('/api/final-wishes',require('../server/routes/legacy').ownerRouter);
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(()=>{
  db.exec(`DROP TRIGGER IF EXISTS fixture_delete_failure;
    DELETE FROM legacy_contents; DELETE FROM managed_documents; DELETE FROM beneficiaries;
    DELETE FROM vault_entries; DELETE FROM notification_outbox; DELETE FROM audit_log;`);
});
after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(db?.open)db.close();
  fs.rmSync(temporary,{recursive:true,force:true});
});

test('DELETE permanently removes archived content, every dependent record, reminders and exclusive managed copies',async()=>{
  const recipient=beneficiary(),item=create({beneficiary_ids:[recipient]});
  const doc=document(),detached=document();attach(item,doc);history(item,detached);
  legacy.save(db,OWNER,{body_markdown:'Synthetic revised body'},item.id);
  legacy.review(db,OWNER,item.id,{action:'no_change'});
  db.prepare('INSERT INTO legacy_content_acknowledgements VALUES(?,?,?,1,?)').run(item.id,recipient,'one',legacy.now());
  const entry=Number(db.prepare("INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,'vehicles','Synthetic vehicle',?)")
    .run(OWNER,encrypt('{}')).lastInsertRowid);
  db.prepare('INSERT INTO legacy_content_links VALUES(?,?)').run(item.id,entry);
  legacy.save(db,OWNER,{status:'archived'},item.id);
  const other=create({},OTHER);
  const job=Number(db.prepare(`INSERT INTO notification_outbox(event_type,user_id,idempotency_key,schedule_at,data_json,created_at,updated_at)
    VALUES('legacy_review_due',?,'synthetic-delete-review','2026-01-01',?,'2026-01-01','2026-01-01')`)
    .run(OWNER,JSON.stringify({contentId:item.id})).lastInsertRowid);
  db.prepare("INSERT INTO notification_attempts(outbox_id,attempt_number,outcome,created_at) VALUES(?,1,'failed','2026-01-01')").run(job);
  db.prepare(`INSERT INTO notification_outbox(event_type,user_id,idempotency_key,schedule_at,data_json,created_at,updated_at)
    VALUES('legacy_review_due',?,'synthetic-preserve-other-review','2026-01-01',?,'2026-01-01','2026-01-01')`)
    .run(OTHER,JSON.stringify({contentId:item.id}));
  const source=path.join(temporary,'selected-original.txt');fs.writeFileSync(source,'Synthetic original',{mode:0o600});
  const usersBefore=db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.deepEqual(await request(item.id),{status:200,data:{deleted:true,id:item.id}});
  assert.equal(db.prepare('SELECT 1 FROM legacy_contents WHERE id=?').get(item.id),undefined);
  for(const table of ['legacy_content_beneficiaries','legacy_content_versions','legacy_content_reviews',
    'legacy_content_acknowledgements','legacy_content_attachments','legacy_content_links','legacy_release_events',
    'legacy_content_deletion_permissions'])assert.equal(count(table,item.id),0,table);
  assert.equal(db.prepare('SELECT 1 FROM audit_log WHERE detail=?').get(item.id),undefined);
  assert.equal(db.prepare('SELECT 1 FROM notification_outbox WHERE id=?').get(job),undefined);
  assert.equal(db.prepare('SELECT 1 FROM notification_attempts WHERE outbox_id=?').get(job),undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE user_id=?').get(OTHER).n,1);
  for(const d of [doc,detached]) {
    assert.equal(db.prepare('SELECT 1 FROM managed_documents WHERE id=?').get(d.id),undefined);
    assert.equal(fs.existsSync(d.filename),false);
  }
  assert.equal(fs.readFileSync(source,'utf8'),'Synthetic original');
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(),usersBefore);
  assert.ok(db.prepare('SELECT 1 FROM vault_entries WHERE id=?').get(entry));
  assert.ok(db.prepare('SELECT 1 FROM beneficiaries WHERE id=?').get(recipient));
  assert.ok(db.prepare('SELECT 1 FROM legacy_contents WHERE id=?').get(other.id));
  assert.equal((await request(item.id,{method:'GET'})).status,404);
});

test('old cached Archive DELETE requests and missing permanent-delete confirmations leave wishes intact',async()=>{
  for(const status of ['draft','archived']) {
    const item=create({status}),doc=document();attach(item,doc);
    const before=db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(item.id);
    const events=count('legacy_release_events',item.id);
    for(const body of [null,{}, {confirm_delete:false}, {confirm_delete:'true'}]) {
      const response=await request(item.id,{body});
      assert.equal(response.status,409);
      assert.match(response.data.error,/Refresh.*confirm permanent deletion/);
      assert.deepEqual(db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(item.id),before);
      assert.equal(count('legacy_release_events',item.id),events);
      assert.equal(count('legacy_content_attachments',item.id),1);
      assert.ok(fs.existsSync(doc.filename));
    }
  }
});

test('shared managed documents survive current wishes, another wish history and ordinary vault associations',()=>{
  const item=create(),other=create();
  const shared=document(),historical=document(),associated=document();
  for(const doc of [shared,historical,associated])attach(item,doc);
  attach(other,shared);history(other,historical);
  const entry=Number(db.prepare("INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,'contacts','Synthetic contact',?)")
    .run(OWNER,encrypt('{}')).lastInsertRowid);
  db.prepare('INSERT INTO document_associations(document_id,entry_id) VALUES(?,?)').run(associated.id,entry);
  legacy.permanentlyDelete(db,OWNER,item.id);
  for(const doc of [shared,historical,associated]) {
    assert.ok(db.prepare('SELECT 1 FROM managed_documents WHERE id=?').get(doc.id));
    assert.ok(fs.existsSync(doc.filename));
  }
  assert.equal(count('legacy_content_attachments',other.id),1);
  assert.equal(count('legacy_content_versions',other.id),1);
});

test('startup repair respects intentional deletion while a newly added beneficiary still gets a blank draft',()=>{
  const person=beneficiary();
  const wish=ensureBeneficiaryFinalWish(db,OWNER,person);
  legacy.permanentlyDelete(db,OWNER,wish.id);
  initLegacySchema(db);initLegacySchema(db);
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),{created:0,total:1});
  assert.deepEqual(ensureBeneficiaryFinalWish(db,OWNER,person),{id:null,created:false,suppressed:true});
  db.prepare('DELETE FROM beneficiaries WHERE id=?').run(person);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_beneficiary_wish_suppressions').get().n,0);
  const replacement=beneficiary();assert.notEqual(replacement,person);
  const next=ensureBeneficiaryFinalWish(db,OWNER,replacement);
  assert.equal(next.created,true);
  const view=legacy.toView(db,legacy.owned(db,OWNER,next.id));
  assert.equal(view.title,'Synthetic recipient');assert.equal(view.body_markdown,'');
  assert.deepEqual(view.beneficiary_ids,[replacement]);
});

test('failed deletion restores all managed bytes, content, events and recipients atomically',()=>{
  const person=beneficiary(),item=create({beneficiary_ids:[person]}),doc=document();attach(item,doc);
  const before=fs.readFileSync(doc.filename),events=count('legacy_release_events',item.id);
  db.exec(`CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON legacy_contents
    BEGIN SELECT RAISE(ABORT,'Synthetic delete unavailable'); END;`);
  assert.throws(()=>legacy.permanentlyDelete(db,OWNER,item.id),/Synthetic delete unavailable/);
  assert.deepEqual(fs.readFileSync(doc.filename),before);
  assert.equal(count('legacy_content_beneficiaries',item.id),1);
  assert.equal(count('legacy_release_events',item.id),events);
  assert.equal(count('legacy_content_deletion_permissions',item.id),0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_beneficiary_wish_suppressions').get().n,0);
  assert.ok(db.prepare('SELECT 1 FROM legacy_contents WHERE id=?').get(item.id));
});

test('foreign owner cannot delete or archive content and ordinary release history remains append-only',async()=>{
  const item=create(),doc=document();attach(item,doc);
  assert.equal((await request(item.id,{owner:OTHER})).status,404);
  assert.equal((await request(item.id,{owner:OTHER,method:'PATCH',body:{status:'archived'}})).status,404);
  assert.equal(legacy.owned(db,OWNER,item.id).status,'draft');assert.ok(fs.existsSync(doc.filename));
  assert.throws(()=>db.prepare('DELETE FROM legacy_release_events WHERE content_id=?').run(item.id),/append-only/);
  assert.throws(()=>db.prepare("UPDATE legacy_release_events SET event_type='tampered' WHERE content_id=?").run(item.id),/append-only/);
  db.prepare('INSERT INTO legacy_content_deletion_permissions VALUES(?,?)').run(item.id,OTHER);
  assert.throws(()=>db.prepare('DELETE FROM legacy_release_events WHERE content_id=?').run(item.id),/append-only/);
  db.prepare('DELETE FROM legacy_content_deletion_permissions WHERE content_id=?').run(item.id);
});

test('private attachment safety checks reject symlinks before any content or original bytes are removed',()=>{
  const item=create(),doc=document();attach(item,doc);
  const original=path.join(temporary,'protected-original.txt');fs.writeFileSync(original,'Source bytes',{mode:0o600});
  fs.unlinkSync(doc.filename);fs.symlinkSync(original,doc.filename);
  assert.throws(()=>legacy.permanentlyDelete(db,OWNER,item.id),/Unsafe managed attachment/);
  assert.equal(fs.readFileSync(original,'utf8'),'Source bytes');
  assert.ok(db.prepare('SELECT 1 FROM legacy_contents WHERE id=?').get(item.id));
  assert.equal(count('legacy_content_attachments',item.id),1);
});
