'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
process.env.ENCRYPTION_KEY = 'c7'.repeat(32);
const { encrypt } = require('../server/crypto');
const { maintenance } = require('../scripts/repair-beneficiary-auto-wishes');
const SCRIPT = path.resolve(__dirname, '../scripts/repair-beneficiary-auto-wishes.js');

function fixture(t, { encrypted = true, historical = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-auto-wish-cli-test-'));
  fs.chmodSync(root, 0o700);
  const databasePath = path.join(root, 'synthetic.db'), backupPath = path.join(root, 'before-repair.db');
  const db = new Database(databasePath); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,name TEXT,password_hash TEXT);
    CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),name TEXT,access_token TEXT,
      token_expires_at TEXT,access_granted INTEGER DEFAULT 0,access_granted_at TEXT,created_at TEXT);
    CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,user_id INTEGER,section TEXT,title TEXT,fields_encrypted TEXT,notes_encrypted TEXT);
    CREATE TABLE managed_documents(id TEXT PRIMARY KEY,user_id INTEGER,original_name_encrypted TEXT,display_name_encrypted TEXT,
      description_encrypted TEXT,stored_filename TEXT,mime_type TEXT,size_bytes INTEGER,sha256 TEXT,status TEXT,created_at TEXT);
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,detail TEXT,created_at TEXT);
    CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,status TEXT);
    INSERT INTO users VALUES(1,'synthetic-private-owner@example.test','Synthetic private owner','private-password-hash');
    INSERT INTO beneficiaries VALUES(11,1,'Synthetic private beneficiary','private-token-hash','2099-01-01T00:00:00Z',0,NULL,'2026-01-01');`);
  if (encrypted) db.prepare('INSERT INTO vault_entries VALUES(1,1,?,?,?,NULL)')
    .run('property', 'Synthetic private title', encrypt(JSON.stringify({ private: 'Synthetic secret property content' })));
  if (historical) {
    require('../server/legacy-schema').initLegacySchema(db);
    const payload = { title: 'An edited old automatic wish', body_markdown: 'Synthetic private authored instructions', introduction: '', description: '',
      metadata: { origin: { type: 'beneficiary', beneficiary_id: 11 }, final_wishes: { category: 'Other' } } };
    db.prepare(`INSERT INTO legacy_contents(id,user_id,type,payload_encrypted,status,release_policy,revision,created_at,updated_at)
      VALUES('synthetic-historical-wish',1,'instruction',?,'draft','owner_only',4,'2026-01-01','2026-02-01')`).run(encrypt(JSON.stringify(payload)));
    db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,11)').run('synthetic-historical-wish');
    db.prepare(`INSERT INTO legacy_content_versions(content_id,revision,payload_encrypted,editor_id,created_at)
      VALUES('synthetic-historical-wish',1,?,1,'2026-01-01')`).run(encrypt(JSON.stringify(payload)));
    db.prepare(`INSERT INTO managed_documents VALUES('synthetic-document',1,?,?,NULL,'private-preserved.bin','text/plain',99,?,'active','2026-01-01',1)`)
      .run(encrypt('Private original.txt'),encrypt('Private display.txt'),'a'.repeat(64));
    db.prepare(`INSERT INTO legacy_content_attachments(content_id,document_id) VALUES('synthetic-historical-wish','synthetic-document')`).run();
  }
  fs.chmodSync(databasePath, 0o600);
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, databasePath, backupPath };
}
function runCli(f, args = [], env = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--db', f.databasePath, ...args], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, NOTIFICATIONS_ENABLED: 'true', ...env }
  });
}

test('default dry run repairs only a private online backup and leaves original database bytes/schema/tokens untouched', async t => {
  const f = fixture(t), original = fs.readFileSync(f.databasePath), person = f.db.prepare('SELECT * FROM beneficiaries').get();
  const result = await maintenance({ databasePath: f.databasePath });
  assert.equal(result.mode, 'dry_run'); assert.equal(result.created, 1); assert.equal(result.total, 1);
  assert.equal(result.key_verified, true); assert.equal(result.key_anchor, 'ciphertext');
  assert.equal(result.automatic_wishes[0].beneficiary_id, 11);
  assert.deepEqual(fs.readFileSync(f.databasePath), original);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_contents'").get(), undefined);
  assert.deepEqual(f.db.prepare('SELECT * FROM beneficiaries').get(), person);
  assert.deepEqual(fs.readdirSync(f.root), ['synthetic.db']);
  assert.equal(require.cache[require.resolve('../server/db')], undefined);
  assert.equal(require.cache[require.resolve('../server/config')], undefined);
  assert.equal(require.cache[require.resolve('../server/index')], undefined);
});

test('explicit apply makes a verified private rollback backup before atomic migration and is repeatable', async t => {
  const f = fixture(t), before = f.db.prepare('SELECT * FROM beneficiaries').get();
  const result = await maintenance({ ...f, apply: true });
  assert.equal(result.mode, 'applied'); assert.equal(result.backup_verified, true); assert.equal(result.created, 1);
  assert.equal(fs.statSync(f.backupPath).mode & 0o777, 0o600);
  const backup = new Database(f.backupPath, { readonly: true });
  try {
    assert.equal(backup.pragma('integrity_check')[0].integrity_check, 'ok');
    assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_contents'").get(), undefined);
    assert.deepEqual(backup.prepare('SELECT * FROM beneficiaries').get(), before);
  } finally { backup.close(); }
  const contents = f.db.prepare('SELECT * FROM legacy_contents').all();
  const audit = f.db.prepare('SELECT * FROM audit_log').all();
  const repeat = await maintenance({ ...f, apply: true, backupPath: path.join(f.root, 'second-backup.db') });
  assert.equal(repeat.created, 0); assert.equal(repeat.adopted, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM legacy_contents').all(), contents);
  assert.deepEqual(f.db.prepare('SELECT * FROM audit_log').all(), audit);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
});

test('repair adopts existing encrypted edited wish without changing ciphertext, attachments, revisions or original history', async t => {
  const f = fixture(t, { historical: true });
  const tables = ['legacy_contents', 'legacy_content_versions', 'legacy_content_attachments', 'managed_documents', 'beneficiaries'];
  const before = Object.fromEntries(tables.map(table => [table, f.db.prepare('SELECT * FROM ' + table).all()]));
  const result = await maintenance({ ...f, apply: true });
  assert.equal(result.adopted, 1); assert.equal(result.created, 0);
  assert.equal(result.automatic_wishes[0].content_id, 'synthetic-historical-wish');
  for (const table of tables) assert.deepEqual(f.db.prepare('SELECT * FROM ' + table).all(), before[table], table);
});

test('absent encrypted anchors permit explicitly configured key while reporting that key matching could not be verified', async t => {
  const f = fixture(t, { encrypted: false });
  const result = await maintenance({ ...f, apply: true });
  assert.equal(result.created, 1); assert.equal(result.key_verified, false); assert.equal(result.key_anchor, 'none');
  assert.equal(result.encrypted_values_verified, 0);
});

test('missing, malformed or mismatching key refuses before source or backup changes and emits no private values', t => {
  const f = fixture(t), before = fs.readFileSync(f.databasePath);
  for (const key of ['', 'auto', 'de'.repeat(32)]) {
    const result = runCli(f, ['--apply', '--backup', f.backupPath], { ENCRYPTION_KEY: key });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('Synthetic')); assert.ok(!result.stderr.includes(f.databasePath));
    if (key.length === 64) assert.ok(!result.stderr.includes(key));
    assert.deepEqual(fs.readFileSync(f.databasePath), before); assert.equal(fs.existsSync(f.backupPath), false);
  }
});

test('one corrupted encrypted value aborts even when another anchor matches the key', async t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO vault_entries VALUES(2,1,?,?,?,NULL)').run('property', 'Private corrupt record', 'corrupt-secret-ciphertext');
  const before = fs.readFileSync(f.databasePath);
  await assert.rejects(maintenance({ ...f, apply: true }), { safeCode: 'encryption_key_or_ciphertext_invalid' });
  assert.deepEqual(fs.readFileSync(f.databasePath), before); assert.equal(fs.existsSync(f.backupPath), false);
});

test('failed repair rolls back schema and source writes while retaining the verified pre-change backup', async t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER fixture_repair_failure BEFORE INSERT ON audit_log WHEN NEW.action='legacy_auto_wish_linked'
    BEGIN SELECT RAISE(ABORT,'private-internal-failure-detail'); END;`);
  const result = runCli(f, ['--apply', '--backup', f.backupPath]);
  assert.equal(result.status, 1); assert.ok(result.stderr.includes('"backup_verified":true'));
  assert.ok(!result.stderr.includes('private-internal-failure-detail'));
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_contents'").get(), undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
  assert.ok(fs.existsSync(f.backupPath));
  const backup = new Database(f.backupPath, { readonly: true });
  try { assert.equal(backup.pragma('integrity_check')[0].integrity_check, 'ok'); }
  finally { backup.close(); }
});

test('CLI requires explicit absolute database and backup paths and refuses existing or symlink backup destinations', async t => {
  const f = fixture(t), target = path.join(f.root, 'target.db');
  await assert.rejects(maintenance(), { safeCode: 'explicit_absolute_path_required' });
  await assert.rejects(maintenance({ databasePath: 'relative.db' }), { safeCode: 'explicit_absolute_path_required' });
  await assert.rejects(maintenance({ databasePath: f.databasePath, apply: true }), { safeCode: 'explicit_absolute_path_required' });
  await assert.rejects(maintenance({ ...f, apply: true, backupPath: f.databasePath }), { safeCode: 'distinct_backup_path_required' });
  fs.writeFileSync(target, 'preserve-existing-file', { mode: 0o600 });
  await assert.rejects(maintenance({ ...f, apply: true, backupPath: target }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve-existing-file');
  fs.symlinkSync(target, f.backupPath);
  await assert.rejects(maintenance({ ...f, apply: true }));
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve-existing-file');
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_contents'").get(), undefined);
});

test('successful CLI output contains safe counts and IDs without plaintext contact, token, ciphertext or secrets', t => {
  const f = fixture(t), result = runCli(f);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout); assert.equal(report.created, 1); assert.equal(report.mode, 'dry_run');
  for (const secret of ['Synthetic', 'private-token-hash', 'private-password-hash', 'example.test', 'secret property', process.env.ENCRYPTION_KEY, f.databasePath]) {
    assert.ok(!result.stdout.includes(secret), secret);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'data')), false);
});
