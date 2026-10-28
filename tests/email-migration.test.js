'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('actual database upgrade preserves existing ciphertext, HomeBank snapshots, document mappings and token hashes', () => {
  // Run getDb() in a separate process so its singleton and constructor redirect
  // cannot affect another test. All baseline records are synthetic and in RAM.
  const source = String.raw`
    const assert=require('node:assert/strict');
    const hash=require('node:crypto').createHash;
    const Database=require('better-sqlite3');
    process.env.ENCRYPTION_KEY='ef'.repeat(32);
    process.env.HOMEBANK_OWNER_EMAIL='owner@example.test';
    const {encrypt,decrypt,hashToken}=require('./server/crypto');
    const db=new Database(':memory:');
    db.exec(
      "CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,password_hash TEXT,name TEXT,totp_secret TEXT,totp_enabled INTEGER,created_at TEXT,last_check_in TEXT);"+
      "CREATE TABLE dead_switch_config(id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE,check_in_interval_days INTEGER,grace_period_days INTEGER,is_active INTEGER,switch_triggered INTEGER,switch_triggered_at TEXT);"+
      "CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,email TEXT,phone TEXT,relationship TEXT,access_token TEXT UNIQUE,token_expires_at TEXT,emergency_access_requested INTEGER,emergency_access_requested_at TEXT,emergency_waiting_days INTEGER,access_granted INTEGER,access_granted_at TEXT,created_at TEXT);"+
      "CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,user_id INTEGER,section TEXT,title TEXT,fields_encrypted TEXT,notes_encrypted TEXT,homebank_account_id INTEGER,created_at TEXT,updated_at TEXT);"+
      "CREATE TABLE homebank_snapshots(user_id INTEGER PRIMARY KEY,config_encrypted TEXT,snapshot_encrypted TEXT,fingerprint TEXT,source_file TEXT,source_saved_at TEXT,synced_at TEXT,last_error TEXT,content_hash TEXT);"+
      "CREATE TABLE managed_documents(id TEXT PRIMARY KEY,user_id INTEGER,original_name_encrypted TEXT,display_name_encrypted TEXT,description_encrypted TEXT,stored_filename TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,status TEXT,created_at TEXT);"+
      "CREATE TABLE document_associations(document_id TEXT,entry_id INTEGER,created_at TEXT,PRIMARY KEY(document_id,entry_id));"+
      "CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,detail TEXT,ip_address TEXT,created_at TEXT);"
    );
    db.prepare('INSERT INTO users VALUES(1,?,?,?,?,?,?,?)').run('owner@example.test','preserved-password-hash','Synthetic owner','preserved-totp-secret',1,'2026-01-01 00:00:00','2026-10-01 08:00:00');
    db.exec("INSERT INTO dead_switch_config VALUES(1,1,30,7,1,0,NULL)");
    db.prepare('INSERT INTO beneficiaries VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?)').run('Synthetic beneficiary','beneficiary@example.test','synthetic-phone','Family',hashToken('synthetic-beneficiary-token'),'2099-01-01T00:00:00.000Z',1,'2026-10-01 08:00:00',7,1,'2026-10-09 08:00:00','2026-01-01 00:00:00');
    const fields=encrypt(JSON.stringify({owner_reference:'independently managed reference'}));
    const notes=encrypt('Independent vault notes');
    db.prepare('INSERT INTO vault_entries VALUES(1,1,?,?,?,?,?,?,?)').run('bank_accounts','Synthetic linked account',fields,null,42,'2026-01-01 00:00:00','2026-10-01 08:00:00');
    db.prepare('INSERT INTO vault_entries VALUES(2,1,?,?,?,?,?,?,?)').run('other','Synthetic independent entry',encrypt(JSON.stringify({reference:'retained'})),notes,null,'2026-01-01 00:00:00','2026-10-01 08:00:00');
    db.prepare('INSERT INTO homebank_snapshots VALUES(1,?,?,?,?,?,?,?,?)').run(encrypt(JSON.stringify({auto:false,directory:'/synthetic/homebank'})),encrypt(JSON.stringify({accounts:[{id:42,name:'Synthetic account',closed:false,excluded_from_summary:false}]})),'fingerprint','synthetic.xhb','2026-10-01','2026-10-01',null,'preserved-content-hash');
    db.prepare('INSERT INTO managed_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-document',1,encrypt('synthetic.pdf'),encrypt('Synthetic document'),encrypt('Retained description'),'owner-1/synthetic.pdf','application/pdf',24,'ab'.repeat(32),'active','2026-10-01');
    db.exec("INSERT INTO document_associations VALUES('synthetic-document',1,'2026-10-01');INSERT INTO audit_log VALUES(1,1,'existing_action','vault',1,'Synthetic audit detail','127.0.0.1','2026-10-01')");
    const tables=['users','dead_switch_config','beneficiaries','vault_entries','homebank_snapshots','managed_documents','document_associations','audit_log'];
    const baseline=Object.fromEntries(tables.map(table=>[table,{columns:db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name),rows:db.prepare('SELECT * FROM '+table).all()}]));
    const fingerprint=value=>hash('sha256').update(JSON.stringify(value)).digest('hex');
    const before=fingerprint(Object.fromEntries(tables.map(table=>[table,baseline[table].rows])));
    const module=require.cache[require.resolve('better-sqlite3')],original=module.exports;
    module.exports=function ConstructorRedirect(filename){assert.equal(filename,require('node:path').resolve('data/vault.db'));return db;};
    try{assert.equal(require('./server/db').getDb(),db);}finally{module.exports=original;}
    const after=fingerprint(Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT '+baseline[table].columns.join(',')+' FROM '+table).all()])));
    assert.equal(after,before,'all original column values must remain byte-for-byte identical');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM checkin_recovery_codes').get().n,0);
    assert.ok(db.prepare('PRAGMA table_info(dead_switch_config)').all().some(c=>c.name==='notification_cycle_id'));
    assert.equal(db.prepare('SELECT access_token FROM beneficiaries').get().access_token,hashToken('synthetic-beneficiary-token'));
    assert.equal(decrypt(db.prepare('SELECT notes_encrypted FROM vault_entries WHERE id=2').get().notes_encrypted),'Independent vault notes');
    assert.equal(db.prepare('SELECT fields_encrypted FROM vault_entries WHERE id=1').get().fields_encrypted,fields);
    require('./server/notifications/schema').initNotificationSchema(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM document_associations').get().n,1);
    db.close();
  `;
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ENCRYPTION_KEY: 'ef'.repeat(32), JWT_SECRET: 'synthetic-migration-secret' }
  });
  assert.equal(result.status,0, result.stderr || result.stdout);
});
