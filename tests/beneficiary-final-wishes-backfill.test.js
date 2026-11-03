'use strict';

// All repairs use synthetic in-memory/disposable databases, never the vault.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const Database = require('better-sqlite3');
process.env.ENCRYPTION_KEY = 'b4'.repeat(32);
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';
process.env.NOTIFICATIONS_ENABLED = 'false';
const { encrypt, decrypt, hashToken } = require('../server/crypto');
const legacy = require('../server/legacy-content');
const autoWish = require('../server/beneficiary-auto-wish');
const { ensureBeneficiaryFinalWish, backfillBeneficiaryFinalWishes } = require('../server/beneficiary-final-wishes');
const OWNER = 831, OTHER = 832;
const TABLES = ['users', 'beneficiaries', 'vault_entries', 'managed_documents', 'legacy_contents',
  'legacy_beneficiary_auto_wishes', 'legacy_beneficiary_auto_wish_retirements', 'legacy_beneficiary_wish_suppressions',
  'legacy_content_beneficiaries', 'legacy_content_attachments', 'legacy_content_versions', 'legacy_content_reviews',
  'legacy_content_acknowledgements', 'legacy_content_links', 'legacy_release_events', 'audit_log', 'notification_outbox'];
let db;
function beneficiary(name, userId = OWNER) {
  return Number(db.prepare(`INSERT INTO beneficiaries(user_id,name,access_token,token_expires_at)
    VALUES(?,?,?,'2099-01-01T00:00:00.000Z')`).run(userId,name,hashToken(`synthetic-${userId}-${name}`)).lastInsertRowid);
}
function rows(table) { return db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(); }
function snapshot() { return Object.fromEntries(TABLES.map(table => [table,rows(table)])); }
function summary(created,total,changes={}) { return {created,total,adopted:0,suppressed:0,reconciliation:[],...changes}; }
function oldGeneratedDraft(id, overrides = {}) {
  const person=db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(id);
  const wish=legacy.save(db,person.user_id,{
    type:'instruction',title:`Final Wishes for ${person.name.trim()}`,body_markdown:'',
    status:'draft',release_policy:'owner_only',beneficiary_ids:[id],
    metadata:{final_wishes:{category:'',details:'',contact_person:'',contact_phone:'',notes:''}},...overrides
  });
  // Simulate pre-migration JSON. Ordinary API saves cannot create this marker.
  const row=legacy.owned(db,person.user_id,wish.id), payload=legacy.payload(row);
  payload.metadata.origin={type:'beneficiary',beneficiary_id:id};
  db.prepare('UPDATE legacy_contents SET payload_encrypted=? WHERE id=?').run(encrypt(JSON.stringify(payload)),wish.id);
  return legacy.toView(db,legacy.owned(db,person.user_id,wish.id));
}

before(() => {
  db=new Database(':memory:');
  const module=require.cache[require.resolve('better-sqlite3')], original=module.exports;
  module.exports=function FixtureDatabase(filename) {
    assert.equal(filename,path.resolve(__dirname,'../data/vault.db'));return db;
  };
  try {assert.equal(require('../server/db').getDb(),db);} finally {module.exports=original;}
  const insert=db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)');
  insert.run(OWNER,'synthetic-backfill-owner@example.test','Synthetic owner','synthetic-hash');
  insert.run(OTHER,'synthetic-backfill-other@example.test','Synthetic other','synthetic-hash');
});
beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fixture_backfill_failure;
    DELETE FROM legacy_contents;DELETE FROM managed_documents;DELETE FROM beneficiaries;
    DELETE FROM vault_entries;DELETE FROM audit_log;DELETE FROM notification_outbox;`);
});
after(() => {if(db?.open)db.close();});

test('repair creates exactly one encrypted dedicated identity and mapping per beneficiary without granting vault access or notifying', () => {
  const ids=[beneficiary('  Synthetic first  '),beneficiary('Synthetic second'),beneficiary('Synthetic other',OTHER)];
  const before=rows('beneficiaries');
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(3,3));
  assert.deepEqual(rows('beneficiaries'),before);
  assert.equal(rows('legacy_beneficiary_auto_wishes').length,3);
  assert.equal(rows('legacy_content_beneficiaries').length,3);
  assert.equal(rows('vault_entries').length,0);
  assert.equal(rows('notification_outbox').length,0);
  for(const id of ids) {
    const person=before.find(row=>row.id===id), marker=autoWish.forBeneficiary(db,id);
    const raw=db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(marker.content_id);
    assert.equal(autoWish.validBinding(db,marker),true);
    assert.deepEqual(autoWish.publicIdentity(marker),{beneficiary_id:id,beneficiary_name:person.name});
    assert.equal(raw.user_id,person.user_id);assert.equal(raw.status,'draft');assert.equal(raw.release_policy,'owner_only');
    assert.equal(raw.revision,1);assert.equal(raw.review_enabled,0);assert.equal(raw.final_wishes_entry_id,null);
    assert.ok(!raw.payload_encrypted.includes(person.name.trim()));
    const payload=JSON.parse(decrypt(raw.payload_encrypted));
    assert.equal(payload.title,person.name.trim());assert.equal(payload.body_markdown,'');
    assert.deepEqual(payload.metadata.origin,{type:'beneficiary',beneficiary_id:id});
    assert.equal(payload.metadata.final_wishes.category,'Beneficiary Instructions');
  }
});

test('rerunning backfill and new-beneficiary helper preserves ciphertext, revisions, tokens, histories and events', () => {
  const id=beneficiary('Synthetic existing');
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(1,1));
  const before=snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,1));
  assert.deepEqual(ensureBeneficiaryFinalWish(db,OWNER,id),{id:before.legacy_contents[0].id,created:false});
  assert.deepEqual(snapshot(),before);
  const next=beneficiary('Synthetic new');
  assert.equal(ensureBeneficiaryFinalWish(db,OWNER,next).created,true);
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,2));
});

test('manual assigned drafts, archived items and released wishes do not satisfy the dedicated requirement', () => {
  const ids=['draft','archived','released'].map(label=>beneficiary('Synthetic manual '+label));
  const originals=ids.map((id,index)=>legacy.save(db,OWNER,{type:'letter',title:'Synthetic manual '+index,
    body_markdown:'Preserve manual content',beneficiary_ids:[id],status:index===1?'archived':index===2?'ready':'draft',
    release_policy:index===2?'manual_release':'owner_only'}));
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(ids[2]);
  legacy.manualRelease(db,OWNER,originals[2].id,{confirm:true,beneficiary_ids:[ids[2]]});
  const before=rows('legacy_contents');
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(3,3));
  assert.equal(rows('legacy_contents').length,6);
  for(const row of before)assert.deepEqual(db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(row.id),row);
  ids.forEach((id,index)=>assert.notEqual(autoWish.forBeneficiary(db,id).content_id,originals[index].id));
});

test('adoption preserves owner edits, ciphertext, IDs, attachments, links, revision and review/release history', () => {
  const id=beneficiary('Synthetic historical'), wish=oldGeneratedDraft(id);
  legacy.save(db,OWNER,{title:'An owner-authored title',body_markdown:'Precious edited instructions'},wish.id);
  legacy.review(db,OWNER,wish.id,{action:'reschedule',next_review_at:'2099-05-06'});
  db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,stored_filename,mime_type,size_bytes,sha256)
    VALUES('synthetic-attachment',?,?,?,?,?,?,?)`).run(OWNER,encrypt('Synthetic.txt'),encrypt('Synthetic.txt'),'synthetic.bin','text/plain',1,'a'.repeat(64));
  db.prepare('INSERT INTO legacy_content_attachments(content_id,document_id) VALUES(?,?)').run(wish.id,'synthetic-attachment');
  const entry=Number(db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,?,?,?)')
    .run(OWNER,'property','Synthetic linked record',encrypt('{}')).lastInsertRowid);
  db.prepare('INSERT INTO legacy_content_links(content_id,entry_id) VALUES(?,?)').run(wish.id,entry);
  db.prepare('INSERT INTO legacy_content_acknowledgements VALUES(?,?,?,?,?)').run(wish.id,id,'synthetic-step',1,'2026-01-01T00:00:00Z');
  const before=snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,1,{adopted:1}));
  for(const table of ['beneficiaries','legacy_contents','legacy_content_beneficiaries','legacy_content_attachments',
    'legacy_content_links','legacy_content_versions','legacy_content_reviews','legacy_content_acknowledgements'])assert.deepEqual(rows(table),before[table],table);
  assert.equal(autoWish.forBeneficiary(db,id).content_id,wish.id);
  const repaired=snapshot();assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,1));assert.deepEqual(snapshot(),repaired);
});

test('adoption follows immutable beneficiary ID after a name change without renaming authored content', () => {
  const id=beneficiary('Synthetic old name'), wish=oldGeneratedDraft(id);
  db.prepare('UPDATE beneficiaries SET name=? WHERE id=?').run('Synthetic new name',id);
  const raw=legacy.owned(db,OWNER,wish.id);
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,1,{adopted:1}));
  assert.equal(autoWish.forContent(db,wish.id).beneficiary_name,'Synthetic new name');
  assert.deepEqual(legacy.owned(db,OWNER,wish.id),raw);
});

test('adopting revoked historical mapping records explicit automatic-access revocation without clearing history', () => {
  const id=beneficiary('Synthetic revoked'), wish=oldGeneratedDraft(id), at='2026-10-01T10:00:00Z';
  db.prepare('UPDATE legacy_content_beneficiaries SET revoked_at=? WHERE content_id=?').run(at,wish.id);
  const old=legacy.owned(db,OWNER,wish.id);
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,1,{adopted:1}));
  assert.equal(autoWish.forBeneficiary(db,id).auto_wish_access_revoked_at,at);
  assert.deepEqual(legacy.owned(db,OWNER,wish.id),old);
  assert.equal(db.prepare('SELECT revoked_at FROM legacy_content_beneficiaries WHERE content_id=?').get(wish.id).revoked_at,at);
});

test('historical intentional owner revoke blocks replacement wish even where there was no original automatic item', () => {
  const id=beneficiary('Synthetic historically revoked'),at='2026-10-01T10:00:00Z';
  db.prepare(`INSERT INTO audit_log(user_id,action,target_type,target_id,created_at) VALUES(?,'revoke_access','beneficiary',?,?)`).run(OWNER,id,at);
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(1,1));
  assert.equal(autoWish.forBeneficiary(db,id).auto_wish_access_revoked_at,at);
});

test('duplicate historical candidates are preserved and reported while a new empty dedicated item is created once', () => {
  const id=beneficiary('Synthetic ambiguous'),first=oldGeneratedDraft(id,{body_markdown:'First precious message'}),second=oldGeneratedDraft(id,{body_markdown:'Second precious message'});
  const originals=rows('legacy_contents');const result=backfillBeneficiaryFinalWishes(db);
  assert.equal(result.created,1);assert.equal(result.adopted,0);assert.equal(result.reconciliation.length,1);
  assert.deepEqual(result.reconciliation[0].reconciliation.map(x=>x.content_id).sort(),[first.id,second.id].sort());
  for(const row of originals)assert.deepEqual(legacy.owned(db,OWNER,row.id),row);
  const dedicated=autoWish.forBeneficiary(db,id);assert.notEqual(dedicated.content_id,first.id);assert.notEqual(dedicated.content_id,second.id);
  assert.equal(legacy.payload(legacy.owned(db,OWNER,dedicated.content_id)).body_markdown,'');
  assert.equal(rows('audit_log').filter(row=>row.action==='legacy_auto_wish_reconciliation').length,1);
  const before=snapshot();assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,1));assert.deepEqual(snapshot(),before);
});

test('historical shared recipient mapping is never made private-token-readable by adoption', () => {
  const first=beneficiary('Synthetic first'),second=beneficiary('Synthetic second');const wish=oldGeneratedDraft(first,{body_markdown:'Shared historical content'});
  db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,?)').run(wish.id,second);
  const original=legacy.owned(db,OWNER,wish.id),result=backfillBeneficiaryFinalWishes(db);
  assert.equal(result.created,2);assert.equal(result.reconciliation.length,2);
  assert.notEqual(autoWish.forBeneficiary(db,first).content_id,wish.id);assert.notEqual(autoWish.forBeneficiary(db,second).content_id,wish.id);
  assert.deepEqual(legacy.owned(db,OWNER,wish.id),original);
});

test('historical named-contact recipients prevent adoption without losing any payload or chosen recipients', () => {
  const id=beneficiary('Synthetic historical contacts'),wish=oldGeneratedDraft(id);
  const row=legacy.owned(db,OWNER,wish.id),data=legacy.payload(row);
  data.metadata.final_wishes.contact_recipients=[{entry_id:999,name:'Synthetic historical contact'}];
  db.prepare('UPDATE legacy_contents SET payload_encrypted=? WHERE id=?').run(encrypt(JSON.stringify(data)),wish.id);
  const original=legacy.owned(db,OWNER,wish.id),result=backfillBeneficiaryFinalWishes(db);
  assert.equal(result.created,1);assert.equal(result.reconciliation.length,1);
  assert.deepEqual(legacy.owned(db,OWNER,wish.id),original);assert.notEqual(autoWish.forBeneficiary(db,id).content_id,wish.id);
});

test('deletion suppression is an explicit administrative disablement and never resurrects old content', () => {
  const id=beneficiary('Synthetic suppressed');
  db.prepare('INSERT INTO legacy_beneficiary_wish_suppressions VALUES(?,?,?)').run(OWNER,id,'2026-01-01T00:00:00Z');
  const before=snapshot();assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,1,{suppressed:1}));
  assert.deepEqual(ensureBeneficiaryFinalWish(db,OWNER,id),{id:null,created:false,suppressed:true});assert.deepEqual(snapshot(),before);
});

test('same-name beneficiaries and cross-owner historical assignments cannot satisfy another identity', () => {
  const first=beneficiary('Synthetic same'),second=beneficiary('Synthetic same',OTHER),foreign=oldGeneratedDraft(second);
  db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,?)').run(foreign.id,first);
  const before=snapshot();assert.throws(()=>ensureBeneficiaryFinalWish(db,OTHER,first),{status:404});assert.deepEqual(snapshot(),before);
  assert.equal(backfillBeneficiaryFinalWishes(db).created,2);
  const a=autoWish.forBeneficiary(db,first),b=autoWish.forBeneficiary(db,second);
  assert.equal(a.owner_user_id,OWNER);assert.equal(b.owner_user_id,OTHER);assert.notEqual(a.content_id,b.content_id);
});

test('database enforces exclusive immutable automatic ownership and rejects mismatching identity insertion', () => {
  const first=beneficiary('Synthetic first'),second=beneficiary('Synthetic second'),foreign=beneficiary('Synthetic foreign',OTHER);
  const wish=ensureBeneficiaryFinalWish(db,OWNER,first),before=snapshot();
  assert.throws(()=>db.prepare('UPDATE legacy_beneficiary_auto_wishes SET beneficiary_id=? WHERE content_id=?').run(second,wish.id),/cannot be changed/);
  assert.throws(()=>db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,?)').run(wish.id,second),/cannot be changed/);
  assert.throws(()=>db.prepare('UPDATE legacy_contents SET user_id=? WHERE id=?').run(OTHER,wish.id),/cannot be changed/);
  assert.throws(()=>db.prepare('UPDATE beneficiaries SET user_id=? WHERE id=?').run(OTHER,first),/cannot be changed/);
  const manual=legacy.save(db,OWNER,{type:'letter',title:'Synthetic manual',beneficiary_ids:[second]});
  assert.throws(()=>db.prepare('INSERT INTO legacy_beneficiary_auto_wishes VALUES(?,?,?,?)').run(foreign,manual.id,OWNER,new Date().toISOString()),/ownership or recipient mismatch/);
  assert.deepEqual(rows('legacy_beneficiary_auto_wishes'),before.legacy_beneficiary_auto_wishes);
});

test('deleting beneficiary archives and retires the automatic identity while preserving authored ciphertext and history', () => {
  const id=beneficiary('Synthetic retiring'),wish=ensureBeneficiaryFinalWish(db,OWNER,id);
  legacy.save(db,OWNER,{body_markdown:'Retain this authored automatic content'},wish.id);
  const before=legacy.owned(db,OWNER,wish.id),versions=rows('legacy_content_versions'),events=rows('legacy_release_events');
  db.prepare('DELETE FROM beneficiaries WHERE id=? AND user_id=?').run(id,OWNER);
  assert.equal(autoWish.forBeneficiary(db,id),undefined);
  assert.equal(rows('legacy_beneficiary_auto_wishes').length,0);
  assert.equal(rows('legacy_content_beneficiaries').length,0);
  const retired=autoWish.forContent(db,wish.id),saved=legacy.owned(db,OWNER,wish.id);
  assert.equal(retired.beneficiary_id,id);assert.equal(retired.owner_user_id,OWNER);
  assert.equal(retired.beneficiary_name,'Deleted beneficiary');assert.ok(retired.retired_at);
  assert.equal(autoWish.validBinding(db,retired),false);assert.equal(saved.status,'archived');
  assert.equal(saved.payload_encrypted,before.payload_encrypted);assert.equal(saved.revision,before.revision);
  assert.deepEqual(rows('legacy_content_versions'),versions);assert.deepEqual(rows('legacy_release_events'),events);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const after=snapshot();assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(0,0));assert.deepEqual(snapshot(),after);
});

test('retired automatic content keeps its original owner and cannot be attached as another automatic identity', () => {
  const id=beneficiary('Synthetic retired'),wish=ensureBeneficiaryFinalWish(db,OWNER,id);
  db.prepare('DELETE FROM beneficiaries WHERE id=?').run(id);
  const retired=autoWish.forContent(db,wish.id),replacement=beneficiary('Synthetic replacement');
  assert.throws(()=>db.prepare('UPDATE legacy_beneficiary_auto_wish_retirements SET beneficiary_id=? WHERE content_id=?')
    .run(replacement,wish.id),/cannot be changed/);
  assert.throws(()=>db.prepare('UPDATE legacy_contents SET user_id=? WHERE id=?').run(OTHER,wish.id),/cannot be changed/);
  db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,?)').run(wish.id,replacement);
  assert.throws(()=>db.prepare('INSERT INTO legacy_beneficiary_auto_wishes VALUES(?,?,?,?)')
    .run(replacement,wish.id,OWNER,new Date().toISOString()),/ownership or recipient mismatch/);
  const repaired=backfillBeneficiaryFinalWishes(db);
  assert.deepEqual(repaired,summary(1,1));
  assert.notEqual(autoWish.forBeneficiary(db,replacement).content_id,wish.id);
  assert.deepEqual(autoWish.forContent(db,wish.id),retired);
});

for(const failure of ['mapping','identity','audit','adoption'])test(`backfill ${failure} failure rolls back all content, identity, mapping and audit writes, then retries once`,()=>{
  const first=beneficiary('Synthetic first'),second=beneficiary('Synthetic second');beneficiary('Synthetic third',OTHER);
  if(failure==='adoption')oldGeneratedDraft(first);
  const before=snapshot();
  const trigger=failure==='mapping'?`BEFORE INSERT ON legacy_content_beneficiaries WHEN NEW.beneficiary_id=${second}`:
    failure==='identity'?`BEFORE INSERT ON legacy_beneficiary_auto_wishes WHEN NEW.beneficiary_id=${second}`:
    failure==='adoption'?`BEFORE INSERT ON audit_log WHEN NEW.action='legacy_auto_wish_adopted'`:
    `BEFORE INSERT ON audit_log WHEN NEW.action='legacy_auto_wish_linked' AND (SELECT COUNT(*) FROM legacy_beneficiary_auto_wishes)=2`;
  db.exec(`CREATE TRIGGER fixture_backfill_failure ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic ${failure} failure');END;`);
  assert.throws(()=>backfillBeneficiaryFinalWishes(db),new RegExp('synthetic '+failure+' failure'));assert.deepEqual(snapshot(),before);
  db.exec('DROP TRIGGER fixture_backfill_failure');
  assert.deepEqual(backfillBeneficiaryFinalWishes(db),summary(failure==='adoption'?2:3,3,{adopted:failure==='adoption'?1:0}));
});

test('migration failure rolls back new schema and revocation column without changing old token data, then retries idempotently', () => {
  const fixture=new Database(':memory:');fixture.pragma('foreign_keys=ON');
  try {
    fixture.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY);
      CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,access_token TEXT);
      CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,user_id INTEGER);
      CREATE TABLE managed_documents(id TEXT PRIMARY KEY,user_id INTEGER);
      CREATE TABLE legacy_schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO users VALUES(1);
      INSERT INTO beneficiaries VALUES(1,1,'Synthetic unchanged','synthetic-token-hash');
      INSERT INTO legacy_schema_migrations VALUES(1,'2026-01-01'),(2,'2026-01-01');
      CREATE TRIGGER fixture_migration_failure BEFORE INSERT ON legacy_schema_migrations WHEN NEW.version=3
        BEGIN SELECT RAISE(ABORT,'synthetic migration failure');END;`);
    const old=fixture.prepare('SELECT * FROM beneficiaries').all();
    const {initLegacySchema}=require('../server/legacy-schema');
    assert.throws(()=>initLegacySchema(fixture),/synthetic migration failure/);
    assert.deepEqual(fixture.prepare('SELECT * FROM beneficiaries').all(),old);
    assert.equal(fixture.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_beneficiary_auto_wishes'").get(),undefined);
    assert.deepEqual(fixture.prepare('SELECT version FROM legacy_schema_migrations ORDER BY version').all().map(row=>row.version),[1,2]);
    fixture.exec('DROP TRIGGER fixture_migration_failure');initLegacySchema(fixture);initLegacySchema(fixture);
    assert.deepEqual(fixture.prepare('SELECT id,user_id,name,access_token FROM beneficiaries').all(),old);
    assert.equal(fixture.prepare('SELECT auto_wish_access_revoked_at FROM beneficiaries').get().auto_wish_access_revoked_at,null);
    assert.deepEqual(fixture.pragma('foreign_key_check'),[]);
  } finally {fixture.close();}
});

test('concurrent independent SQLite repair connections serialize before checking for missing assignments', async () => {
  for (let index = 0; index < 6; index++) beneficiary('Synthetic concurrent ' + index);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-beneficiary-backfill-'));
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, 'synthetic.db');
  const workers = [];
  try {
    await db.backup(databasePath);
    fs.chmodSync(databasePath, 0o600);
    const source = `const {parentPort,workerData}=require('node:worker_threads');
      const Database=require(workerData.databaseModule);
      const repair=require(workerData.helperModule).backfillBeneficiaryFinalWishes;
      const db=new Database(workerData.databasePath,{timeout:10000});
      db.pragma('foreign_keys=ON');
      parentPort.postMessage('ready');
      parentPort.once('message',()=>{
        try{parentPort.postMessage({result:repair(db)});}catch(error){parentPort.postMessage({error:error.message});}
        finally{db.close();parentPort.close();}
      });`;
    for (let index = 0; index < 2; index++) {
      const worker = new Worker(source, { eval: true, workerData: {
        databaseModule: require.resolve('better-sqlite3'), helperModule: require.resolve('../server/beneficiary-final-wishes'), databasePath
      } });
      workers.push(worker);
    }
    const ready = await Promise.all(workers.map(worker => once(worker, 'message')));
    assert.deepEqual(ready, [['ready'], ['ready']]);
    const results = workers.map(worker => once(worker, 'message'));
    workers.forEach(worker => worker.postMessage('start'));
    const outcomes = (await Promise.all(results)).map(([message]) => {
      assert.equal(message.error, undefined);
      return message.result;
    });
    assert.deepEqual(outcomes.map(result => result.created).sort(), [0, 6]);
    assert.ok(outcomes.every(result => result.total === 6));
    const repaired = new Database(databasePath, { readonly: true });
    try {
      assert.equal(repaired.prepare('SELECT COUNT(*) AS n FROM legacy_contents').get().n, 6);
      assert.deepEqual(repaired.prepare('SELECT COUNT(*) AS n FROM legacy_content_beneficiaries GROUP BY beneficiary_id').all().map(row => row.n), [1, 1, 1, 1, 1, 1]);
      assert.equal(repaired.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
    } finally { repaired.close(); }
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
