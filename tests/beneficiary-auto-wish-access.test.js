'use strict';

// Route-level acceptance and adversarial tests. Every record, token, transport
// and document lives in this disposable fixture; no deployed data is opened.
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

process.env.ENCRYPTION_KEY = '9a'.repeat(32);
process.env.JWT_SECRET = 'synthetic-personal-wish-access-secret';
process.env.NOTIFICATION_SECRET = '9b'.repeat(32);
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.SMS_ENABLED = 'false';
const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-auto-wish-access-'));
fs.chmodSync(mediaRoot, 0o700);
process.env.DOCUMENT_STORAGE_ROOT = mediaRoot;
const { encrypt, decrypt } = require('../server/crypto');
const OWNER = 861, OTHER = 862;
let db, server, base;

async function request(route, { method = 'GET', body, owner = OWNER, token, headers = {} } = {}) {
  const authorization = token === null ? {} : { Authorization: 'Bearer ' +
    (token || jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: '5m' })) };
  const response = await fetch(base + route, { method,
    headers: { ...authorization, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data, text };
}
function success(result) {
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.data;
}
function denied(result, status) {
  if (status) assert.equal(result.status, status, result.text);
  else assert.ok([400, 401, 403, 404, 409].includes(result.status), result.text);
}
const ownerWish = id => '/api/final-wishes/legacy/' + id;
const recipientWish = id => '/api/beneficiary-access/legacy' + (id ? '/' + id : '');
async function beneficiary({ name = 'Same synthetic name', owner = OWNER } = {}) {
  return success(await request('/api/beneficiaries', { method: 'POST', owner,
    body: { name, email: 'synthetic-' + crypto.randomUUID() + '@example.test' } }));
}
async function createManual(fields = {}) {
  return success(await request('/api/final-wishes/legacy', { method: 'POST',
    body: { type: 'instruction', title: 'Manual wish', body_markdown: 'MANUAL_PRIVATE_BODY', ...fields } }));
}
async function portal(person) {
  return request('/api/beneficiaries/access', { method: 'POST', token: null, body: { accessToken: person.accessToken } });
}
function grant(person) { db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(person.id); }
function snapshot(id) {
  return { row: db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(id),
    identity: db.prepare('SELECT * FROM legacy_beneficiary_auto_wishes WHERE content_id=?').all(id),
    recipients: db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? ORDER BY beneficiary_id').all(id),
    revisions: db.prepare('SELECT * FROM legacy_content_versions WHERE content_id=? ORDER BY id').all(id) };
}
function savedEntry({ section = 'property', title = 'SECRET_GENERAL_VAULT', owner = OWNER, homebankId = null, fields = {} } = {}) {
  return Number(db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted,homebank_account_id) VALUES(?,?,?,?,?)')
    .run(owner, section, title, encrypt(JSON.stringify(fields)), homebankId).lastInsertRowid);
}
function document({ owner = OWNER, restricted = true, bytes = 'PRIVATE_ATTACHMENT_BYTES' } = {}) {
  const store = require('../server/document-store');
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(store.ownerDirectory(owner), id + '.txt'), bytes, { mode: 0o600 });
  db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,stored_filename,mime_type,size_bytes,sha256,legacy_restricted)
    VALUES(?,?,?,?,?,'text/plain',?,?,?)`).run(id, owner, encrypt('synthetic-private.txt'), encrypt('synthetic-private.txt'),
    `owner-${owner}/${id}.txt`, Buffer.byteLength(bytes), crypto.createHash('sha256').update(bytes).digest('hex'), restricted ? 1 : 0);
  return id;
}
async function attach(person, doc) {
  return success(await request(ownerWish(person.final_wish_id) + '/attachments', { method: 'POST', body: { document_id: doc } }));
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
  insert.run(OWNER, 'synthetic-auto-owner@example.test', 'Synthetic owner', 'synthetic-hash');
  insert.run(OTHER, 'synthetic-auto-other@example.test', 'Synthetic other', 'synthetic-hash');
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
  db.exec(`DELETE FROM legacy_contents; DELETE FROM notification_outbox; DELETE FROM beneficiaries;
    DELETE FROM document_associations; DELETE FROM managed_documents; DELETE FROM vault_entries;`);
  db.prepare('UPDATE dead_switch_config SET switch_triggered=0,switch_triggered_at=NULL,is_active=0 WHERE user_id=?').run(OWNER);
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db?.open) db.close();
  fs.rmSync(mediaRoot, { recursive: true, force: true });
});

test('creation immediately exposes exactly the dedicated wish by token while keeping no_access and private cache semantics', async () => {
  const person = await beneficiary();
  const ownerView = success(await request(ownerWish(person.final_wish_id)));
  const identity = db.prepare('SELECT * FROM legacy_beneficiary_auto_wishes WHERE beneficiary_id=?').get(person.id);
  assert.equal(identity.content_id, person.final_wish_id);
  assert.equal(identity.owner_user_id, OWNER);
  assert.deepEqual(ownerView.beneficiary_ids, [person.id]);
  assert.equal(ownerView.status, 'draft'); assert.equal(ownerView.release_policy, 'owner_only');
  assert.ok(!db.prepare('SELECT payload_encrypted FROM legacy_contents WHERE id=?').get(person.final_wish_id).payload_encrypted.includes(person.name));
  savedEntry();
  const manual = await createManual({ beneficiary_ids: [person.id] });
  const access = await portal(person);
  assert.equal(access.headers.get('cache-control'), 'private, no-store');
  assert.equal(success(access).status, 'no_access');
  assert.ok(!access.text.includes('SECRET_GENERAL_VAULT'));
  assert.ok(!access.text.includes(person.accessToken));
  assert.ok(!access.data.entries?.length);
  const listed = await request(recipientWish(), { token: person.accessToken });
  assert.equal(listed.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(success(listed).map(item => item.id), [person.final_wish_id]);
  const detail = await request(recipientWish(person.final_wish_id), { token: person.accessToken });
  assert.equal(detail.headers.get('cache-control'), 'private, no-store');
  assert.equal(success(detail).id, person.final_wish_id);
  assert.equal(db.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(person.id).access_granted, 0);
  const summary = success(await request('/api/beneficiaries/' + person.id + '/legacy'));
  assert.deepEqual(summary.map(item => item.id).sort(), [person.final_wish_id, manual.id].sort());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
});

test('waiting portal preserves emergency waiting and shows only the own automatic wish', async () => {
  const person = await beneficiary(); savedEntry();
  db.prepare('UPDATE beneficiaries SET emergency_access_requested=1,emergency_access_requested_at=? WHERE id=?')
    .run(new Date().toISOString(), person.id);
  const access = success(await portal(person));
  assert.equal(access.status, 'waiting'); assert.ok(access.waitInfo.access_at);
  assert.ok(!access.entries?.length);
  assert.deepEqual(success(await request(recipientWish(), { token: person.accessToken })).map(x => x.id), [person.final_wish_id]);
  assert.equal(db.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(person.id).access_granted, 0);
});

test('same-name beneficiaries and other owners cannot list or retrieve each other automatic wishes', async () => {
  const a = await beneficiary(), b = await beneficiary(), foreign = await beneficiary({ owner: OTHER });
  for (const person of [a, b, foreign]) {
    assert.deepEqual(success(await request(recipientWish(), { token: person.accessToken })).map(x => x.id), [person.final_wish_id]);
    for (const other of [a, b, foreign].filter(x => x !== person)) {
      denied(await request(recipientWish(other.final_wish_id), { token: person.accessToken }), 404);
      assert.deepEqual(success(await request(recipientWish() + '?beneficiary_id=' + other.id, { token: person.accessToken })), []);
    }
  }
  denied(await request(ownerWish(a.final_wish_id), { owner: OTHER }), 404);
});

test('owner content edits and eligible attachments update the same token-visible record on next retrieval', async () => {
  const person = await beneficiary();
  const original = success(await request(ownerWish(person.final_wish_id)));
  const edited = success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: {
    title: 'Edited personal wish', body_markdown: '**IMMEDIATE_PRIVATE_CONTENT**',
    metadata: { ...original.metadata, final_wishes: { ...original.metadata.final_wishes,
      details: 'Immediate details', contact_person: 'Informational contact', contact_phone: '000' },
      checklist: [{ id: 'first-step', text: 'Read the instructions' }] } } }));
  assert.equal(edited.id, original.id);
  assert.equal(edited.revision, 2);
  const doc = document(); await attach(person, doc);
  const current = success(await request(recipientWish(person.final_wish_id), { token: person.accessToken }));
  assert.equal(current.id, original.id); assert.equal(current.body_markdown, '**IMMEDIATE_PRIVATE_CONTENT**');
  assert.equal(current.metadata.final_wishes.contact_person, 'Informational contact');
  assert.deepEqual(current.attachments.map(x => x.id), [doc]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_beneficiary_auto_wishes WHERE beneficiary_id=?').get(person.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vault_entries').get().n, 0);
  assert.ok(!db.serialize().includes(Buffer.from('IMMEDIATE_PRIVATE_CONTENT')));
});

test('automatic recipient/origin mutations fail atomically at PATCH and recipient replacement entry points', async () => {
  const a = await beneficiary(), b = await beneficiary();
  const original = success(await request(ownerWish(a.final_wish_id)));
  const before = snapshot(a.final_wish_id);
  const contactId = savedEntry({ section: 'contacts', fields: { name: 'Named contact' } });
  const metadata = patch => ({ ...original.metadata, ...patch });
  for (const body of [
    { beneficiary_ids: [] }, { beneficiary_ids: [b.id] }, { beneficiary_ids: [a.id, b.id] },
    { beneficiary_ids: null }, { beneficiary_ids: {} }, { auto_generated: false },
    { locked_beneficiary: { id: b.id, name: b.name } }, { owner_user_id: OTHER },
    { metadata: metadata({ origin: { type: 'beneficiary', beneficiary_id: b.id } }) },
    { metadata: metadata({ origin: null }) }, { metadata: { final_wishes: original.metadata.final_wishes } },
    { metadata: metadata({ final_wishes: { ...original.metadata.final_wishes, contact_recipients: [{ entry_id: contactId }] } }) }
  ]) {
    denied(await request(ownerWish(a.final_wish_id), { method: 'PATCH', body: { ...body, title: 'MUST_NOT_BE_SAVED' } }));
    assert.deepEqual(snapshot(a.final_wish_id), before, JSON.stringify(body));
  }
  for (const beneficiary_ids of [[], [b.id], [a.id, b.id]]) {
    denied(await request(ownerWish(a.final_wish_id) + '/beneficiaries', { method: 'PUT', body: { beneficiary_ids } }));
    assert.deepEqual(snapshot(a.final_wish_id), before);
  }
  success(await request(ownerWish(a.final_wish_id) + '/beneficiaries', { method: 'PUT', body: { beneficiary_ids: [a.id] } }));
  assert.deepEqual(snapshot(a.final_wish_id).recipients, before.recipients);
});

test('manual origin spoofing never creates the privileged entitlement or modifies an automatic identity', async () => {
  const person = await beneficiary();
  const before = db.prepare('SELECT * FROM legacy_beneficiary_auto_wishes').all();
  const count = db.prepare('SELECT COUNT(*) AS n FROM legacy_contents').get().n;
  denied(await request('/api/final-wishes/legacy', { method: 'POST', body: {
    type: 'instruction', title: 'Forged automatic', beneficiary_ids: [person.id],
    metadata: { origin: { type: 'beneficiary', beneficiary_id: person.id } } } }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_contents').get().n, count);
  const manual = await createManual({ beneficiary_ids: [person.id] });
  const old = snapshot(manual.id);
  denied(await request(ownerWish(manual.id), { method: 'PATCH', body: {
    metadata: { origin: { type: 'beneficiary', beneficiary_id: person.id } } } }));
  assert.deepEqual(snapshot(manual.id), old);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_beneficiary_auto_wishes').all(), before);
  denied(await request(recipientWish(manual.id), { token: person.accessToken }), 404);
});

test('manual multiple recipients and contacts retain the existing release and full-access requirements', async () => {
  const a = await beneficiary(), b = await beneficiary();
  const contactId = savedEntry({ section: 'contacts', fields: { name: 'Canonical named contact' } });
  const manual = await createManual({ beneficiary_ids: [a.id, b.id], status: 'ready', release_policy: 'manual_release',
    metadata: { final_wishes: { contact_recipients: [{ entry_id: contactId, name: 'Ignored request name' }] } } });
  assert.deepEqual(manual.beneficiary_ids.sort(), [a.id, b.id].sort());
  assert.deepEqual(manual.metadata.final_wishes.contact_recipients, [{ entry_id: contactId, name: 'Canonical named contact' }]);
  success(await request(ownerWish(manual.id) + '/release', { method: 'POST', body: { confirm: true } }));
  denied(await request(recipientWish(manual.id), { token: a.accessToken }), 404);
  grant(a); grant(b);
  for (const person of [a, b]) {
    assert.equal(success(await request(recipientWish(manual.id), { token: person.accessToken })).id, manual.id);
    const items = success(await request(recipientWish(), { token: person.accessToken }));
    assert.deepEqual(items.map(x => x.id).sort(), [person.final_wish_id, manual.id].sort());
    assert.equal(items.filter(x => x.id === person.final_wish_id).length, 1);
  }
  success(await request(ownerWish(manual.id) + '/beneficiaries', { method: 'PUT', body: { beneficiary_ids: [a.id] } }));
  denied(await request(recipientWish(manual.id), { token: b.accessToken }), 404);
});

test('attachments and acknowledgements enforce token-to-wish isolation and never enable ordinary document routes', async () => {
  const a = await beneficiary(), b = await beneficiary(), foreign = await beneficiary({ owner: OTHER });
  const original = success(await request(ownerWish(a.final_wish_id)));
  success(await request(ownerWish(a.final_wish_id), { method: 'PATCH', body: {
    metadata: { ...original.metadata, checklist: [{ id: 'isolation-step', text: 'Private step' }] } } }));
  const aDoc = document(), bDoc = document({ bytes: 'OTHER_BENEFICIARY_ATTACHMENT' });
  await attach(a, aDoc); await attach(b, bDoc);
  const download = id => recipientWish(a.final_wish_id) + '/attachments/' + id + '/content';
  const own = await request(download(aDoc), { token: a.accessToken });
  assert.equal(own.status, 200); assert.equal(own.text, 'PRIVATE_ATTACHMENT_BYTES');
  assert.equal(own.headers.get('cache-control'), 'private, no-store');
  const range = await request(download(aDoc), { token: a.accessToken, headers: { Range: 'bytes=0-6' } });
  assert.equal(range.status, 206); assert.equal(range.text, 'PRIVATE');
  const ackRoute = recipientWish(a.final_wish_id) + '/acknowledgements';
  const ack = { method: 'POST', body: { step_id: 'isolation-step', acknowledged: true } };
  const ownAck = success(await request(ackRoute, { ...ack, token: a.accessToken }));
  assert.equal(ownAck.acknowledgements[0].acknowledged, 1);
  for (const person of [b, foreign]) {
    denied(await request(download(aDoc), { token: person.accessToken }), 404);
    denied(await request(ackRoute, { ...ack, token: person.accessToken }), 404);
  }
  denied(await request(download(bDoc), { token: a.accessToken }), 404);
  denied(await request('/api/documents/beneficiary/content', { method: 'POST', token: null,
    body: { accessToken: a.accessToken, documentId: aDoc } }), 403);
  grant(a);
  denied(await request('/api/documents/beneficiary/content', { method: 'POST', token: null,
    body: { accessToken: a.accessToken, documentId: aDoc } }), 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_content_acknowledgements').get().n, 1);
});

test('linked general vault records remain hidden until their independent vault authorization permits them', async () => {
  const person = await beneficiary();
  const ordinary = savedEntry(), excluded = savedEntry({ homebankId: 71 });
  success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: { links: [{ entry_id: ordinary }] } }));
  db.prepare('INSERT INTO legacy_content_links(content_id,entry_id) VALUES(?,?)').run(person.final_wish_id, excluded);
  let personal = success(await request(recipientWish(person.final_wish_id), { token: person.accessToken }));
  assert.deepEqual(personal.links, []);
  assert.ok(!JSON.stringify(personal).includes('SECRET_GENERAL_VAULT'));
  const doc = document({ restricted: false });
  db.prepare('INSERT INTO document_associations(document_id,entry_id) VALUES(?,?)').run(doc, ordinary);
  denied(await request('/api/documents/beneficiary/content', { method: 'POST', token: null,
    body: { accessToken: person.accessToken, documentId: doc } }), 403);
  grant(person);
  personal = success(await request(recipientWish(person.final_wish_id), { token: person.accessToken }));
  assert.deepEqual(personal.links, [{ entry_id: ordinary }]);
  assert.ok(!personal.links.some(link => link.entry_id === excluded));
});

test('explicit revocation blocks personal content even when no full grant existed and restore grants only personal scope', async () => {
  const person = await beneficiary();
  success(await request('/api/beneficiaries/' + person.id + '/revoke', { method: 'POST', body: {} }));
  assert.ok(db.prepare('SELECT auto_wish_access_revoked_at FROM beneficiaries WHERE id=?').get(person.id).auto_wish_access_revoked_at);
  assert.deepEqual(success(await request(recipientWish(), { token: person.accessToken })), []);
  denied(await request(recipientWish(person.final_wish_id), { token: person.accessToken }), 404);
  const restore = '/api/beneficiaries/' + person.id + '/restore-personal-wish-access';
  denied(await request(restore, { method: 'POST', body: { confirmed: true }, token: null }), 401);
  denied(await request(restore, { method: 'POST', body: { confirmed: true }, owner: OTHER }), 404);
  denied(await request(restore, { method: 'POST', body: {} }));
  assert.deepEqual(success(await request(recipientWish(), { token: person.accessToken })), []);
  success(await request(restore, { method: 'POST', body: { confirmed: true } }));
  assert.equal(success(await request(recipientWish(person.final_wish_id), { token: person.accessToken })).id, person.final_wish_id);
  assert.equal(success(await portal(person)).status, 'no_access');
  assert.equal(db.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(person.id).access_granted, 0);
});

test('expiry, token regeneration and beneficiary deletion revoke every personal operation', async () => {
  const person = await beneficiary();
  const original = success(await request(ownerWish(person.final_wish_id)));
  success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: {
    metadata: { ...original.metadata, checklist: [{ id: 'token-step', text: 'Private step' }] } } }));
  const doc = document(); await attach(person, doc);
  async function tokenDenied(token) {
    denied(await request(recipientWish(), { token }), 403);
    denied(await request(recipientWish(person.final_wish_id), { token }), 403);
    denied(await request(recipientWish(person.final_wish_id) + '/attachments/' + doc + '/content', { token }), 403);
    denied(await request(recipientWish(person.final_wish_id) + '/acknowledgements', { method: 'POST', token,
      body: { step_id: 'token-step', acknowledged: true } }), 403);
  }
  db.prepare("UPDATE beneficiaries SET token_expires_at='2001-01-01T00:00:00.000Z' WHERE id=?").run(person.id);
  await tokenDenied(person.accessToken);
  const rotated = success(await request('/api/beneficiaries/' + person.id + '/regenerate-token', { method: 'POST', body: {} }));
  assert.notEqual(rotated.accessToken, person.accessToken);
  await tokenDenied(person.accessToken);
  assert.equal(success(await request(recipientWish(person.final_wish_id), { token: rotated.accessToken })).id, person.final_wish_id);
  success(await request('/api/beneficiaries/' + person.id, { method: 'DELETE' }));
  await tokenDenied(rotated.accessToken);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_beneficiary_auto_wishes WHERE beneficiary_id=?').get(person.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_content_beneficiaries WHERE beneficiary_id=?').get(person.id).n, 0);
  const archived = success(await request(ownerWish(person.final_wish_id)));
  assert.equal(archived.status, 'archived');
  assert.deepEqual(archived.beneficiary_ids, []);
  assert.equal(archived.attachments[0].id, doc, 'deleting the beneficiary preserves the owner’s archived attachment');
  assert.ok(archived.release_events.some(event => event.event_type === 'auto_wish_beneficiary_removed'));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('archive is intentional access removal while ordinary deletion cannot break the automatic-wish invariant', async () => {
  const person = await beneficiary(), before = snapshot(person.final_wish_id);
  denied(await request(ownerWish(person.final_wish_id), { method: 'DELETE', body: { confirm_delete: true } }), 409);
  assert.deepEqual(snapshot(person.final_wish_id), before);
  success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: { status: 'archived' } }));
  assert.deepEqual(success(await request(recipientWish(), { token: person.accessToken })), []);
  denied(await request(recipientWish(person.final_wish_id), { token: person.accessToken }), 404);
  success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: { status: 'draft' } }));
  assert.equal(success(await request(recipientWish(person.final_wish_id), { token: person.accessToken })).id, person.final_wish_id);
});

test('beneficiary name edits follow the same recipient ID and ordinary responses never disclose issued token values', async () => {
  const person = await beneficiary();
  success(await request('/api/beneficiaries/' + person.id, { method: 'PUT', body: {
    name: 'Updated beneficiary identity', email: 'updated@example.test', phone: '000', relationship: 'Friend' } }));
  const item = success(await request(ownerWish(person.final_wish_id)));
  assert.deepEqual(item.beneficiary_ids, [person.id]);
  assert.equal(item.beneficiaries[0].name, 'Updated beneficiary identity');
  for (const result of [await request('/api/beneficiaries'), await request('/api/final-wishes/legacy'),
    await portal(person), await request(recipientWish(), { token: person.accessToken }),
    await request(recipientWish(person.final_wish_id), { token: person.accessToken })]) {
    success(result);
    assert.ok(!result.text.includes(person.accessToken));
    assert.ok(!result.text.includes('access_token'));
  }
  assert.ok(!db.prepare('SELECT detail FROM audit_log').all().some(row => String(row.detail).includes(person.accessToken)));
});

test('personal restoration never re-grants the full vault or revives other revoked manual releases', async () => {
  const person = await beneficiary(); grant(person); savedEntry();
  const manual = await createManual({ beneficiary_ids: [person.id], status: 'ready', release_policy: 'manual_release' });
  success(await request(ownerWish(manual.id) + '/release', { method: 'POST', body: { confirm: true } }));
  success(await request('/api/beneficiaries/' + person.id + '/revoke', { method: 'POST', body: {} }));
  assert.equal(success(await portal(person)).status, 'no_access');
  denied(await request(recipientWish(manual.id), { token: person.accessToken }), 404);
  const manualMapping = db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=?').get(manual.id);
  assert.ok(manualMapping.revoked_at);
  success(await request('/api/beneficiaries/' + person.id + '/restore-personal-wish-access', { method: 'POST', body: { confirmed: true } }));
  assert.deepEqual(success(await request(recipientWish(), { token: person.accessToken })).map(x => x.id), [person.final_wish_id]);
  assert.equal(success(await portal(person)).status, 'no_access');
  assert.deepEqual(db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=?').get(manual.id), manualMapping);
  assert.equal(db.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(person.id).access_granted, 0);
});

test('per-item revocation blocks downloads and acknowledgements and requires intentional personal restoration', async () => {
  const person = await beneficiary();
  const original = success(await request(ownerWish(person.final_wish_id)));
  success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: {
    metadata: { ...original.metadata, checklist: [{ id: 'revoked-step', text: 'Private revoked step' }] } } }));
  const doc = document(); await attach(person, doc);
  success(await request(ownerWish(person.final_wish_id) + '/revoke', { method: 'POST', body: { confirm: true } }));
  assert.deepEqual(success(await request(recipientWish(), { token: person.accessToken })), []);
  denied(await request(recipientWish(person.final_wish_id), { token: person.accessToken }), 404);
  denied(await request(recipientWish(person.final_wish_id) + '/attachments/' + doc + '/content', { token: person.accessToken }), 404);
  denied(await request(recipientWish(person.final_wish_id) + '/acknowledgements', { method: 'POST', token: person.accessToken,
    body: { step_id: 'revoked-step', acknowledged: true } }), 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_content_acknowledgements').get().n, 0);
  // Editing the content or granting the general vault does not clear an
  // intentional per-item revocation.
  success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: { title: 'Edited after revocation' } }));
  success(await request('/api/beneficiaries/' + person.id + '/grant', { method: 'POST', body: {} }));
  denied(await request(recipientWish(person.final_wish_id), { token: person.accessToken }), 404);
  success(await request('/api/beneficiaries/' + person.id + '/restore-personal-wish-access', { method: 'POST', body: { confirmed: true } }));
  assert.equal(success(await request(recipientWish(person.final_wish_id), { token: person.accessToken })).title, 'Edited after revocation');
});

test('a JSON-only historical origin cannot impersonate the database identity and corrupt mappings fail closed', async () => {
  const a = await beneficiary(), b = await beneficiary();
  const manual = await createManual({ beneficiary_ids: [a.id] });
  const row = db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(manual.id);
  const data = JSON.parse(decrypt(row.payload_encrypted));
  data.metadata.origin = { type: 'beneficiary', beneficiary_id: a.id };
  db.prepare('UPDATE legacy_contents SET payload_encrypted=? WHERE id=?').run(encrypt(JSON.stringify(data)), manual.id);
  denied(await request(recipientWish(manual.id), { token: a.accessToken }), 404);
  assert.deepEqual(success(await request(recipientWish(), { token: a.accessToken })).map(x => x.id), [a.final_wish_id]);
  db.prepare('DELETE FROM legacy_content_beneficiaries WHERE content_id=?').run(a.final_wish_id);
  assert.deepEqual(success(await request(recipientWish(), { token: a.accessToken })), []);
  denied(await request(recipientWish(a.final_wish_id), { token: a.accessToken }), 404);
  denied(await request(recipientWish(a.final_wish_id), { token: b.accessToken }), 404);
});

test('a historical edited private automatic wish is adopted without a new ID, payload rewrite, or broad vault grant', async () => {
  const person = await beneficiary();
  const original = success(await request(ownerWish(person.final_wish_id)));
  success(await request(ownerWish(person.final_wish_id), { method: 'PATCH', body: {
    body_markdown: 'HISTORICAL_OWNER_EDIT_TO_RETAIN', metadata: { ...original.metadata,
      final_wishes: { ...original.metadata.final_wishes, details: 'Retained private historical details' } } } }));
  // Removing only the additive marker recreates the exact pre-migration
  // relationship: encrypted owner-only draft with its original unique mapping.
  db.prepare('DELETE FROM legacy_beneficiary_auto_wishes WHERE beneficiary_id=?').run(person.id);
  const oldRow = db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(person.final_wish_id);
  const oldBeneficiary = db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(person.id);
  denied(await request(recipientWish(person.final_wish_id), { token: person.accessToken }), 404);
  const { backfillBeneficiaryFinalWishes } = require('../server/beneficiary-final-wishes');
  const repaired = backfillBeneficiaryFinalWishes(db);
  assert.equal(repaired.adopted, 1); assert.equal(repaired.created, 0);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(person.final_wish_id), oldRow);
  assert.deepEqual(db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(person.id), oldBeneficiary);
  const migrated = success(await request(recipientWish(person.final_wish_id), { token: person.accessToken }));
  assert.equal(migrated.id, oldRow.id); assert.equal(migrated.body_markdown, 'HISTORICAL_OWNER_EDIT_TO_RETAIN');
  assert.equal(migrated.status, 'draft'); assert.equal(migrated.release_policy, 'owner_only');
  const events = db.prepare('SELECT * FROM legacy_release_events ORDER BY id').all();
  for (let i = 0; i < 2; i++) {
    const repeated = backfillBeneficiaryFinalWishes(db);
    assert.equal(repeated.adopted, 0); assert.equal(repeated.created, 0);
  }
  assert.deepEqual(db.prepare('SELECT * FROM legacy_release_events ORDER BY id').all(), events);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM legacy_contents').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
  assert.equal(success(await portal(person)).status, 'no_access');
});

test('a removed beneficiary wish remains locked and archived until an explicit permanent owner deletion', async () => {
  const removed = await beneficiary();
  const active = await beneficiary();
  const original = success(await request(ownerWish(removed.final_wish_id)));
  success(await request(ownerWish(removed.final_wish_id), { method: 'PATCH', body: {
    body_markdown: 'REMOVED_BENEFICIARY_PRIVATE_CONTENT', metadata: { ...original.metadata,
      final_wishes: { ...original.metadata.final_wishes, details: 'Preserve until intentional deletion' } } } }));
  const doc = document(); await attach(removed, doc);
  const storedBefore = db.prepare('SELECT payload_encrypted,revision FROM legacy_contents WHERE id=?').get(removed.final_wish_id);
  success(await request('/api/beneficiaries/' + removed.id, { method: 'DELETE' }));
  const retired = success(await request(ownerWish(removed.final_wish_id)));
  assert.equal(retired.auto_generated, true);
  assert.equal(retired.auto_wish_retired, true);
  assert.equal(retired.status, 'archived');
  assert.equal(retired.locked_beneficiary.id, removed.id);
  assert.deepEqual(retired.beneficiary_ids, []);
  assert.deepEqual(db.prepare('SELECT payload_encrypted,revision FROM legacy_contents WHERE id=?').get(retired.id), storedBefore);
  const protectedState = snapshot(retired.id);
  for (const body of [
    { beneficiary_ids: [active.id] }, { beneficiary_ids: [] }, { status: 'draft' },
    { status: 'ready', release_policy: 'manual_release', beneficiary_ids: [active.id] },
    { metadata: { ...retired.metadata, origin: { type: 'beneficiary', beneficiary_id: active.id } } },
    { title: 'A retired wish must remain immutable' }
  ]) {
    denied(await request(ownerWish(retired.id), { method: 'PATCH', body }));
    assert.deepEqual(snapshot(retired.id), protectedState);
  }
  denied(await request(ownerWish(retired.id) + '/beneficiaries', { method: 'PUT', body: { beneficiary_ids: [active.id] } }));
  denied(await request(ownerWish(retired.id) + '/release', { method: 'POST', body: { confirm: true, beneficiary_ids: [active.id] } }));
  assert.deepEqual(snapshot(retired.id), protectedState);
  const attachmentState = db.prepare('SELECT * FROM legacy_content_attachments WHERE content_id=?').all(retired.id);
  const reviewState = db.prepare('SELECT * FROM legacy_content_reviews WHERE content_id=?').all(retired.id);
  denied(await request(ownerWish(retired.id) + '/attachments/' + doc, { method: 'DELETE' }), 409);
  for (const action of ['no_change', 'updated', 'reschedule', 'snooze', 'disable']) {
    denied(await request(ownerWish(retired.id) + '/review', { method: 'POST', body: {
      action, next_review_at: '2099-01-01', snooze_until: '2099-02-01' } }), 409);
  }
  assert.deepEqual(snapshot(retired.id), protectedState);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_content_attachments WHERE content_id=?').all(retired.id), attachmentState);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_content_reviews WHERE content_id=?').all(retired.id), reviewState);
  denied(await request(recipientWish(retired.id), { token: removed.accessToken }), 403);
  denied(await request(recipientWish(retired.id), { token: active.accessToken }), 404);
  denied(await request('/api/beneficiaries/' + removed.id + '/restore-personal-wish-access', { method: 'POST', body: { confirmed: true } }), 404);
  const ownerCopy = await request(ownerWish(retired.id) + '/attachments/' + doc + '/content');
  assert.equal(ownerCopy.status, 200); assert.equal(ownerCopy.text, 'PRIVATE_ATTACHMENT_BYTES');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_documents WHERE id=?').get(doc).n, 1);
  denied(await request(ownerWish(active.final_wish_id), { method: 'DELETE', body: { confirm_delete: true } }), 409);
  const deleted = success(await request(ownerWish(retired.id), { method: 'DELETE', body: { confirm_delete: true } }));
  assert.equal(deleted.deleted, true); assert.equal(deleted.id, retired.id);
  denied(await request(ownerWish(retired.id)), 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_documents WHERE id=?').get(doc).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM beneficiaries').get().n, 1);
  assert.deepEqual(success(await request(recipientWish(), { token: active.accessToken })).map(x => x.id), [active.final_wish_id]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});


test('automatic and manual parent record IDs respect current full-vault visibility', async () => {
  const person = await beneficiary();
  const manual = await createManual({ beneficiary_ids: [person.id], status: 'ready', release_policy: 'manual_release' });
  success(await request(ownerWish(manual.id) + '/release', { method: 'POST', body: { confirm: true } }));
  const parent = savedEntry({ section: 'final_wishes', title: 'HIDDEN_PARENT_RECORD', homebankId: 72 });
  // Simulate an earlier parent association whose source account has since
  // become hidden. This is a valid FK owned by the same user, not a forged ID.
  for (const id of [person.final_wish_id, manual.id]) {
    db.prepare('UPDATE legacy_contents SET final_wishes_entry_id=? WHERE id=?').run(parent, id);
  }
  assert.equal(success(await request(recipientWish(person.final_wish_id), { token: person.accessToken })).final_wishes_entry_id, null);
  grant(person);
  const listed = success(await request(recipientWish(), { token: person.accessToken }));
  for (const id of [person.final_wish_id, manual.id]) {
    assert.equal(listed.find(item => item.id === id).final_wishes_entry_id, null);
    const detail = success(await request(recipientWish(id), { token: person.accessToken }));
    assert.equal(detail.final_wishes_entry_id, null);
    assert.ok(!JSON.stringify(detail).includes('HIDDEN_PARENT_RECORD'));
  }
});
