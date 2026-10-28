'use strict';

// Independent security checks use an in-memory vault and a private disposable
// media root. No deployed database, personal file or email transport is used.
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

process.env.ENCRYPTION_KEY = '71'.repeat(32);
process.env.JWT_SECRET = 'synthetic-legacy-security-jwt-secret';
process.env.NOTIFICATION_SECRET = '72'.repeat(32);
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';
process.env.NOTIFICATIONS_ENABLED = 'false';
const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-legacy-security-'));
fs.chmodSync(mediaRoot, 0o700);
process.env.DOCUMENT_STORAGE_ROOT = mediaRoot;

const OWNER = 901, OTHER = 902;
const TOKEN_A = 'synthetic-beneficiary-a-token', TOKEN_B = 'synthetic-beneficiary-b-token';
const { hashToken, encrypt } = require('../server/crypto');
let db, server, base, a, b, oldEntry, foreignEntry;

async function request(route, { method = 'GET', body, owner = OWNER, beneficiary, headers = {} } = {}) {
  const auth = beneficiary === null ? {} : {
    Authorization: 'Bearer ' + (beneficiary || jwt.sign({ id: owner }, process.env.JWT_SECRET, { expiresIn: '5m' }))
  };
  const response = await fetch(base + route, {
    method, headers: { ...auth, 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers, text };
}
function successful(result) {
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.data;
}
function denied(result) { assert.ok([400, 401, 403, 404, 409].includes(result.status), JSON.stringify(result)); }
async function create(fields = {}) {
  return successful(await request('/api/final-wishes/legacy', { method: 'POST', body: {
    type: 'letter', title: 'Synthetic private title', body_markdown: 'Synthetic private body', ...fields
  } }));
}
async function release(item, ids = [a]) {
  return request(`/api/final-wishes/legacy/${item.id}/release`, {
    method: 'POST', body: { confirm: true, beneficiary_ids: ids }
  });
}
async function beneficiaryList(token = TOKEN_A, suffix = '') {
  return request('/api/beneficiary-access/legacy' + suffix, { beneficiary: token });
}
async function legacyVault(token = TOKEN_A) {
  return request('/api/beneficiaries/access', { method: 'POST', body: { accessToken: token }, beneficiary: null });
}
function grant(id) { db.prepare('UPDATE beneficiaries SET access_granted=1,access_granted_at=? WHERE id=?').run(new Date().toISOString(), id); }
function managedDocument(bytes = Buffer.from('PRIVATE_MANAGED_DOCUMENT_BYTES')) {
  const store = require('../server/document-store');
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(store.ownerDirectory(OWNER), id + '.txt'), bytes, { mode: 0o600 });
  db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,stored_filename,mime_type,size_bytes,sha256,legacy_restricted)
    VALUES(?,?,?,?,?,'text/plain',?,?,1)`).run(id, OWNER, encrypt('private.txt'), encrypt('private.txt'), `owner-${OWNER}/${id}.txt`, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'));
  return id;
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
  insert.run(OWNER, 'synthetic-owner@example.test', 'Synthetic owner', 'synthetic-hash');
  insert.run(OTHER, 'synthetic-other@example.test', 'Synthetic other', 'synthetic-hash');
  db.prepare('INSERT INTO dead_switch_config(user_id) VALUES(?)').run(OWNER);
  const app = express(); app.use(express.json());
  const routes = require('../server/routes/legacy');
  app.use('/api/final-wishes', routes.ownerRouter);
  app.use('/api/beneficiary-access', routes.beneficiaryRouter);
  app.use('/api/beneficiaries', require('../server/routes/beneficiaries'));
  app.use('/api/documents', require('../server/routes/documents'));
  app.use('/api/vault', require('../server/routes/vault'));
  app.use('/api/deadswitch', require('../server/routes/deadswitch'));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Synthetic request failed' }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  db.exec('DROP TRIGGER IF EXISTS fixture_legacy_audit_failure; DELETE FROM legacy_contents; DELETE FROM notification_outbox; DELETE FROM beneficiaries; DELETE FROM vault_entries;');
  db.prepare('UPDATE dead_switch_config SET switch_triggered=0,switch_triggered_at=NULL,is_active=0 WHERE user_id=?').run(OWNER);
  const insert = db.prepare(`INSERT INTO beneficiaries(user_id,name,access_token,token_expires_at)
    VALUES(?,?,?,'2099-01-01T00:00:00.000Z')`);
  a = Number(insert.run(OWNER, 'Synthetic beneficiary A', hashToken(TOKEN_A)).lastInsertRowid);
  b = Number(insert.run(OWNER, 'Synthetic beneficiary B', hashToken(TOKEN_B)).lastInsertRowid);
  oldEntry = Number(db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,?,?,?)')
    .run(OWNER, 'final_wishes', 'Legacy wishes', encrypt(JSON.stringify({ category: 'Other', details: 'Preserved legacy details', contact_person: 'Contact', contact_phone: '000' }))).lastInsertRowid);
  foreignEntry = Number(db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,?,?,?)')
    .run(OTHER, 'property', 'Foreign property', encrypt('{}')).lastInsertRowid);
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db?.open) db.close();
  fs.rmSync(mediaRoot, { recursive: true, force: true });
});

test('every new content group defaults private and stays outside the full-vault serializer', async () => {
  grant(a); grant(b);
  for (const type of ['letter', 'recording', 'family_history', 'instruction', 'review']) {
    const item = await create({ type, title: `PRIVATE_${type}_TITLE`, body_markdown: `PRIVATE_${type}_BODY` });
    assert.equal(item.status, 'draft'); assert.equal(item.release_policy, 'owner_only');
    denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  }
  assert.deepEqual(successful(await beneficiaryList()), []);
  const old = successful(await legacyVault());
  assert.equal(old.status, 'granted'); assert.equal(old.entries.length, 1);
  assert.equal(old.entries[0].fields.details, 'Preserved legacy details');
  assert.ok(!JSON.stringify(old).includes('PRIVATE_'));
});

test('manual releases require readiness, owner confirmation, explicit recipients and current general access', async () => {
  const item = await create({ beneficiary_ids: [a], release_policy: 'manual_release' });
  denied(await release(item));
  successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { status: 'ready' } }));
  denied(await request(`/api/final-wishes/legacy/${item.id}/release`, { method: 'POST', body: { beneficiary_ids: [a] } }));
  denied(await release(item, [b]));
  successful(await release(item));
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  grant(a); grant(b);
  assert.equal(successful(await beneficiaryList(TOKEN_A, '/' + item.id)).id, item.id);
  denied(await beneficiaryList(TOKEN_B, '/' + item.id));
  assert.deepEqual(successful(await beneficiaryList(TOKEN_B)), []);
});

test('recipient identity comes only from the existing token and cannot be overridden by query/body', async () => {
  grant(a); grant(b);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [b] });
  successful(await release(item, [b]));
  assert.deepEqual(successful(await beneficiaryList(TOKEN_A, `?beneficiary_id=${b}`)), []);
  denied(await request(`/api/beneficiary-access/legacy/${item.id}?beneficiary_id=${b}`, { beneficiary: TOKEN_A }));
  denied(await request(`/api/beneficiary-access/legacy/${item.id}`, { beneficiary: null }));
  denied(await request(`/api/beneficiary-access/legacy/${item.id}`, { beneficiary: 'unknown-synthetic-token' }));
});

test('owner-only policy never releases and owner APIs reject foreign owner/beneficiary/link IDs', async () => {
  const item = await create({ status: 'ready', beneficiary_ids: [a] });
  denied(await release(item));
  denied(await request('/api/final-wishes/legacy/' + item.id, { owner: OTHER }));
  denied(await request('/api/final-wishes/legacy/' + item.id, { owner: OTHER, method: 'PATCH', body: { title: 'stolen' } }));
  denied(await request('/api/final-wishes/legacy/' + item.id, { owner: OTHER, method: 'DELETE' }));
  denied(await request('/api/final-wishes/legacy', { method: 'POST', body: { type: 'letter', title: 'foreign link', links: [{ entry_id: foreignEntry }] } }));
  denied(await request('/api/final-wishes/legacy', { method: 'POST', body: { type: 'letter', title: 'foreign parent', final_wishes_entry_id: foreignEntry } }));
  denied(await request(`/api/final-wishes/legacy/${item.id}/beneficiaries`, { method: 'PUT', body: { beneficiary_ids: [999999] } }));
});

test('expiry, token regeneration and global revocation prevent reads of previously released content', async () => {
  grant(a);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [a] });
  successful(await release(item));
  db.prepare("UPDATE beneficiaries SET token_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(a);
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  db.prepare("UPDATE beneficiaries SET token_expires_at='2099-01-01T00:00:00Z' WHERE id=?").run(a);
  successful(await request(`/api/beneficiaries/${a}/regenerate-token`, { method: 'POST', body: {} }));
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  db.prepare('UPDATE beneficiaries SET access_token=? WHERE id=?').run(hashToken(TOKEN_A), a);
  successful(await request(`/api/beneficiaries/${a}/revoke`, { method: 'POST', body: {} }));
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
});

test('new item revocation survives the baseline triggered-switch automatic regrant', async () => {
  grant(a);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [a] });
  successful(await release(item));
  db.prepare('UPDATE dead_switch_config SET switch_triggered=1,switch_triggered_at=? WHERE user_id=?').run(new Date().toISOString(), OWNER);
  successful(await request(`/api/beneficiaries/${a}/revoke`, { method: 'POST', body: {} }));
  assert.equal(successful(await legacyVault()).status, 'granted', 'old vault grant behavior stays compatible');
  assert.equal(db.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(a).access_granted, 1);
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  assert.deepEqual(successful(await beneficiaryList()), []);
});

test('archiving a released item and removing its recipient immediately hide it', async () => {
  grant(a);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [a, b] });
  successful(await release(item));
  successful(await request(`/api/final-wishes/legacy/${item.id}/beneficiaries`, { method: 'PUT', body: { beneficiary_ids: [b] } }));
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  successful(await request('/api/final-wishes/legacy/' + item.id, { method: 'DELETE' }));
  assert.equal(successful(await request('/api/final-wishes/legacy/' + item.id)).status, 'archived');
  grant(b); denied(await beneficiaryList(TOKEN_B, '/' + item.id));
});

test('late check-in preserves releases and review actions never perform a check-in', async () => {
  grant(a);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [a], review_enabled: true, review_interval_months: 6, next_review_at: '2026-01-01T00:00:00.000Z' });
  successful(await release(item));
  const before = db.prepare('SELECT last_check_in FROM users WHERE id=?').get(OWNER).last_check_in;
  const switchBefore = db.prepare('SELECT * FROM dead_switch_config WHERE user_id=?').get(OWNER);
  successful(await request(`/api/final-wishes/legacy/${item.id}/review`, { method: 'POST', body: { action: 'no_change' } }));
  assert.equal(db.prepare('SELECT last_check_in FROM users WHERE id=?').get(OWNER).last_check_in, before);
  assert.deepEqual(db.prepare('SELECT * FROM dead_switch_config WHERE user_id=?').get(OWNER), switchBefore);
  successful(await request('/api/deadswitch/checkin', { method: 'POST', body: {} }));
  assert.equal(successful(await beneficiaryList(TOKEN_A, '/' + item.id)).id, item.id);
});

test('enabling a periodic review without an explicit date schedules its first review', async () => {
  const started = Date.now();
  const item = await create({ review_enabled: true, review_interval_months: 6 });
  assert.equal(item.review_enabled, true);
  const next = new Date(item.next_review_at), today = new Date(started);
  assert.ok(Number.isFinite(next.getTime()) && next.getTime() > started);
  assert.equal((next.getUTCFullYear() - today.getUTCFullYear()) * 12 + next.getUTCMonth() - today.getUTCMonth(), 6);
  assert.ok(next.getUTCDate() <= today.getUTCDate());
  assert.equal(item.review_state, 'current');
});

test('archive calendar dates and review timestamps reject normalization of impossible dates', async () => {
  for (const event_date of ['2026-99-99', '2025-02-29', '2024-02-30', '1985-00', '1985-13', '1985-04-31']) {
    assert.equal((await request('/api/final-wishes/legacy', { method: 'POST', body: {
      type: 'family_history', title: 'Invalid synthetic date', metadata: { event_date }
    } })).status, 400);
  }
  for (const next_review_at of ['2025-02-31', '2025-02-31T00:00:00Z', '2025-01-01T24:00:00Z']) {
    assert.equal((await request('/api/final-wishes/legacy', { method: 'POST', body: {
      type: 'review', title: 'Invalid synthetic review date', next_review_at
    } })).status, 400);
  }
  assert.equal((await create({ type: 'family_history', metadata: { event_date: '2024-02-29' } })).metadata.event_date, '2024-02-29');
});

test('archive searches match owner-supplied people/tags and overlap approximate year/month ranges', async () => {
  const year = await create({ type: 'family_history', metadata: { event_date: '1985', date_precision: 'approximate', people: ['Alex Synthetic'], tags: ['family'] } });
  const month = await create({ type: 'family_history', metadata: { event_date: '1985-02', date_precision: 'approximate', people: ['Alex Synthetic'], tags: ['family'] } });
  await create({ type: 'family_history', metadata: { date_precision: 'unknown', people: ['Alex Synthetic'], tags: ['family'] } });
  await create({ type: 'family_history', metadata: { event_date: '1984-02-01', people: ['Alex Synthetic'], tags: ['family'] } });
  const found = successful(await request('/api/final-wishes/legacy?q=Alex%20Synthetic&from=1985-02-01&to=1985-02-28'));
  assert.deepEqual(found.map(item => item.id).sort(), [year.id, month.id].sort());
  assert.equal(successful(await request('/api/final-wishes/legacy?q=family')).length, 4);
  for (const suffix of ['?from=1985-02-30', '?to=not-a-date', '?from=1985-03-01&to=1985-02-01']) {
    assert.equal((await request('/api/final-wishes/legacy' + suffix)).status, 400);
  }
});

test('foreign-owner mutations preserve denial audits after their transactions roll back', async () => {
  const item = await create();
  const cases = [
    ['PATCH', '', { title: 'Forbidden private text' }], ['DELETE', '', undefined],
    ['POST', '/release', { confirm: true }], ['PUT', '/beneficiaries', { beneficiary_ids: [a] }],
    ['POST', '/review', { action: 'no_change' }], ['POST', '/revoke', { confirm: true }]
  ];
  for (const [method, suffix, body] of cases) {
    const before = db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE event_type='access_denied' AND user_id=?").get(OTHER).n;
    assert.equal((await request(`/api/final-wishes/legacy/${item.id}${suffix}`, { method, body, owner: OTHER })).status, 404);
    const after = db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE event_type='access_denied' AND user_id=?").get(OTHER).n;
    assert.ok(after > before, method + suffix + ' must durably audit the denial');
  }
  const before = db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE event_type='owner_auth_denied'").get().n;
  assert.equal((await request('/api/final-wishes/legacy', { beneficiary: null })).status, 401);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE event_type='owner_auth_denied'").get().n > before);
  assert.equal(successful(await request('/api/final-wishes/legacy/' + item.id)).title, item.title);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM legacy_release_events').all()).includes('Forbidden private text'));
});

test('only a confirmed switch deadline releases its ready items; reminders and late check-in are independent', async () => {
  const ready = await create({ status: 'ready', release_policy: 'dead_switch_release', beneficiary_ids: [a] });
  const draft = await create({ release_policy: 'dead_switch_release', beneficiary_ids: [a] });
  const emergency = await create({ status: 'ready', release_policy: 'emergency_access_release', beneficiary_ids: [a] });
  const manual = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [a] });
  const service = require('../server/notifications/service').createNotificationService({ db });
  db.prepare('UPDATE dead_switch_config SET is_active=1 WHERE user_id=?').run(OWNER);
  db.prepare('UPDATE users SET last_check_in=? WHERE id=?').run(new Date().toISOString(), OWNER);
  service.reconcile();
  assert.equal(service.releaseDue(), 0);
  assert.equal(db.prepare('SELECT access_granted FROM beneficiaries WHERE id=?').get(a).access_granted, 0);
  db.prepare("UPDATE users SET last_check_in='2000-01-01T00:00:00Z' WHERE id=?").run(OWNER);
  assert.equal(service.releaseDue(), 1);
  assert.deepEqual(successful(await beneficiaryList()).map(item => item.id), [ready.id]);
  for (const item of [draft, emergency, manual]) denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  assert.equal(service.releaseDue(), 0);
  const releasedEvents = db.prepare("SELECT COUNT(*) n FROM legacy_release_events WHERE content_id=? AND event_type='released'").get(ready.id).n;
  assert.equal(releasedEvents, 1);
  successful(await request('/api/deadswitch/checkin', { method: 'POST', body: {} }));
  assert.equal(successful(await beneficiaryList(TOKEN_A, '/' + ready.id)).id, ready.id);
});

test('emergency requests never release early and the actual elapsed grant releases only opted-in items', async () => {
  const emergency = await create({ status: 'ready', release_policy: 'emergency_access_release', beneficiary_ids: [a] });
  const switchItem = await create({ status: 'ready', release_policy: 'dead_switch_release', beneficiary_ids: [a] });
  const draft = await create({ release_policy: 'emergency_access_release', beneficiary_ids: [a] });
  successful(await request('/api/beneficiaries/emergency-access', { method: 'POST', body: { accessToken: TOKEN_A }, beneficiary: null }));
  assert.equal(successful(await legacyVault()).status, 'waiting');
  denied(await beneficiaryList(TOKEN_A, '/' + emergency.id));
  db.prepare('UPDATE beneficiaries SET emergency_access_requested_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), a);
  assert.equal(successful(await legacyVault()).status, 'granted');
  assert.equal(successful(await beneficiaryList(TOKEN_A, '/' + emergency.id)).id, emergency.id);
  denied(await beneficiaryList(TOKEN_A, '/' + switchItem.id));
  denied(await beneficiaryList(TOKEN_A, '/' + draft.id));
});

test('editing released text withdraws the old grant until another explicit release', async () => {
  grant(a);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [a] });
  successful(await release(item));
  const edited = successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { body_markdown: 'New private revision' } }));
  assert.equal(edited.status, 'draft');
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { status: 'ready' } }));
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  successful(await release(item));
  assert.equal(successful(await beneficiaryList(TOKEN_A, '/' + item.id)).body_markdown, 'New private revision');
});

test('a failed durable release audit rolls back the release and recipient permissions', async () => {
  grant(a);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [a] });
  db.exec(`CREATE TRIGGER fixture_legacy_audit_failure BEFORE INSERT ON audit_log
    WHEN NEW.action='legacy_released' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;`);
  assert.equal((await release(item)).status, 500);
  assert.equal(db.prepare('SELECT released_at FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(item.id, a).released_at, null);
  assert.equal(db.prepare('SELECT status FROM legacy_contents WHERE id=?').get(item.id).status, 'ready');
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
});

test('personal titles, narrative, people, checklists and revisions are encrypted at rest', async () => {
  const secret = 'SYNTHETIC_CONTENT_ENCRYPTION_MARKER_4509';
  const item = await create({ title: secret + '_TITLE', body_markdown: secret + '_BODY', metadata: { people: [secret + '_PERSON'], checklist: [{ id: 'one', text: secret + '_STEP' }] } });
  successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { body_markdown: secret + '_REVISION' } }));
  assert.equal(db.serialize().includes(Buffer.from(secret)), false);
  const detail = successful(await request('/api/final-wishes/legacy/' + item.id));
  assert.equal(detail.body_markdown, secret + '_REVISION');
  assert.ok(detail.versions.length >= 1);
});

test('safe Markdown renderer never constructs executable HTML or remote tracking images', () => {
  const { renderMarkdown } = require('../server/legacy-markdown');
  const unsafe = '<script>alert(1)</script>\n<img src="https://tracker.example.test/a" onerror="alert(1)">\n[x](javascript:alert)\n![pixel](https://tracker.example.test/pixel)\n[x](data:text/html,bad)';
  const html = renderMarkdown(unsafe);
  assert.ok(!/<script|<img|onerror\s*=\s*["']?[^&]|href=["'](?:javascript|data):/i.test(html), html);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(renderMarkdown('**Safe** [link](https://example.test)').includes('<strong>Safe</strong>'));
});

test('restricted files cannot escape through old vault document metadata or the old binary endpoint', async () => {
  grant(a); grant(b);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [b] });
  const documentId = managedDocument();
  successful(await request(`/api/final-wishes/legacy/${item.id}/attachments`, { method: 'POST', body: { document_id: documentId } }));
  // Defense in depth: even a preexisting broad association cannot turn a
  // restricted attachment into a globally readable legacy document.
  db.prepare('INSERT INTO document_associations(document_id,entry_id) VALUES(?,?)').run(documentId, oldEntry);
  const old = successful(await legacyVault());
  assert.ok(!JSON.stringify(old).includes(documentId));
  denied(await request('/api/documents/beneficiary/content', { method: 'POST', beneficiary: null,
    body: { accessToken: TOKEN_A, documentId, mode: 'preview' } }));
  denied(await request(`/api/final-wishes/legacy/${item.id}/attachments/${documentId}/content`, { owner: OTHER }));
  denied(await request(`/api/beneficiary-access/legacy/${item.id}/attachments/${documentId}/content`, { beneficiary: TOKEN_A }));
});

test('generic document metadata edits cannot silently change a released protected attachment', async () => {
  grant(a);
  const item = await create({ release_policy: 'manual_release', beneficiary_ids: [a] }), documentId = managedDocument();
  successful(await request(`/api/final-wishes/legacy/${item.id}/attachments`, { method: 'POST', body: { document_id: documentId } }));
  successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { status: 'ready' } }));
  successful(await release(item));
  const before = successful(await beneficiaryList(TOKEN_A, '/' + item.id));
  assert.equal((await request(`/api/documents/${documentId}`, { method: 'PATCH', body: {
    display_name: 'NEW_PRIVATE_ATTACHMENT_TITLE', description: 'NEW_PRIVATE_ATTACHMENT_DESCRIPTION'
  } })).status, 409);
  const after = successful(await beneficiaryList(TOKEN_A, '/' + item.id));
  assert.deepEqual(after.attachments, before.attachments);
  assert.ok(!JSON.stringify(after).includes('NEW_PRIVATE_ATTACHMENT'));
});

test('several recipients share one managed file; recipient removal leaves owner content and file intact', async () => {
  grant(a); grant(b);
  const item = await create({ release_policy: 'manual_release', beneficiary_ids: [a, b] });
  const documentId = managedDocument();
  successful(await request(`/api/final-wishes/legacy/${item.id}/attachments`, { method: 'POST', body: { document_id: documentId } }));
  successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { status: 'ready' } }));
  successful(await release(item, [a, b]));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_content_attachments WHERE content_id=?').get(item.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_documents WHERE id=?').get(documentId).n, 1);
  successful(await request(`/api/beneficiaries/${a}`, { method: 'DELETE' }));
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  assert.equal(successful(await beneficiaryList(TOKEN_B, '/' + item.id)).attachments[0].id, documentId);
  assert.equal(successful(await request(`/api/final-wishes/legacy/${item.id}`)).id, item.id);
  assert.ok(fs.existsSync(require('../server/document-store').diskPath(`owner-${OWNER}/${documentId}.txt`)));
  successful(await request(`/api/final-wishes/legacy/${item.id}/attachments/${documentId}`, { method: 'DELETE' }));
  assert.ok(db.prepare('SELECT 1 FROM managed_documents WHERE id=?').get(documentId));
  assert.ok(fs.existsSync(require('../server/document-store').diskPath(`owner-${OWNER}/${documentId}.txt`)));
  assert.equal(db.prepare('SELECT legacy_restricted FROM managed_documents WHERE id=?').get(documentId).legacy_restricted, 1);
  denied(await request(`/api/documents/${documentId}/associate`, { method: 'POST', body: { entryId: oldEntry } }));
  denied(await request('/api/documents/beneficiary/content', { method: 'POST', beneficiary: null,
    body: { accessToken: TOKEN_B, documentId, mode: 'preview' } }));
});

test('attachment ranges reevaluate grants and per-item permissions for every request', async () => {
  grant(a); grant(b);
  const bytes = Buffer.from('0123456789');
  const documentId = managedDocument(bytes);
  const item = await create({ release_policy: 'manual_release', beneficiary_ids: [a] });
  successful(await request(`/api/final-wishes/legacy/${item.id}/attachments`, { method: 'POST', body: { document_id: documentId } }));
  const route = `/api/beneficiary-access/legacy/${item.id}/attachments/${documentId}/content`;
  denied(await request(route, { beneficiary: TOKEN_A, headers: { Range: 'bytes=2-5' } }));
  successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { status: 'ready' } }));
  successful(await release(item));
  const partial = await request(route, { beneficiary: TOKEN_A, headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206); assert.equal(partial.text, '2345');
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(partial.headers.get('cache-control'), 'private, no-store');
  const suffix = await request(route, { beneficiary: TOKEN_A, headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206); assert.equal(suffix.text, '789');
  assert.equal((await request(route, { beneficiary: TOKEN_A, headers: { Range: 'bytes=99-' } })).status, 416);
  assert.equal((await request(route, { beneficiary: TOKEN_A, headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
  assert.equal((await request(route, { beneficiary: TOKEN_A, headers: { Range: 'bytes=-9999999999999999999999999999' } })).status, 416);
  denied(await request(route, { beneficiary: TOKEN_B, headers: { Range: 'bytes=2-5' } }));
  successful(await request(`/api/final-wishes/legacy/${item.id}/revoke`, { method: 'POST', body: { confirm: true, beneficiary_ids: [a] } }));
  denied(await request(route, { beneficiary: TOKEN_A, headers: { Range: 'bytes=2-5' } }));
});

test('checklist acknowledgements require item access and never edit owner instructions', async () => {
  grant(a); grant(b);
  const item = await create({ type: 'instruction', release_policy: 'manual_release', beneficiary_ids: [a],
    metadata: { checklist: [{ id: 'water', text: 'Water the synthetic plants' }, { id: 'lock', text: 'Lock the synthetic gate' }] } });
  const route = `/api/beneficiary-access/legacy/${item.id}/acknowledgements`;
  denied(await request(route, { beneficiary: TOKEN_A, method: 'POST', body: { step_id: 'water', acknowledged: true } }));
  successful(await request(`/api/final-wishes/legacy/${item.id}`, { method: 'PATCH', body: { status: 'ready' } }));
  successful(await release(item));
  const before = successful(await request('/api/final-wishes/legacy/' + item.id));
  denied(await request(route, { beneficiary: TOKEN_B, method: 'POST', body: { step_id: 'water', acknowledged: true } }));
  denied(await request(route, { beneficiary: TOKEN_A, method: 'POST', body: { step_id: 'invented', acknowledged: true } }));
  successful(await request(route, { beneficiary: TOKEN_A, method: 'POST', body: { step_id: 'water', acknowledged: true } }));
  const after = successful(await request('/api/final-wishes/legacy/' + item.id));
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.revision, before.revision);
  assert.ok(successful(await beneficiaryList(TOKEN_A, '/' + item.id)).acknowledgements.some(x => x.step_id === 'water' && x.acknowledged));
});

test('denials are scoped and sanitized, and release event history is append-only', async () => {
  grant(a); grant(b);
  const item = await create({ status: 'ready', release_policy: 'manual_release', beneficiary_ids: [b], body_markdown: 'PRIVATE_AUDIT_BODY_MARKER' });
  successful(await release(item, [b]));
  denied(await beneficiaryList(TOKEN_A, '/' + item.id));
  const events = db.prepare('SELECT * FROM legacy_release_events WHERE content_id=?').all(item.id);
  assert.ok(events.length >= 2);
  assert.ok(events.every(event => event.user_id === OWNER));
  assert.ok(!JSON.stringify(events).includes(TOKEN_A));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_AUDIT_BODY_MARKER'));
  assert.throws(() => db.prepare('UPDATE legacy_release_events SET event_type=? WHERE content_id=?').run('tampered', item.id));
  assert.throws(() => db.prepare('DELETE FROM legacy_release_events WHERE content_id=?').run(item.id));
});
