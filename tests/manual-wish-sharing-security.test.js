'use strict';

// These requests use a disposable in-memory vault and synthetic private files.
// They cannot contact the deployed app, create a real account or send an SMS.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.ENCRYPTION_KEY = 'a4'.repeat(32);
process.env.JWT_SECRET = 'synthetic-manual-sharing-security-secret';
process.env.NOTIFICATION_SECRET = 'a5'.repeat(32);
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.SMS_ENABLED = 'false';
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';
const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-manual-sharing-'));
fs.chmodSync(mediaRoot, 0o700);
process.env.DOCUMENT_STORAGE_ROOT = mediaRoot;
const { encrypt, decrypt, hashToken } = require('../server/crypto');
const OWNER = 971, OTHER = 972;
const tokens = ['synthetic-share-a', 'synthetic-share-b', 'synthetic-unassigned', 'synthetic-foreign'];
let db, server, base, a, b, unassigned, foreign;
const ownerWish = id => '/api/final-wishes/legacy/' + id;
const recipientWish = id => '/api/beneficiary-access/legacy' + (id ? '/' + id : '');

async function request(route, { method = 'GET', body, owner = OWNER, token, headers = {} } = {}) {
  const authorization = token === null ? {} : { Authorization: 'Bearer ' +
    (token || jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: '5m' })) };
  const response = await fetch(base + route, { method,
    headers: { ...authorization, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text, headers: response.headers };
}
function success(result) {
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.data;
}
function denied(result, status) {
  if (status) assert.equal(result.status, status, result.text);
  else assert.ok([400, 401, 403, 404, 409].includes(result.status), JSON.stringify(result));
}
async function create(fields = {}) {
  return success(await request('/api/final-wishes/legacy', { method: 'POST', body: {
    type: 'instruction', title: 'Private synthetic wish', body_markdown: 'PRIVATE_WISH_BODY',
    metadata: { checklist: [{ id: 'step', text: 'Private synthetic instruction' }] },
    beneficiary_ids: [a, b], ...fields } }));
}
async function share(item, ids = [a], extra = {}) {
  return request(ownerWish(item.id) + '/share', { method: 'POST',
    body: { confirm: true, expected_revision: item.revision, beneficiary_ids: ids, ...extra } });
}
function snapshot(id) {
  return {
    row: db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(id),
    mappings: db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? ORDER BY beneficiary_id').all(id),
    versions: db.prepare('SELECT * FROM legacy_content_versions WHERE content_id=? ORDER BY id').all(id),
    attachments: db.prepare('SELECT * FROM legacy_content_attachments WHERE content_id=? ORDER BY document_id').all(id),
    acknowledgements: db.prepare('SELECT * FROM legacy_content_acknowledgements WHERE content_id=? ORDER BY beneficiary_id,step_id').all(id)
  };
}
function vaultEntry(section = 'property', homebankId = null) {
  return Number(db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted,homebank_account_id) VALUES(?,?,?,?,?)')
    .run(OWNER, section, 'PRIVATE_GENERAL_VAULT', encrypt('{"details":"PRIVATE_GENERAL_DETAILS"}'), homebankId).lastInsertRowid);
}
function document(bytes = 'PRIVATE_WISH_ATTACHMENT', owner = OWNER) {
  const store = require('../server/document-store'), id = crypto.randomUUID();
  fs.writeFileSync(path.join(store.ownerDirectory(owner), id + '.txt'), bytes, { mode: 0o600 });
  db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,stored_filename,mime_type,size_bytes,sha256,legacy_restricted)
    VALUES(?,?,?,?,?,'text/plain',?,?,1)`).run(id, owner, encrypt('private.txt'), encrypt('private.txt'),
    `owner-${owner}/${id}.txt`, Buffer.byteLength(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
  return id;
}
async function attach(item, doc) {
  success(await request(ownerWish(item.id) + '/attachments', { method: 'POST', body: { document_id: doc } }));
  return success(await request(ownerWish(item.id)));
}
const download = (item, doc) => recipientWish(item.id) + '/attachments/' + doc + '/content';
const ack = item => recipientWish(item.id) + '/acknowledgements';
async function assertHidden(item, token = tokens[0], doc) {
  assert.ok(!success(await request(recipientWish(), { token })).some(row => row.id === item.id));
  const detail = await request(recipientWish(item.id), { token });
  denied(detail, 404); assert.equal(detail.headers.get('cache-control'), 'private, no-store');
  denied(await request(ack(item), { token, method: 'POST', body: { step_id: 'step', acknowledged: true } }), 404);
  if (doc) denied(await request(download(item, doc), { token }), 404);
}

before(async () => {
  db = new Database(':memory:');
  const cache = require.cache[require.resolve('better-sqlite3')], original = cache.exports;
  cache.exports = function FixtureDatabase(filename) {
    assert.equal(filename, path.resolve(__dirname, '../data/vault.db'));
    return db;
  };
  try { assert.equal(require('../server/db').getDb(), db); } finally { cache.exports = original; }
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)');
  insert.run(OWNER, 'synthetic-share-owner@example.test', 'Synthetic owner', 'synthetic-hash');
  insert.run(OTHER, 'synthetic-share-other@example.test', 'Synthetic other', 'synthetic-hash');
  db.prepare('INSERT INTO dead_switch_config(user_id) VALUES(?)').run(OWNER);
  const app = express(); app.use(express.json());
  const routes = require('../server/routes/legacy');
  app.use('/api/final-wishes', routes.ownerRouter);
  app.use('/api/beneficiary-access', routes.beneficiaryRouter);
  app.use('/api/beneficiaries', require('../server/routes/beneficiaries'));
  app.use('/api/documents', require('../server/routes/documents'));
  app.use('/api/vault', require('../server/routes/vault'));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Synthetic request failed' }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fixture_share_audit_failure;
    DELETE FROM legacy_contents; DELETE FROM notification_outbox; DELETE FROM beneficiaries;
    DELETE FROM document_associations; DELETE FROM managed_documents; DELETE FROM vault_entries;`);
  const insert = db.prepare(`INSERT INTO beneficiaries(user_id,name,access_token,token_expires_at)
    VALUES(?,?,?,'2099-01-01T00:00:00.000Z')`);
  [a, b, unassigned, foreign] = tokens.map((token, index) => Number(insert.run(index === 3 ? OTHER : OWNER,
    'Synthetic recipient ' + index, hashToken(token)).lastInsertRowid));
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db?.open) db.close();
  fs.rmSync(mediaRoot, { recursive: true, force: true });
});

test('assignment, readiness and general access never publish a private or unreleased manual wish', async () => {
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE user_id=?').run(OWNER);
  for (const fields of [
    { status: 'draft', release_policy: 'owner_only' },
    { status: 'ready', release_policy: 'owner_only' },
    { status: 'draft', release_policy: 'manual_release' },
    { status: 'ready', release_policy: 'manual_release' }
  ]) {
    const item = await create(fields), doc = document();
    await attach(item, doc);
    await assertHidden(item, tokens[0], doc);
    assert.equal(db.prepare('SELECT released_at FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(item.id, a).released_at, null);
  }
});

test('confirmed sharing publishes exactly the selected wish and its files while the general vault stays locked', async () => {
  const parent = vaultEntry('final_wishes'), linked = vaultEntry(), hidden = vaultEntry('property', 72);
  let item = await create({ status: 'ready', final_wishes_entry_id: parent, links: [{ entry_id: linked }] });
  // The source account became hidden after this historical link was saved.
  db.prepare('INSERT INTO legacy_content_links VALUES(?,?)').run(item.id, hidden);
  const doc = document(), unrelatedDoc = document('UNSHARED_PRIVATE_FILE'), foreignDoc = document('FOREIGN_PRIVATE_FILE', OTHER);
  item = await attach(item, doc);
  const original = snapshot(item.id), beneficiaries = db.prepare('SELECT * FROM beneficiaries ORDER BY id').all();
  const sharedResponse = await share(item), shared = success(sharedResponse);
  assert.equal(sharedResponse.headers.get('cache-control'), 'private, no-store');
  assert.equal(shared.id, item.id); assert.equal(shared.status, 'released'); assert.equal(shared.release_policy, 'manual_release');
  assert.equal(shared.revision, item.revision + 1);
  const mappings = db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? ORDER BY beneficiary_id').all(item.id);
  assert.equal(mappings.find(row => row.beneficiary_id === a).release_scope, 'manual_token_share');
  assert.equal(mappings.find(row => row.beneficiary_id === b).released_at, null);
  assert.deepEqual(JSON.parse(decrypt(snapshot(item.id).row.payload_encrypted)), JSON.parse(decrypt(original.row.payload_encrypted)));
  assert.deepEqual(db.prepare('SELECT * FROM beneficiaries ORDER BY id').all(), beneficiaries);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
  const detailResponse = await request(recipientWish(item.id), { token: tokens[0] }), detail = success(detailResponse);
  assert.equal(detailResponse.headers.get('cache-control'), 'private, no-store');
  assert.equal(detail.access_scope, 'released_content'); assert.equal(detail.body_markdown, item.body_markdown);
  assert.deepEqual(detail.links, []); assert.equal(detail.final_wishes_entry_id, null);
  assert.ok(!('versions' in detail)); assert.ok(!('beneficiaries' in detail)); assert.ok(!('beneficiary_ids' in detail));
  assert.deepEqual(detail.attachments.map(row => row.id), [doc]);
  assert.ok(tokens.every(token => !detailResponse.text.includes(token)));
  assert.equal((await request(download(item, doc), { token: tokens[0] })).text, 'PRIVATE_WISH_ATTACHMENT');
  for (const id of [unrelatedDoc, foreignDoc]) denied(await request(download(item, id), { token: tokens[0] }), 404);
  for (const token of tokens.slice(1)) await assertHidden(item, token, doc);
  const general = success(await request('/api/beneficiaries/access', { method: 'POST', token: null, body: { accessToken: tokens[0] } }));
  assert.equal(general.status, 'no_access'); assert.ok(!general.entries?.length);
  denied(await request('/api/documents/beneficiary/content', { method: 'POST', token: null,
    body: { accessToken: tokens[0], documentId: doc, mode: 'preview' } }));
  denied(await request('/api/vault/entries/' + linked, { token: tokens[0] }));
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(a);
  const full = success(await request(recipientWish(item.id), { token: tokens[0] }));
  assert.deepEqual(full.links, [{ entry_id: linked }]); assert.equal(full.final_wishes_entry_id, parent);
});

test('sharing accepts an explicitly selected draft and keeps manual ready content revision stable', async () => {
  for (const fields of [
    { status: 'draft', release_policy: 'owner_only' },
    { status: 'draft', release_policy: 'manual_release' },
    { status: 'ready', release_policy: 'manual_release' }
  ]) {
    const item = await create(fields), shared = success(await share(item));
    assert.equal(shared.revision, item.revision + (fields.status === 'draft' ? 1 : 0));
    assert.equal(success(await request(recipientWish(item.id), { token: tokens[0] })).id, item.id);
    await assertHidden(item, tokens[1]);
  }
});

test('historical manual releases stay behind the full-vault gate until each recipient receives explicit token sharing', async () => {
  const item = await create({ status: 'ready', release_policy: 'manual_release',
    release_scope: 'manual_token_share', metadata: { release_scope: 'manual_token_share' } });
  success(await request(ownerWish(item.id) + '/release', { method: 'POST',
    body: { confirm: true, beneficiary_ids: [a, b], release_scope: 'manual_token_share' } }));
  for (const token of tokens.slice(0, 2)) await assertHidden(item, token);
  assert.ok(db.prepare('SELECT release_scope FROM legacy_content_beneficiaries WHERE content_id=?').all(item.id)
    .every(row => row.release_scope === 'manual_release'));
  const current = success(await request(ownerWish(item.id)));
  success(await share(current, [a]));
  assert.equal(success(await request(recipientWish(item.id), { token: tokens[0] })).id, item.id);
  await assertHidden(item, tokens[1]);
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(b);
  assert.equal(success(await request(recipientWish(item.id), { token: tokens[1] })).id, item.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE content_id=? AND event_type='token_shared'").get(item.id).n, 1);
  success(await share(current, [a]));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE content_id=? AND event_type='token_shared'").get(item.id).n, 1);
});

test('sharing requires current revision, explicit confirmation and a nonempty assigned owner subset without side effects', async () => {
  const item = await create({ status: 'ready' });
  for (const body of [
    {}, { confirm: false }, { confirm: 'true' },
    { expected_revision: undefined }, { expected_revision: String(item.revision) },
    { expected_revision: item.revision - 1 }, { expected_revision: item.revision + 1 },
    { beneficiary_ids: undefined }, { beneficiary_ids: [] }, { beneficiary_ids: [unassigned] },
    { beneficiary_ids: [foreign] }, { beneficiary_ids: [a, unassigned] },
    { beneficiary_ids: [0] }, { beneficiary_ids: [String(a)] }, { beneficiary_ids: [null] },
    { beneficiary_ids: [a + 0.5] }, { beneficiary_ids: 'all' }
  ]) {
    const before = snapshot(item.id);
    const result = body && Object.keys(body).length ? await share(item, [a], body) :
      await request(ownerWish(item.id) + '/share', { method: 'POST', body });
    denied(result);
    assert.deepEqual(snapshot(item.id), before, JSON.stringify(body));
  }
  const before = snapshot(item.id);
  denied(await request(ownerWish(item.id) + '/share', { method: 'POST', owner: OTHER,
    body: { confirm: true, expected_revision: item.revision, beneficiary_ids: [foreign] } }), 404);
  denied(await request(ownerWish(item.id) + '/share', { method: 'POST', token: null,
    body: { confirm: true, expected_revision: item.revision, beneficiary_ids: [a] } }));
  assert.deepEqual(snapshot(item.id), before);
});

test('a stale confirmation after editing narrative or files cannot publish unseen changes', async () => {
  let item = await create({ status: 'ready' });
  success(await request(ownerWish(item.id), { method: 'PATCH', body: { body_markdown: 'NEW_PRIVATE_NARRATIVE' } }));
  let before = snapshot(item.id);
  denied(await share(item), 409); assert.deepEqual(snapshot(item.id), before);
  item = success(await request(ownerWish(item.id)));
  await attach(item, document());
  before = snapshot(item.id);
  denied(await share(item), 409); assert.deepEqual(snapshot(item.id), before);
  await assertHidden(item);
});

test('automatic, retired and archived wishes cannot be published by the manual sharing action', async () => {
  const person = success(await request('/api/beneficiaries', { method: 'POST', body: { name: 'Synthetic automatic recipient' } }));
  let automatic = success(await request(ownerWish(person.final_wish_id))), before = snapshot(automatic.id);
  denied(await share(automatic, [person.id]), 409); assert.deepEqual(snapshot(automatic.id), before);
  success(await request('/api/beneficiaries/' + person.id, { method: 'DELETE' }));
  automatic = success(await request(ownerWish(person.final_wish_id))); before = snapshot(automatic.id);
  denied(await share(automatic, [a]), 409); assert.deepEqual(snapshot(automatic.id), before);
  const archived = await create({ status: 'archived' }), archivedBefore = snapshot(archived.id);
  denied(await share(archived), 409); assert.deepEqual(snapshot(archived.id), archivedBefore);
  const ownerOnly = await create({ status: 'ready' });
  denied(await request(ownerWish(ownerOnly.id) + '/release', { method: 'POST', body: { confirm: true, beneficiary_ids: [a] } }));
  await assertHidden(ownerOnly);
});

test('extending a manual share preserves prior recipients and independently scopes acknowledgements', async () => {
  let item = await create(), doc = document();
  item = await attach(item, doc);
  const first = success(await share(item, [a])), firstMapping = db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(item.id, a);
  const second = success(await share(first, [b]));
  assert.equal(second.revision, first.revision);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(item.id, a), firstMapping);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_documents WHERE id=?').get(doc).n, 1);
  for (const token of tokens.slice(0, 2)) {
    assert.equal((await request(download(item, doc), { token })).text, 'PRIVATE_WISH_ATTACHMENT');
    const acknowledged = success(await request(ack(item), { token, method: 'POST', body: { step_id: 'step', acknowledged: true } }));
    assert.deepEqual(acknowledged.acknowledgements.map(row => row.step_id), ['step']);
  }
  for (const token of tokens.slice(2)) await assertHidden(item, token, doc);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_content_acknowledgements WHERE content_id=?').get(item.id).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM beneficiaries WHERE access_granted=1').get().n, 0);
});

test('event-driven releases still require a current wider grant and cannot borrow a manual release scope', async () => {
  for (const policy of ['dead_switch_release', 'emergency_access_release']) {
    const item = await create({ status: 'ready', release_policy: policy });
    db.prepare("UPDATE legacy_contents SET status='released' WHERE id=?").run(item.id);
    db.prepare('UPDATE legacy_content_beneficiaries SET released_at=?,release_scope=? WHERE content_id=? AND beneficiary_id=?')
      .run(new Date().toISOString(), policy, item.id, a);
    await assertHidden(item);
    db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(a);
    assert.equal(success(await request(recipientWish(item.id), { token: tokens[0] })).id, item.id);
    db.prepare("UPDATE legacy_content_beneficiaries SET release_scope='manual_token_share' WHERE content_id=? AND beneficiary_id=?").run(item.id, a);
    await assertHidden(item);
    db.prepare('UPDATE beneficiaries SET access_granted=0 WHERE id=?').run(a);
  }
});

test('explicit policy conversion withdraws other event-driven recipients before sharing the selected subset', async () => {
  let item = await create({ status: 'ready', release_policy: 'emergency_access_release' });
  db.prepare("UPDATE legacy_contents SET status='released' WHERE id=?").run(item.id);
  db.prepare('UPDATE legacy_content_beneficiaries SET released_at=?,release_scope=? WHERE content_id=?')
    .run(new Date().toISOString(), 'emergency_access_release', item.id);
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(b);
  assert.equal(success(await request(recipientWish(item.id), { token: tokens[1] })).id, item.id);
  item = success(await request(ownerWish(item.id)));
  const shared = success(await share(item, [a]));
  assert.equal(shared.release_policy, 'manual_release');
  assert.equal(success(await request(recipientWish(item.id), { token: tokens[0] })).id, item.id);
  const other = db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(item.id, b);
  assert.equal(other.released_at, null); assert.equal(other.release_scope, null);
  await assertHidden(item, tokens[1]);
});

test('editing shared content withdraws all grants until the latest revision is explicitly confirmed', async () => {
  const item = await create(), shared = success(await share(item, [a, b]));
  success(await request(ack(item), { token: tokens[0], method: 'POST', body: { step_id: 'step', acknowledged: true } }));
  const updated = success(await request(ownerWish(item.id), { method: 'PATCH', body: { body_markdown: 'LATEST_PRIVATE_WISH' } }));
  assert.equal(updated.status, 'draft');
  for (const token of tokens.slice(0, 2)) await assertHidden(item, token);
  denied(await share(shared, [a, b]), 409);
  success(await share(updated, [b]));
  await assertHidden(item, tokens[0]);
  assert.equal(success(await request(recipientWish(item.id), { token: tokens[1] })).body_markdown, 'LATEST_PRIVATE_WISH');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_content_acknowledgements WHERE content_id=?').get(item.id).n, 0);
});

test('failed durable audit rolls back the entire share including policy conversion, revisions and first recipient grant', async () => {
  const item = await create({ status: 'ready' }), before = snapshot(item.id);
  const eventsBefore = db.prepare('SELECT * FROM legacy_release_events WHERE content_id=? ORDER BY id').all(item.id);
  const auditsBefore = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  db.exec(`CREATE TRIGGER fixture_share_audit_failure BEFORE INSERT ON audit_log
    WHEN NEW.action='legacy_token_shared' AND EXISTS (
      SELECT 1 FROM legacy_release_events WHERE content_id='${item.id}'
      AND event_type='token_shared' AND beneficiary_id=${b})
    BEGIN SELECT RAISE(ABORT,'Synthetic durable audit failure'); END;`);
  assert.equal((await share(item, [a, b])).status, 500);
  assert.deepEqual(snapshot(item.id), before);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_release_events WHERE content_id=? ORDER BY id').all(item.id), eventsBefore);
  assert.deepEqual(db.prepare('SELECT * FROM audit_log ORDER BY id').all(), auditsBefore);
  db.exec('DROP TRIGGER fixture_share_audit_failure');
  success(await share(item, [a, b]));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE content_id=? AND event_type='released'").get(item.id).n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE content_id=? AND event_type='token_shared'").get(item.id).n, 2);
});

test('ordinary re-release after revocation cannot silently restore token sharing', async () => {
  const item = await create({ status: 'ready', release_policy: 'manual_release' });
  const shared = success(await share(item));
  success(await request(ownerWish(item.id) + '/revoke', { method: 'POST', body: { confirm: true, beneficiary_ids: [a] } }));
  success(await request(ownerWish(item.id) + '/release', { method: 'POST', body: { confirm: true, beneficiary_ids: [a] } }));
  assert.equal(db.prepare('SELECT release_scope FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(item.id, a).release_scope, 'manual_release');
  await assertHidden(item);
  success(await share(shared));
  assert.equal(success(await request(recipientWish(item.id), { token: tokens[0] })).id, item.id);
});

test('deleting a token-shared beneficiary removes every token operation while retaining the other recipient and owner file', async () => {
  const person = success(await request('/api/beneficiaries', { method: 'POST', body: { name: 'Synthetic removable recipient' } }));
  let item = await create({ beneficiary_ids: [person.id, b] });
  const doc = document(); item = await attach(item, doc);
  success(await share(item, [person.id, b]));
  assert.equal((await request(download(item, doc), { token: person.accessToken })).text, 'PRIVATE_WISH_ATTACHMENT');
  success(await request('/api/beneficiaries/' + person.id, { method: 'DELETE' }));
  for (const route of [recipientWish(), recipientWish(item.id), download(item, doc)]) {
    denied(await request(route, { token: person.accessToken }), 403);
  }
  denied(await request(ack(item), { token: person.accessToken, method: 'POST', body: { step_id: 'step', acknowledged: true } }), 403);
  assert.equal(success(await request(recipientWish(item.id), { token: tokens[1] })).id, item.id);
  assert.equal((await request(download(item, doc), { token: tokens[1] })).text, 'PRIVATE_WISH_ATTACHMENT');
  assert.equal(success(await request(ownerWish(item.id))).id, item.id);
  assert.ok(fs.existsSync(require('../server/document-store').diskPath(`owner-${OWNER}/${doc}.txt`)));
});

test('per-item and global revocation, token changes and removal deny shared detail, attachments and acknowledgements immediately', async () => {
  for (const action of ['per_item', 'global', 'expiry', 'rotation', 'removal', 'archive']) {
    let item = await create(), doc = document(); item = await attach(item, doc);
    const shared = success(await share(item));
    if (action === 'per_item') success(await request(ownerWish(item.id) + '/revoke', { method: 'POST', body: { confirm: true, beneficiary_ids: [a] } }));
    if (action === 'global') success(await request('/api/beneficiaries/' + a + '/revoke', { method: 'POST' }));
    if (action === 'expiry') db.prepare("UPDATE beneficiaries SET token_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(a);
    if (action === 'rotation') success(await request('/api/beneficiaries/' + a + '/regenerate-token', { method: 'POST' }));
    if (action === 'removal') success(await request(ownerWish(item.id) + '/beneficiaries', { method: 'PUT', body: { beneficiary_ids: [b] } }));
    if (action === 'archive') success(await request(ownerWish(item.id), { method: 'PATCH', body: { status: 'archived' } }));
    for (const route of [recipientWish(item.id), download(item, doc)]) denied(await request(route, { token: tokens[0] }));
    denied(await request(ack(item), { token: tokens[0], method: 'POST', body: { step_id: 'step', acknowledged: true } }));
    assert.equal(db.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(a).access_granted, 0);
    // Restore the synthetic token only so the next independent case can run.
    db.prepare("UPDATE beneficiaries SET access_token=?,token_expires_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(hashToken(tokens[0]), a);
    assert.equal(shared.status, 'released');
  }
});
