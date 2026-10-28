'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { initNotificationSchema } = require('../server/notifications/schema');
const { initLegacySchema } = require('../server/legacy-schema');
const { backup, verify, restore } = require('../scripts/managed-recovery');
const KEY = 'ef'.repeat(32);
function encrypted(text) {
  const iv = crypto.randomBytes(16), cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  const content = Buffer.concat([cipher.update(text), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), content.toString('hex')].join(':');
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-managed-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDir = path.join(directory, 'synthetic-app'), documentsDir = path.join(directory, 'synthetic-media');
  fs.mkdirSync(path.join(appDir, 'data'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(documentsDir, 'owner-1'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(appDir, 'data', '.secrets'), JSON.stringify({ encryption_key: KEY, jwt_secret: 'fixture-jwt' }), { mode: 0o600 });
  fs.writeFileSync(path.join(appDir, '.env'), 'ENCRYPTION_KEY=auto\nNOTIFICATIONS_ENABLED=true\nSMTP_PASS=fixture-private-password\n', { mode: 0o600 });
  const content = Buffer.from('Synthetic managed media; selected original is unchanged.'), relative = 'owner-1/fixture.mp3';
  fs.writeFileSync(path.join(documentsDir, relative), content, { mode: 0o600 });
  const db = new Database(path.join(appDir, 'data', 'vault.db'));
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,last_check_in TEXT);
    CREATE TABLE dead_switch_config(id INTEGER PRIMARY KEY,user_id INTEGER,switch_triggered INTEGER);
    CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,user_id INTEGER,fields_encrypted TEXT);
    CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER,access_token TEXT,access_granted INTEGER);
    CREATE TABLE managed_documents(id TEXT PRIMARY KEY,user_id INTEGER,stored_filename TEXT,sha256 TEXT,size_bytes INTEGER);
    INSERT INTO users VALUES(1,'2026-01-01T00:00:00.000Z');
    INSERT INTO dead_switch_config VALUES(1,1,1);
    INSERT INTO beneficiaries VALUES(1,1,'preserved-token-hash',1);`);
  db.prepare('INSERT INTO vault_entries VALUES(1,1,?)').run(encrypted('{"category":"other","details":"Preserved wishes"}'));
  db.prepare('INSERT INTO managed_documents VALUES(?,?,?,?,?)').run('media-id', 1, relative, crypto.createHash('sha256').update(content).digest('hex'), content.length);
  initNotificationSchema(db); initLegacySchema(db);
  db.prepare(`INSERT INTO legacy_contents(id,user_id,type,payload_encrypted,status,release_policy,created_at,updated_at)
    VALUES('letter-id',1,'letter',?,'released','manual_release','2026-01-01','2026-01-01')`).run(encrypted('{"title":"Private letter","body_markdown":"Private body"}'));
  db.prepare(`INSERT INTO legacy_content_versions(content_id,revision,payload_encrypted,editor_id,created_at)
    VALUES('letter-id',1,?,1,'2026-01-01')`).run(encrypted('{"title":"Previous version"}'));
  db.exec(`INSERT INTO legacy_content_beneficiaries VALUES('letter-id',1,'2026-01-01',NULL,'manual_release');
    INSERT INTO legacy_content_attachments VALUES('letter-id','media-id',0);
    INSERT INTO legacy_release_events VALUES(1,1,'letter-id',1,'released','fixture-release','2026-01-01');
    INSERT INTO notification_settings(user_id,recipient,verified_at,reply_enabled) VALUES(1,'fixture@example.test','2026-01-01',1);
    INSERT INTO notification_outbox(event_type,user_id,idempotency_key,schedule_at,created_at,updated_at)
      VALUES('legacy_review_due',1,'fixture-review','2026-01-01','2026-01-01','2026-01-01');`);
  db.close();
  return { directory, appDir, documentsDir, content, relative, snapshot: path.join(directory, 'snapshot') };
}

test('complete snapshot and disposable restore preserve ciphertext, revisions, mappings, releases, media and keys', t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.documentsDir, f.relative));
  const unit = path.join(f.directory, 'effective-unit.txt');
  fs.writeFileSync(unit, '[Service]\nUser=fixture\nEnvironment=PORT=4444\n', { mode: 0o600 });
  const result = backup({ ...f, destination: f.snapshot, serviceUnitPath: unit });
  assert.equal(result.result, 'snapshot_verified'); assert.equal(result.documents, 1); assert.equal(result.encryptedValues, 3);
  assert.deepEqual(verify(f.snapshot), result);
  assert.equal(fs.statSync(f.snapshot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.snapshot, 'data', '.secrets')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.snapshot, 'configuration', 'service-effective.txt'), 'utf8'), fs.readFileSync(unit, 'utf8'));
  const destination = path.join(f.directory, 'disposable-restored');
  const report = restore({ snapshotPath: f.snapshot, destination });
  assert.equal(report.result, 'restored_quarantined'); assert.equal(report.email.outbox, 1);
  assert.equal(report.documents, 1); assert.equal(report.encryptedValues, 3);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'managed-documents', f.relative)), original);
  assert.deepEqual(fs.readFileSync(path.join(f.documentsDir, f.relative)), original);
  const source = new Database(path.join(f.appDir, 'data', 'vault.db'), { readonly: true });
  const recovered = new Database(path.join(destination, 'data', 'vault.db'), { readonly: true });
  try {
    for (const table of ['users', 'dead_switch_config', 'beneficiaries', 'vault_entries', 'legacy_contents', 'legacy_content_versions', 'legacy_content_beneficiaries', 'legacy_content_attachments', 'legacy_release_events', 'managed_documents']) {
      assert.deepEqual(recovered.prepare(`SELECT * FROM ${table}`).all(), source.prepare(`SELECT * FROM ${table}`).all(), table);
    }
    assert.equal(recovered.prepare('SELECT status FROM notification_outbox').get().status, 'cancelled');
    assert.equal(recovered.prepare('SELECT verified_at FROM notification_settings').get().verified_at, null);
    assert.equal(source.prepare('SELECT status FROM notification_outbox').get().status, 'queued');
  } finally { source.close(); recovered.close(); }
  assert.match(fs.readFileSync(path.join(destination, '.env'), 'utf8'), /NOTIFICATIONS_ENABLED=false/);
  assert.match(fs.readFileSync(path.join(destination, '.env'), 'utf8'), /LISTEN_HOST=127.0.0.1/);
  assert.deepEqual(verify(f.snapshot), result, 'restoring must not mutate the original snapshot');
});

test('committed WAL rows are consolidated in the copy while source journal state remains untouched', t => {
  const f = fixture(t), filename = path.join(f.appDir, 'data', 'vault.db');
  const source = new Database(filename);
  try {
    source.pragma('journal_mode = WAL'); source.pragma('wal_autocheckpoint = 0');
    source.prepare("INSERT INTO legacy_content_versions(content_id,revision,payload_encrypted,editor_id,created_at) VALUES('letter-id',2,?,1,'2026-01-02')")
      .run(encrypted('{"title":"Committed WAL revision"}'));
    const before = fs.readFileSync(filename + '-wal');
    const result = backup({ ...f, destination: f.snapshot });
    assert.equal(result.encryptedValues, 4);
    assert.deepEqual(fs.readFileSync(filename + '-wal'), before);
    assert.equal(source.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(fs.existsSync(path.join(f.snapshot, 'data', 'vault.db-wal')), false);
    const copy = new Database(path.join(f.snapshot, 'data', 'vault.db'), { readonly: true });
    try { assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM legacy_content_versions').get().n, 2); }
    finally { copy.close(); }
    assert.deepEqual(verify(f.snapshot), result);
  } finally { source.close(); }
});

test('corrupt files, missing/wrong keys and malicious paths fail without altering originals', async t => {
  for (const variant of ['media', 'wrong-key', 'missing-key', 'traversal']) await t.test(variant, tt => {
    const f = fixture(tt);
    backup({ ...f, destination: f.snapshot });
    if (variant === 'media') fs.appendFileSync(path.join(f.snapshot, 'managed-documents', f.relative), 'corrupt');
    if (variant === 'wrong-key') fs.writeFileSync(path.join(f.snapshot, 'data', '.secrets'), JSON.stringify({ encryption_key: '01'.repeat(32) }));
    if (variant === 'missing-key') fs.unlinkSync(path.join(f.snapshot, 'data', '.secrets'));
    if (variant === 'traversal') {
      const filename = path.join(f.snapshot, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(filename));
      manifest.files[0].path = '../outside'; fs.writeFileSync(filename, JSON.stringify(manifest));
    }
    assert.throws(() => verify(f.snapshot));
    assert.deepEqual(fs.readFileSync(path.join(f.documentsDir, f.relative)), f.content);
    assert.throws(() => restore({ snapshotPath: f.snapshot, destination: path.join(f.directory, 'failed-restore') }));
    assert.equal(fs.existsSync(path.join(f.directory, 'failed-restore')), false);
  });
});

test('backup rejects symlinks, overlapping/existing destinations, and mismatched encryption', t => {
  const f = fixture(t);
  assert.throws(() => backup({ ...f, destination: f.appDir }));
  assert.throws(() => backup({ ...f, destination: path.join(f.documentsDir, 'bad-snapshot') }));
  fs.symlinkSync(path.join(f.documentsDir, f.relative), path.join(f.documentsDir, 'linked-original'));
  assert.throws(() => backup({ ...f, destination: f.snapshot }));
  assert.equal(fs.existsSync(f.snapshot), false);
  fs.unlinkSync(path.join(f.documentsDir, 'linked-original'));
  fs.writeFileSync(path.join(f.appDir, 'data', '.secrets'), JSON.stringify({ encryption_key: '01'.repeat(32) }));
  assert.throws(() => backup({ ...f, destination: f.snapshot }));
  assert.equal(fs.existsSync(path.join(f.snapshot, 'manifest.json')), false);
});

test('CLI requires stopped-service acknowledgement and does not expose secret values', t => {
  const f = fixture(t), script = path.resolve(__dirname, '../scripts/managed-recovery.js');
  const invalid = spawnSync(process.execPath, [script, 'backup', f.appDir, f.documentsDir, f.snapshot], { encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.equal(fs.existsSync(f.snapshot), false);
  const absent = spawnSync(process.execPath, [script, 'verify', path.join(f.directory, 'missing')], { encoding: 'utf8' });
  assert.equal(absent.status, 1); assert.ok(!absent.stderr.includes('fixture-private-password'));
});
