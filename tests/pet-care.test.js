'use strict';

// Synthetic records only. Run real routers against an in-memory database without
// opening sockets, loading .env, reading managed files, or starting mail workers.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

process.env.ENCRYPTION_KEY = '81'.repeat(32);
process.env.JWT_SECRET = 'synthetic-pet-care-jwt-secret';
process.env.NOTIFICATION_SECRET = '82'.repeat(32);
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.HOMEBANK_OWNER_EMAIL = 'unused-homebank-owner@example.test';

const OWNER = 901, OTHER = 902;
const BENEFICIARY_TOKEN = 'synthetic-pet-care-beneficiary-token';
const PRIVATE_MARKER = 'SYNTHETIC_PET_CARE_PRIVATE_4621';
const PET = {
  section: 'pet_care', title: 'Milo — care and rehoming',
  fields: {
    pet_name: 'Milo', species: 'Cat', breed: 'Domestic shorthair',
    date_of_birth: '2020-02-29', microchip_number: '900000000000001',
    vet_name: 'Synthetic Animal Clinic', vet_phone: '+27 00 000 0000',
    vet_address: '1 Fixture Road\nSynthetic Town',
    dietary_needs: 'Measured wet food twice daily; no chicken.',
    medications: 'Follow the labelled veterinary prescription in the kitchen folder.',
    care_instructions: PRIVATE_MARKER + '\nKeep indoors. Carrier is in the hall cupboard.',
    preferred_carer: 'Alex Fixture', carer_phone: '+27 00 000 0001',
    rehoming_plan: 'Ask Alex first. If unavailable, contact the named rescue with Milo’s records.'
  },
  notes: PRIVATE_MARKER + '\nVaccination records are kept with the carrier.'
};
let db, routers, beneficiaryId;

function request(route, { method = 'GET', body, owner = OWNER, auth = true, token, status = 200 } = {}) {
  const prefix = Object.keys(routers).find(value => route.startsWith(value + '/') || route === value);
  assert.ok(prefix, 'Fixture route must be explicitly mounted');
  const url = new URL(route.slice(prefix.length) || '/', 'http://fixture.invalid');
  return new Promise((resolve, reject) => {
    const req = {
      method, url: url.pathname + url.search, originalUrl: route,
      query: Object.fromEntries(url.searchParams), body: body || {}, ip: '127.0.0.1',
      headers: auth ? { authorization: 'Bearer ' + (token || jwt.sign({ id: owner }, process.env.JWT_SECRET)) } : {}
    };
    const res = {
      statusCode: 200,
      set() { return this; },
      status(value) { this.statusCode = value; return this; },
      json(data) {
        try {
          assert.equal(this.statusCode, status, `${method} ${route}: ${JSON.stringify(data)}`);
          resolve(data);
        } catch (error) { reject(error); }
        return this;
      }
    };
    routers[prefix].handle(req, res, error => reject(error || new Error('Unmatched fixture route: ' + route)));
  });
}

function create(overrides = {}, owner = OWNER) {
  return request('/api/vault/entries', { method: 'POST', body: { ...PET, ...overrides }, owner });
}
function recipientAccess(accessToken = BENEFICIARY_TOKEN, status = 200) {
  return request('/api/beneficiaries/access', { method: 'POST', auth: false, body: { accessToken }, status });
}
function assertEncrypted(id) {
  const stored = db.prepare('SELECT fields_encrypted, notes_encrypted FROM vault_entries WHERE id=?').get(id);
  assert.ok(stored.fields_encrypted && stored.notes_encrypted);
  assert.equal(JSON.stringify(stored).includes(PRIVATE_MARKER), false);
  assert.equal(db.serialize().includes(Buffer.from(PRIVATE_MARKER)), false);
}

before(() => {
  db = new Database(':memory:');
  const cache = require.cache[require.resolve('better-sqlite3')], original = cache.exports;
  cache.exports = function FixtureDatabase(filename) {
    assert.equal(filename, path.resolve(__dirname, '../data/vault.db'));
    return db;
  };
  try { assert.equal(require('../server/db').getDb(), db); } finally { cache.exports = original; }
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)');
  insert.run(OWNER, 'synthetic-pet-owner@example.test', 'Synthetic pet owner', 'synthetic-hash');
  insert.run(OTHER, 'synthetic-other@example.test', 'Synthetic other owner', 'synthetic-hash');
  // Fail rather than reading a source directory if a request unexpectedly syncs.
  require('../server/homebank-service').syncUser = async () => { throw new Error('Unexpected HomeBank sync'); };
  routers = {
    '/api/vault': require('../server/routes/vault'),
    '/api/beneficiaries': require('../server/routes/beneficiaries')
  };
});

beforeEach(() => {
  db.exec('DELETE FROM notification_outbox; DELETE FROM beneficiaries; DELETE FROM vault_entries; DELETE FROM audit_log;');
  beneficiaryId = Number(db.prepare(`INSERT INTO beneficiaries(user_id,name,access_token,token_expires_at)
    VALUES(?,?,?,'2099-01-01T00:00:00.000Z')`)
    .run(OWNER, 'Synthetic carer', require('../server/crypto').hashToken(BENEFICIARY_TOKEN)).lastInsertRowid);
});
after(() => { if (db?.open) db.close(); });

test('Pet Care is registered consistently in navigation/forms and the vault API', () => {
  const frontend = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/js/sections.js'), 'utf8') + '\nSECTIONS');
  const { VALID_SECTIONS, validateSection } = require('../server/validate');
  assert.equal(frontend.pet_care.name, 'Pet Care');
  assert.equal(validateSection('pet_care'), true);
  assert.deepEqual(Object.keys(frontend).sort(), [...VALID_SECTIONS].sort());
});

test('an owner can create, find and edit a pet care plan while sensitive contents stay encrypted', async () => {
  await request('/api/vault/entries?section=pet_care', { auth: false, status: 401 });
  const entry = await create();
  assert.deepEqual(entry.fields, PET.fields);
  assert.equal(entry.notes, PET.notes);
  assertEncrypted(entry.id);
  await create({ section: 'secure_notes', title: 'Unrelated fixture note', fields: { content: 'Separate note' }, notes: '' });
  const listed = await request('/api/vault/entries?section=pet_care&limit=1');
  assert.deepEqual(listed.entries.map(item => item.id), [entry.id]);
  assert.equal(listed.total, 1);
  assert.deepEqual(await request('/api/vault/summary'), [
    { section: 'pet_care', count: 1 }, { section: 'secure_notes', count: 1 }
  ]);
  const fields = { ...PET.fields, dietary_needs: 'Updated veterinary diet; instructions in the labelled folder.' };
  const edited = await request('/api/vault/entries/' + entry.id, {
    method: 'PUT', body: { ...PET, title: 'Milo — updated care plan', fields }
  });
  assert.equal(edited.id, entry.id);
  assert.deepEqual((await request('/api/vault/entries/' + entry.id)).fields, fields);
  assertEncrypted(entry.id);
});

test('pet details are searchable and survive export, deletion, backup and restore', async () => {
  const entry = await create();
  for (const query of ['Milo', 'synthetic animal clinic', 'carrier is in the hall']) {
    assert.deepEqual((await request('/api/vault/search?q=' + encodeURIComponent(query))).map(item => item.id), [entry.id]);
  }
  const exported = await request('/api/vault/export');
  assert.equal(exported.entries[0].section, 'pet_care');
  assert.deepEqual(exported.entries[0].fields, PET.fields);
  const backup = await request('/api/vault/backup');
  assert.equal(backup.entries.length, 1);
  assert.equal(backup.entries[0].notes, PET.notes);
  await request('/api/vault/entries/' + entry.id, { method: 'DELETE' });
  await request('/api/vault/entries/' + entry.id, { status: 404 });
  assert.deepEqual(await request('/api/vault/summary'), []);
  const restored = await request('/api/vault/restore', { method: 'POST', body: { entries: backup.entries } });
  assert.deepEqual(restored, { success: true, added: 1, skipped: 0 });
  const saved = (await request('/api/vault/entries?section=pet_care')).entries[0];
  assert.notEqual(saved.id, entry.id);
  assert.deepEqual(saved.fields, PET.fields);
  assert.equal(saved.notes, PET.notes);
  assertEncrypted(saved.id);
  assert.deepEqual(await request('/api/vault/restore', { method: 'POST', body: { entries: backup.entries } }),
    { success: true, added: 0, skipped: 1 });
});

test('pet care reads, mutations, searches, exports and restores remain owner scoped', async () => {
  const entry = await create();
  for (const [method, body] of [['GET'], ['PUT', PET], ['DELETE']]) {
    await request('/api/vault/entries/' + entry.id, { owner: OTHER, method, body, status: 404 });
  }
  assert.deepEqual((await request('/api/vault/entries?section=pet_care', { owner: OTHER })).entries, []);
  assert.deepEqual(await request('/api/vault/summary', { owner: OTHER }), []);
  assert.deepEqual(await request('/api/vault/search?q=Milo', { owner: OTHER }), []);
  for (const route of ['/api/vault/export', '/api/vault/backup']) {
    assert.deepEqual((await request(route, { owner: OTHER })).entries, []);
  }
  // Importing the same title in a different account cannot overwrite its owner.
  await request('/api/vault/restore', { method: 'POST', owner: OTHER, body: {
    mode: 'overwrite', entries: [{ ...PET, fields: { pet_name: 'Another owner’s pet' }, notes: '' }]
  } });
  assert.deepEqual((await request('/api/vault/entries/' + entry.id)).fields, PET.fields);
  const foreign = (await request('/api/vault/entries?section=pet_care', { owner: OTHER })).entries[0];
  assert.notEqual(foreign.id, entry.id);
  await request('/api/vault/entries/' + foreign.id, { status: 404 });
});

test('a pet care plan follows ordinary vault access: hidden while waiting and readable only after grant', async () => {
  const entry = await create();
  await create({ title: 'Foreign pet care', fields: { pet_name: 'Other pet' }, notes: '' }, OTHER);
  assert.equal((await recipientAccess()).status, 'no_access');
  await request('/api/beneficiaries/emergency-access', { method: 'POST', auth: false, body: { accessToken: BENEFICIARY_TOKEN } });
  const waiting = await recipientAccess();
  assert.equal(waiting.status, 'waiting');
  assert.equal(Object.hasOwn(waiting, 'entries'), false);
  assert.equal(JSON.stringify(waiting).includes(PRIVATE_MARKER), false);
  await recipientAccess('unknown-synthetic-token', 404);
  await request('/api/vault/entries/' + entry.id, { token: BENEFICIARY_TOKEN, status: 403 });
  await request(`/api/beneficiaries/${beneficiaryId}/grant`, { method: 'POST', body: {} });
  const granted = await recipientAccess();
  assert.equal(granted.status, 'granted');
  assert.deepEqual(granted.entries.map(item => item.id), [entry.id]);
  assert.equal(granted.entries[0].section, 'pet_care');
  assert.deepEqual(granted.entries[0].fields, PET.fields);
  assert.equal(granted.entries[0].notes, PET.notes);
  await request(`/api/beneficiaries/${beneficiaryId}/revoke`, { method: 'POST', body: {} });
  assert.equal(Object.hasOwn(await recipientAccess(), 'entries'), false);
});
