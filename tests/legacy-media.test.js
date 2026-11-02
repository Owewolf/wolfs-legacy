'use strict';

const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-legacy-media-'));
const storage = path.join(temporary, 'managed'); fs.mkdirSync(storage, { mode: 0o700 });
process.env.DOCUMENT_STORAGE_ROOT = storage;
process.env.DOCUMENT_MAX_FILE_MB = '1';
process.env.LEGACY_STORAGE_QUOTA_MB = '1';
process.env.ENCRYPTION_KEY = '73'.repeat(32);
process.env.JWT_SECRET = 'synthetic-legacy-media-secret';
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank@example.test';
process.env.NOTIFICATIONS_ENABLED = 'false';
const OWNER = 951, OTHER = 952;
const store = require('../server/document-store');
const { encrypt } = require('../server/crypto');
let db, server, base, item;

function wav(dataBytes = 16) {
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}
function box(type, bytes) { const header = Buffer.alloc(8); header.writeUInt32BE(8 + bytes.length); header.write(type, 4); return Buffer.concat([header, bytes]); }
function container(brand = 'isom', withMoov = true) {
  return Buffer.concat([box('ftyp', Buffer.concat([Buffer.from(brand), Buffer.alloc(4), Buffer.from(brand)])),
    ...(withMoov ? [box('moov', box('trak', box('mdia', Buffer.alloc(0))))] : []), box('mdat', Buffer.from([1, 2, 3, 4]))]);
}
function mp3() {
  // Two complete MPEG1 Layer III 128kb/s 44.1kHz frames, sufficient to verify
  // container boundaries without claiming this synthetic payload is a codec test.
  const frame = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame);
  return Buffer.concat([frame, frame]);
}
function writeSource(name, bytes) { const filename = path.join(temporary, name); fs.writeFileSync(filename, bytes); return filename; }
function authorized(owner = OWNER) { return { Authorization: 'Bearer ' + jwt.sign({ id: owner }, process.env.JWT_SECRET) }; }
async function json(route, { method = 'GET', body, owner = OWNER } = {}) {
  const response = await fetch(base + route, { method, headers: { ...authorized(owner), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function upload(files, owner = OWNER, id = item.id) {
  const body = new FormData();
  for (const file of files) body.append('files', new Blob([file.bytes], { type: file.mime || 'application/octet-stream' }), file.name);
  const response = await fetch(`${base}/api/final-wishes/legacy/${id}/attachments`, { method: 'POST', headers: authorized(owner), body });
  return { status: response.status, data: await response.json() };
}
function managedCount() { return db.prepare('SELECT COUNT(*) n FROM managed_documents').get().n; }
function incoming() { return fs.existsSync(path.join(storage, '.incoming')) ? fs.readdirSync(path.join(storage, '.incoming')) : []; }

before(async () => {
  db = new Database(':memory:');
  const module = require.cache[require.resolve('better-sqlite3')], original = module.exports;
  module.exports = function FixtureDatabase(filename) { assert.equal(filename, path.resolve(__dirname, '../data/vault.db')); return db; };
  try { require('../server/db').getDb(); } finally { module.exports = original; }
  for (const id of [OWNER, OTHER]) db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run(id, `media-${id}@example.test`, 'Synthetic media owner', 'synthetic-hash');
  const app = express(); app.use(express.json()); app.use('/api/final-wishes', require('../server/routes/legacy').ownerRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: 'Synthetic upload failed' }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  db.exec('DELETE FROM legacy_contents; DELETE FROM managed_documents;');
  const result = await json('/api/final-wishes/legacy', { method: 'POST', body: { type: 'recording', title: 'Synthetic recording' } });
  assert.equal(result.status, 201); item = result.data;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); if (db?.open) db.close(); fs.rmSync(temporary, { recursive: true, force: true }); });

test('server verifies WAV, MP3, M4A, MP4 and MOV structures rather than browser MIME', () => {
  const fixtures = [
    ['voice.wav', wav(), 'audio/wav'], ['voice.mp3', mp3(), 'audio/mpeg'],
    ['voice.m4a', container('M4A '), 'audio/mp4'], ['video.mp4', container(), 'video/mp4'],
    ['video.mov', container('qt  '), 'video/quicktime']
  ];
  for (const [name, bytes, mime] of fixtures) assert.equal(store.inspectFile(name, writeSource(name, bytes)).mime, mime);
  for (const name of ['wrong.wav', 'wrong.mp3', 'wrong.m4a', 'wrong.mp4', 'wrong.mov']) {
    assert.throws(() => store.inspectFile(name, writeSource(name, Buffer.from('<script>not media</script>'))));
  }
  const corruptWave = wav(); corruptWave.writeUInt32LE(999999, 4);
  assert.throws(() => store.inspectFile('corrupt.wav', writeSource('corrupt.wav', corruptWave)));
  assert.throws(() => store.inspectFile('unknown.mp4', writeSource('unknown.mp4', container('html'))));
});

test('incomplete media headers and containers without track metadata are rejected', () => {
  assert.throws(() => store.inspectFile('short.mp3', writeSource('short.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64, 0]))));
  assert.throws(() => store.inspectFile('missing-moov.mp4', writeSource('missing-moov.mp4', container('isom', false))));
  assert.throws(() => store.inspectFile('missing-moov.m4a', writeSource('missing-moov.m4a', container('M4A ', false))));
});

test('real multipart upload copies source bytes, generates private names and safely preserves files on unlink', async () => {
  const original = writeSource('source-original.wav', wav()); const before = fs.readFileSync(original);
  const result = await upload([{ name: '../private original.wav', bytes: fs.readFileSync(original), mime: 'text/html' }]);
  assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.created.length, 1);
  const doc = db.prepare('SELECT * FROM managed_documents WHERE id=?').get(result.data.created[0].id);
  assert.equal(doc.mime_type, 'audio/wav'); assert.equal(doc.legacy_restricted, 1);
  assert.match(doc.stored_filename, /^owner-951\/[a-f0-9-]{36}\.wav$/);
  const managed = store.diskPath(doc.stored_filename);
  assert.deepEqual(fs.readFileSync(managed), before); assert.deepEqual(fs.readFileSync(original), before);
  assert.equal(fs.statSync(managed).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(managed)).mode & 0o777, 0o700);
  assert.equal(doc.sha256, crypto.createHash('sha256').update(before).digest('hex'));
  assert.deepEqual(incoming(), []);
  assert.equal((await json(`/api/final-wishes/legacy/${item.id}/attachments/${doc.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(fs.existsSync(managed)); assert.deepEqual(fs.readFileSync(original), before);
});

test('new photo copies strip incidental metadata while original PNG bytes remain unchanged', async () => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=', 'base64');
  const marker = Buffer.from('Comment\0GPS_SYNTHETIC_PRIVATE_LOCATION');
  const chunk = Buffer.alloc(marker.length + 12); chunk.writeUInt32BE(marker.length); chunk.write('tEXt', 4); marker.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const photograph = Buffer.concat([pixel.subarray(0, 33), chunk, pixel.subarray(33)]);
  const source = writeSource('original-photo.png', photograph);
  const result = await upload([{ name: 'family.png', bytes: fs.readFileSync(source), mime: 'image/png' }]);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const doc = db.prepare('SELECT * FROM managed_documents WHERE id=?').get(result.data.created[0].id);
  const managed = fs.readFileSync(store.diskPath(doc.stored_filename));
  assert.equal(managed.includes(Buffer.from('GPS_SYNTHETIC')), false);
  assert.deepEqual(managed, pixel); assert.deepEqual(fs.readFileSync(source), photograph);
  assert.equal(doc.sha256, crypto.createHash('sha256').update(managed).digest('hex'));
  assert.equal(doc.size_bytes, managed.length);
});

test('mixed valid/spoofed multipart uploads roll back files, rows and revisions atomically', async () => {
  const before = await json('/api/final-wishes/legacy/' + item.id);
  const result = await upload([{ name: 'valid.wav', bytes: wav() }, { name: 'spoof.mp4', bytes: Buffer.from('<html>bad</html>'), mime: 'video/mp4' }]);
  assert.equal(result.status, 400, JSON.stringify(result.data)); assert.equal(managedCount(), 0);
  const after = await json('/api/final-wishes/legacy/' + item.id);
  assert.equal(after.data.revision, before.data.revision); assert.deepEqual(after.data.attachments, []);
  assert.deepEqual(incoming(), []);
});

test('file count, per-file size and owner quota failures leave no accepted managed rows', async () => {
  let result = await upload(Array.from({ length: 9 }, (_, i) => ({ name: `voice-${i}.wav`, bytes: wav() })));
  assert.equal(result.status, 400); assert.equal(managedCount(), 0); assert.deepEqual(incoming(), []);
  result = await upload([{ name: 'too-large.wav', bytes: wav(1024 * 1024) }]);
  assert.equal(result.status, 400); assert.equal(managedCount(), 0); assert.deepEqual(incoming(), []);
  result = await upload([{ name: 'quota-a.wav', bytes: wav(700000) }, { name: 'quota-b.wav', bytes: wav(700000) }]);
  assert.equal(result.status, 413); assert.equal(managedCount(), 0); assert.deepEqual(incoming(), []);
});

test('ownership is checked before multipart staging and unsupported active formats are rejected', async () => {
  const foreign = await upload([{ name: 'private.wav', bytes: wav() }], OTHER);
  assert.equal(foreign.status, 404); assert.equal(managedCount(), 0); assert.deepEqual(incoming(), []);
  for (const name of ['active.svg', 'active.html', 'archive.zip']) {
    const result = await upload([{ name, bytes: Buffer.from('<svg onload="alert(1)">') }]);
    assert.equal(result.status, 400); assert.equal(managedCount(), 0); assert.deepEqual(incoming(), []);
  }
});

test('malformed upload limit configuration retains a finite server-side maximum', () => {
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('./server/document-store').MAX_FILE_BYTES))"], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, DOCUMENT_MAX_FILE_MB: 'not-a-number' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0); const limit = Number(result.stdout);
  assert.ok(Number.isFinite(limit) && limit >= 1024 * 1024 && limit <= 100 * 1024 * 1024);
});

test('document responses normalize malformed Unicode labels and close descriptors on header setup failures', () => {
  const originalOpen = store.openDocument, originalView = store.toView;
  const filename = writeSource('descriptor-fixture.txt', Buffer.from('synthetic'));
  let opened;
  try {
    store.openDocument = () => ({ fd: opened = fs.openSync(filename, 'r'), size: 9 });
    store.toView = () => ({ display_name: '\ud800' });
    const headers = {};
    const response = { set(value) { Object.assign(headers, value); return this; }, end() {} };
    require('../server/document-response').sendDocument({ method: 'HEAD', headers: {} }, response, { mime_type: 'text/plain' });
    assert.ok(headers['Content-Disposition'].includes('%EF%BF%BD'));
    assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
    store.toView = () => ({ display_name: 'ordinary.txt' });
    assert.throws(() => require('../server/document-response').sendDocument({ headers: {} }, {
      set() { throw new Error('Synthetic header failure'); }
    }, { mime_type: 'text/plain' }), /Synthetic header failure/);
    assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
  } finally {
    store.openDocument = originalOpen; store.toView = originalView;
    if (opened !== undefined) try { fs.closeSync(opened); } catch {}
  }
});

test('additive legacy migration preserves old encrypted wishes, token hashes and document mappings and is idempotent', () => {
  const old = new Database(':memory:'); old.pragma('foreign_keys=ON');
  try {
    old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY);
      CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,access_token TEXT);
      CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,user_id INTEGER,section TEXT,title TEXT,fields_encrypted TEXT,notes_encrypted TEXT);
      CREATE TABLE managed_documents(id TEXT PRIMARY KEY,user_id INTEGER,display_name_encrypted TEXT,stored_filename TEXT);
      CREATE TABLE document_associations(document_id TEXT,entry_id INTEGER);
      INSERT INTO users VALUES(1);
      INSERT INTO beneficiaries VALUES(1,1,'Synthetic beneficiary','preserved-token-hash');
      INSERT INTO managed_documents VALUES('synthetic-old-document',1,'preserved-document-name-ciphertext','owner-1/preserved.pdf');
      INSERT INTO document_associations VALUES('synthetic-old-document',1);`);
    old.prepare('INSERT INTO vault_entries VALUES(1,1,?,?,?,?)').run('final_wishes', 'Old wishes', encrypt(JSON.stringify({ category: 'Other', details: 'Synthetic retained wishes', contact_person: 'Synthetic contact', contact_phone: '000' })), encrypt('Synthetic notes'));
    const tables = ['users', 'beneficiaries', 'vault_entries', 'document_associations'];
    const before = tables.map(table => old.prepare('SELECT * FROM ' + table).all());
    const docBefore = old.prepare('SELECT * FROM managed_documents').get();
    const { initLegacySchema } = require('../server/legacy-schema'); initLegacySchema(old); initLegacySchema(old);
    assert.deepEqual(tables.map(table => old.prepare('SELECT * FROM ' + table).all()), before);
    assert.deepEqual(old.prepare('SELECT id,user_id,display_name_encrypted,stored_filename FROM managed_documents').get(), docBefore);
    assert.equal(old.prepare('SELECT legacy_restricted FROM managed_documents').get().legacy_restricted, 0);
    assert.deepEqual(old.prepare('SELECT version FROM legacy_schema_migrations ORDER BY version').all().map(row=>row.version), [1, 2]);
    assert.deepEqual(old.pragma('foreign_key_check'), []);
  } finally { old.close(); }
});

test('migration refuses a partial feature schema without marking it applied or changing old documents', () => {
  const partial = new Database(':memory:');
  try {
    partial.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY);
      CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER);
      CREATE TABLE vault_entries(id INTEGER PRIMARY KEY,user_id INTEGER);
      CREATE TABLE managed_documents(id TEXT PRIMARY KEY,user_id INTEGER);
      CREATE TABLE legacy_contents(id TEXT PRIMARY KEY,user_id INTEGER,type TEXT,status TEXT);`);
    assert.throws(() => require('../server/legacy-schema').initLegacySchema(partial));
    assert.equal(partial.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_schema_migrations'").get(), undefined);
    assert.equal(partial.prepare('PRAGMA table_info(managed_documents)').all().some(column => column.name === 'legacy_restricted'), false);
  } finally { partial.close(); }
});
