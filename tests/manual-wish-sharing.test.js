'use strict';

// Atomic sharing is exercised only against synthetic memory SQLite and a
// loopback Express fixture. SMS/mail workers and production data are not used.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
process.env.ENCRYPTION_KEY = 'e2'.repeat(32);
process.env.JWT_SECRET = 'synthetic-manual-sharing-session-key';
process.env.AUTH_SMS_REQUIRED = 'true';
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.BACKGROUND_JOBS_ENABLED = 'false';
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';
const { hashToken } = require('../server/crypto');
const legacy = require('../server/legacy-content');
const { ensureBeneficiaryFinalWish } = require('../server/beneficiary-final-wishes');
const OWNER = 941, OTHER = 942;
let db, server, base, a, b, unassigned, foreign;
const tableRows = table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();
function snapshot() {
  return Object.fromEntries(['legacy_contents', 'legacy_content_beneficiaries', 'legacy_content_versions',
    'legacy_content_acknowledgements', 'legacy_release_events', 'audit_log', 'beneficiaries',
    'vault_entries', 'notification_outbox', 'sms_otp_challenges'].map(table => [table, tableRows(table)]));
}
function create(changes = {}) {
  return legacy.save(db, OWNER, { type: 'instruction', title: 'Synthetic private manual wish',
    body_markdown: 'An authored message to selected recipients.', beneficiary_ids: [a, b],
    metadata: { final_wishes: { category: 'Other', details: 'Keep these private authored details.' } }, ...changes });
}
const raw = id => db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(id);
const beneficiary = id => db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(id);
const mappings = id => db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? ORDER BY beneficiary_id').all(id);
const input = (wish, ids = [a]) => ({ confirm: true, expected_revision: wish.revision, beneficiary_ids: ids });
function modelDenied(callback) {
  assert.throws(callback, error => [400, 403, 404, 409].includes(error.status));
}
async function request(id, { owner = OWNER, body, token } = {}) {
  const authorization = token === null ? {} : { Authorization: 'Bearer ' + (token || jwt.sign({ id: owner,
    auth_version: 0, mfa: 'sms_otp' }, process.env.JWT_SECRET, { expiresIn: '5m' })) };
  const response = await fetch(base + '/api/final-wishes/legacy/' + encodeURIComponent(id) + '/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authorization }, body: JSON.stringify(body)
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}

before(async () => {
  db = new Database(':memory:');
  const cache = require.cache[require.resolve('better-sqlite3')], original = cache.exports;
  cache.exports = function FixtureDatabase(filename) {
    assert.equal(filename, path.resolve(__dirname, '../data/vault.db'), 'the application DB must be replaced by synthetic memory SQLite');
    return db;
  };
  try { assert.equal(require('../server/db').getDb(), db); } finally { cache.exports = original; }
  const insert = db.prepare(`INSERT INTO users(id,email,name,password_hash,sms_2fa_enabled,sms_2fa_phone_e164)
    VALUES(?,?,?,'synthetic-unused-password-hash',1,?)`);
  insert.run(OWNER, 'synthetic-sharing-owner@example.test', 'Synthetic sharing owner', '+27820000941');
  insert.run(OTHER, 'synthetic-sharing-other@example.test', 'Synthetic other owner', '+27820000942');
  const app = express(); app.use(express.json());
  app.locals.getDb = () => db;
  app.use('/api/final-wishes', require('../server/routes/legacy').ownerRouter);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fixture_share_failure;
    DELETE FROM legacy_contents; DELETE FROM beneficiaries; DELETE FROM vault_entries;
    DELETE FROM notification_outbox; DELETE FROM sms_otp_challenges; DELETE FROM audit_log;`);
  const insert = db.prepare(`INSERT INTO beneficiaries(user_id,name,access_token,token_expires_at,access_granted)
    VALUES(?,?,?,'2099-01-01T00:00:00.000Z',0)`);
  a = Number(insert.run(OWNER, 'Synthetic recipient A', hashToken('synthetic-share-a')).lastInsertRowid);
  b = Number(insert.run(OWNER, 'Synthetic recipient B', hashToken('synthetic-share-b')).lastInsertRowid);
  unassigned = Number(insert.run(OWNER, 'Synthetic unassigned recipient', hashToken('synthetic-share-unassigned')).lastInsertRowid);
  foreign = Number(insert.run(OTHER, 'Synthetic foreign recipient', hashToken('synthetic-share-foreign')).lastInsertRowid);
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (db?.open) db.close();
});

for (const status of ['draft', 'ready']) test(`sharing a ${status} owner-only manual wish releases only the confirmed selection and retains the authored payload`, () => {
  const wish = create({ status }), original = legacy.payload(raw(wish.id)), peopleBefore = tableRows('beneficiaries');
  const shared = legacy.shareNow(db, OWNER, wish.id, input(wish));
  assert.equal(shared.id, wish.id); assert.equal(shared.status, 'released'); assert.equal(shared.release_policy, 'manual_release');
  assert.equal(shared.revision, wish.revision + 1);
  assert.deepEqual(legacy.payload(raw(wish.id)), original, 'changing release policy preserves authored fields');
  assert.equal(shared.versions.length, 1); assert.equal(shared.versions[0].revision, wish.revision);
  const maps = mappings(wish.id); assert.ok(maps[0].released_at); assert.equal(maps[0].release_scope, 'manual_token_share');
  assert.equal(maps[1].released_at, null); assert.equal(maps[1].release_scope, null);
  assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), true);
  assert.equal(legacy.canRead(db, beneficiary(b), raw(wish.id)), false);
  assert.deepEqual(tableRows('beneficiaries'), peopleBefore, 'explicit content sharing never grants the ordinary vault');
  assert.equal(tableRows('notification_outbox').length, 0); assert.equal(tableRows('sms_otp_challenges').length, 0);
});

test('ready manual-release sharing avoids an unnecessary revision or ciphertext rewrite', () => {
  const wish = create({ status: 'ready', release_policy: 'manual_release' }), before = raw(wish.id);
  const shared = legacy.shareNow(db, OWNER, wish.id, input(wish));
  assert.equal(shared.revision, before.revision); assert.equal(raw(wish.id).payload_encrypted, before.payload_encrypted);
  assert.equal(tableRows('legacy_content_versions').length, 0); assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), true);
});

test('sharing additional recipients of released manual content preserves earlier release mappings and revision', () => {
  const wish = create({ status: 'ready', release_policy: 'manual_release' });
  const first = legacy.shareNow(db, OWNER, wish.id, input(wish, [a]));
  const original = raw(wish.id), firstMapping = mappings(wish.id).find(row => row.beneficiary_id === a);
  const beforeEvents = db.prepare('SELECT * FROM legacy_release_events WHERE content_id=? ORDER BY id').all(wish.id);
  const second = legacy.shareNow(db, OWNER, wish.id, input(first, [b]));
  assert.equal(second.revision, first.revision); assert.equal(raw(wish.id).payload_encrypted, original.payload_encrypted);
  assert.deepEqual(mappings(wish.id).find(row => row.beneficiary_id === a), firstMapping);
  assert.ok(mappings(wish.id).find(row => row.beneficiary_id === b).released_at);
  assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), true); assert.equal(legacy.canRead(db, beneficiary(b), raw(wish.id)), true);
  const afterEvents = db.prepare('SELECT * FROM legacy_release_events WHERE content_id=? ORDER BY id').all(wish.id);
  assert.deepEqual(afterEvents.slice(0, beforeEvents.length), beforeEvents);
  assert.ok(!afterEvents.slice(beforeEvents.length).some(event => event.event_type.includes('withdrawn')));
  assert.deepEqual(afterEvents.slice(beforeEvents.length).filter(event => event.event_type === 'released').map(event => event.beneficiary_id), [b]);
});

test('adding an explicitly shared recipient does not silently upgrade another recipient ordinary manual release', () => {
  const wish = create({ status: 'ready', release_policy: 'manual_release' });
  const previous = legacy.manualRelease(db, OWNER, wish.id, { confirm: true, beneficiary_ids: [a] });
  const ordinaryMapping = mappings(wish.id).find(row => row.beneficiary_id === a);
  assert.equal(ordinaryMapping.release_scope, 'manual_release');
  assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), false, 'ordinary manual release still requires broader vault approval');
  const shared = legacy.shareNow(db, OWNER, wish.id, input(previous, [b]));
  assert.deepEqual(mappings(wish.id).find(row => row.beneficiary_id === a), ordinaryMapping);
  assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), false);
  assert.equal(legacy.canRead(db, beneficiary(b), raw(wish.id)), true);
  assert.equal(mappings(wish.id).find(row => row.beneficiary_id === b).release_scope, 'manual_token_share');
  legacy.shareNow(db, OWNER, wish.id, input(shared, [a]));
  assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), true, 'a separate explicit share may upgrade the selected recipient only');
  assert.equal(beneficiary(a).access_granted, 0); assert.equal(beneficiary(b).access_granted, 0);
});

test('explicit sharing can convert an already released conditional wish while withdrawing its previous conditional recipients', () => {
  const wish = create({ status: 'ready', release_policy: 'dead_switch_release' });
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(a);
  legacy.releaseForEvent(db, { userId: OWNER, beneficiaryId: a, policy: 'dead_switch_release', eventKey: 'synthetic-prior-condition' });
  assert.equal(raw(wish.id).status, 'released');
  const originalPayload = legacy.payload(raw(wish.id)), peopleBefore = tableRows('beneficiaries');
  const current = { ...wish, revision: raw(wish.id).revision };
  const shared = legacy.shareNow(db, OWNER, wish.id, input(current, [b]));
  assert.equal(shared.status, 'released'); assert.equal(shared.release_policy, 'manual_release');
  assert.deepEqual(legacy.payload(raw(wish.id)), originalPayload);
  assert.equal(mappings(wish.id).find(row => row.beneficiary_id === a).released_at, null);
  assert.equal(mappings(wish.id).find(row => row.beneficiary_id === b).release_scope, 'manual_token_share');
  assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), false);
  assert.equal(legacy.canRead(db, beneficiary(b), raw(wish.id)), true);
  assert.deepEqual(tableRows('beneficiaries'), peopleBefore);
});

test('missing confirmation, unsafe/stale revision, empty selection and unassigned or foreign IDs make no writes', () => {
  const wish = create(), valid = input(wish), before = snapshot();
  for (const changes of [
    { confirm: false }, { confirm: 1 }, { expected_revision: undefined }, { expected_revision: String(wish.revision) },
    { expected_revision: wish.revision + 1 }, { expected_revision: Number.MAX_SAFE_INTEGER + 1 },
    { beneficiary_ids: [] }, { beneficiary_ids: undefined }, { beneficiary_ids: [String(a)] },
    { beneficiary_ids: [unassigned] }, { beneficiary_ids: [foreign] }, { beneficiary_ids: [a, foreign] }
  ]) {
    modelDenied(() => legacy.shareNow(db, OWNER, wish.id, { ...valid, ...changes }));
    assert.deepEqual(snapshot(), before);
  }
  legacy.save(db, OWNER, { body_markdown: 'An owner edit after the share dialog opened.' }, wish.id);
  const edited = snapshot(); modelDenied(() => legacy.shareNow(db, OWNER, wish.id, valid)); assert.deepEqual(snapshot(), edited);
});

test('automatic and archived wishes cannot be converted or shared through the manual action', () => {
  const automatic = ensureBeneficiaryFinalWish(db, OWNER, a), archived = create({ status: 'archived' });
  const before = snapshot();
  modelDenied(() => legacy.shareNow(db, OWNER, automatic.id, { confirm: true, expected_revision: 1, beneficiary_ids: [a] }));
  modelDenied(() => legacy.shareNow(db, OWNER, archived.id, input(archived)));
  assert.deepEqual(snapshot(), before);
});

for (const failure of ['policy', 'version', 'mapping', 'token-scope', 'audit']) test(`${failure} failure rolls back policy conversion, revision, recipient releases and audit as one transaction`, () => {
  const wish = create(), before = snapshot();
  const trigger = failure === 'policy' ? `AFTER UPDATE ON legacy_contents WHEN NEW.id='${wish.id}' AND NEW.release_policy='manual_release'` :
    failure === 'version' ? `AFTER INSERT ON legacy_content_versions WHEN NEW.content_id='${wish.id}'` :
    failure === 'mapping' ? `AFTER UPDATE ON legacy_content_beneficiaries WHEN NEW.content_id='${wish.id}' AND NEW.beneficiary_id=${b} AND NEW.released_at IS NOT NULL` :
    failure === 'token-scope' ? `AFTER UPDATE ON legacy_content_beneficiaries WHEN NEW.content_id='${wish.id}' AND NEW.release_scope='manual_token_share'` :
    `AFTER INSERT ON audit_log WHEN NEW.action='legacy_released'`;
  db.exec(`CREATE TRIGGER fixture_share_failure ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic share ${failure} failure'); END;`);
  assert.throws(() => legacy.shareNow(db, OWNER, wish.id, input(wish, [a, b])), new RegExp('synthetic share ' + failure + ' failure'));
  assert.deepEqual(snapshot(), before);
  db.exec('DROP TRIGGER fixture_share_failure');
  const shared = legacy.shareNow(db, OWNER, wish.id, input(wish, [a, b]));
  assert.equal(shared.status, 'released'); assert.equal(shared.revision, wish.revision + 1);
  assert.ok(mappings(wish.id).every(row => row.released_at));
});

test('authenticated sharing route converts and releases the same record without granting general access', async () => {
  const wish = create(), peopleBefore = tableRows('beneficiaries');
  const result = await request(wish.id, { body: input(wish) });
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.data.id, wish.id); assert.equal(result.data.status, 'released'); assert.equal(result.data.release_policy, 'manual_release');
  assert.equal(legacy.canRead(db, beneficiary(a), raw(wish.id)), true); assert.equal(legacy.canRead(db, beneficiary(b), raw(wish.id)), false);
  assert.deepEqual(tableRows('beneficiaries'), peopleBefore); assert.equal(tableRows('notification_outbox').length, 0);
});

test('sharing route requires an owner session and ignores forged body identities when resolving content ownership', async () => {
  const wish = create(), before = { content: raw(wish.id), maps: mappings(wish.id), versions: tableRows('legacy_content_versions') };
  assert.equal((await request(wish.id, { token: null, body: input(wish) })).status, 401);
  const outsider = await request(wish.id, { owner: OTHER, body: { ...input(wish), user_id: OWNER, owner_user_id: OWNER, sponsor_user_id: OWNER } });
  assert.equal(outsider.status, 404);
  const forgedRecipient = await request(wish.id, { body: input(wish, [foreign]) });
  assert.ok([400, 403, 404].includes(forgedRecipient.status));
  assert.deepEqual({ content: raw(wish.id), maps: mappings(wish.id), versions: tableRows('legacy_content_versions') }, before);
});

test('sharing route rejects stale revisions, archived content and automatic wishes with no target-state changes', async () => {
  const manual = create(), archived = create({ status: 'archived' }), automatic = ensureBeneficiaryFinalWish(db, OWNER, a);
  const before = { contents: tableRows('legacy_contents'), maps: tableRows('legacy_content_beneficiaries'), versions: tableRows('legacy_content_versions') };
  for (const [id, body] of [[manual.id, { ...input(manual), expected_revision: manual.revision + 1 }],
    [archived.id, input(archived)], [automatic.id, { confirm: true, expected_revision: 1, beneficiary_ids: [a] }]]) {
    const result = await request(id, { body }); assert.ok([400, 403, 409].includes(result.status));
  }
  assert.deepEqual({ contents: tableRows('legacy_contents'), maps: tableRows('legacy_content_beneficiaries'), versions: tableRows('legacy_content_versions') }, before);
});
