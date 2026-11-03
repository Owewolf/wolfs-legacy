'use strict';

// Pure lineage/eligibility tests use disposable SQLite databases and synthetic
// contacts only. No auth server, default DB, secret loading or SMS transport.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { initFamilyRegistrationSchema, createFamilyRegistrationService } = require('../server/family-registration');
const ENV = { ACCOUNT_FAMILY_ROOT_USER_ID: '2', SMS_DEFAULT_COUNTRY_CODE: '27' };
const NOW = 1800000000000;
function fixture(t, { beneficiaries = true } = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,name TEXT,account_status TEXT DEFAULT 'active',
      sms_2fa_enabled INTEGER DEFAULT 1,sms_2fa_phone_e164 TEXT);
    CREATE TABLE registration_requests(id TEXT PRIMARY KEY,email TEXT,phone_e164 TEXT,status TEXT,
      registered_user_id INTEGER,invitation_used_at TEXT,decided_at TEXT,decided_by_user_id INTEGER,
      family_sponsor_user_id INTEGER,family_beneficiary_id INTEGER,eligibility_invalidated_at TEXT);`);
  if (beneficiaries) db.exec('CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),name TEXT,email TEXT,phone TEXT)');
  db.prepare('INSERT INTO users(id,email,name,sms_2fa_phone_e164) VALUES(?,?,?,?)')
    .run(1, 'unrelated@example.test', 'Unrelated first account', '+27820000001');
  db.prepare('INSERT INTO users(id,email,name,sms_2fa_phone_e164) VALUES(?,?,?,?)')
    .run(2, 'root@example.test', 'Explicit family root', '+27820000002');
  initFamilyRegistrationSchema(db);
  const env = { ...ENV }, service = createFamilyRegistrationService({ db, env, now: () => NOW });
  t.after(() => { if (db.open) db.close(); });
  return { db, env, service };
}
function user(f, id, { email = `member${id}@example.test`, phone = `+278200000${id}`, status = 'registered_unverified', enrolled = 0 } = {}) {
  f.db.prepare('INSERT INTO users(id,email,name,account_status,sms_2fa_enabled,sms_2fa_phone_e164) VALUES(?,?,?,?,?,?)')
    .run(id, email, 'Synthetic member ' + id, status, enrolled, phone);
  return f.db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
function beneficiary(f, id, sponsorId, email, phone) {
  f.db.prepare('INSERT INTO beneficiaries(id,user_id,name,email,phone) VALUES(?,?,?,?,?)')
    .run(id, sponsorId, 'Synthetic applicant', email, phone);
}
function request(f, id, userId, sponsorId, beneficiaryId, { status = 'registered', ...extra } = {}) {
  const person = f.db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  f.db.prepare(`INSERT INTO registration_requests(id,email,phone_e164,status,registered_user_id,invitation_used_at,
    decided_at,decided_by_user_id,family_sponsor_user_id,family_beneficiary_id,eligibility_invalidated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, person.email, person.sms_2fa_phone_e164, status,
      status === 'registered' ? userId : null, status === 'registered' ? new Date(NOW).toISOString() : null,
      new Date(NOW - 1000).toISOString(), 2, sponsorId, beneficiaryId, extra.eligibility_invalidated_at || null);
  return f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(id);
}
function member(f, id, sponsorId = 2, beneficiaryId = id + 10) {
  const person = user(f, id);
  beneficiary(f, beneficiaryId, sponsorId, person.email, person.sms_2fa_phone_e164);
  const application = request(f, 'synthetic-request-' + id, id, sponsorId, beneficiaryId);
  assert.equal(f.db.transaction(() => f.service.enroll(application, id)).immediate().ok, true);
  f.db.prepare("UPDATE users SET account_status='active',sms_2fa_enabled=1 WHERE id=?").run(id);
  return { person, application, beneficiaryId };
}
const rows = (f, table) => f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();

test('root is explicitly configured, persisted once, and never inferred from first account or approval owner', t => {
  const f = fixture(t), accounts = rows(f, 'users');
  assert.deepEqual(rows(f, 'family_registration_root'), []);
  f.env.ACCOUNT_FAMILY_ROOT_USER_ID = undefined; f.env.ACCOUNT_APPROVAL_OWNER_USER_ID = '1';
  assert.deepEqual(f.service.configuration(), { ok: false, reason: 'family_unavailable' });
  assert.deepEqual(rows(f, 'family_registration_root'), []);
  f.env.ACCOUNT_FAMILY_ROOT_USER_ID = '2';
  assert.deepEqual(f.service.configuration(), { ok: true, rootUserId: 2 });
  const root = rows(f, 'family_registration_root'); assert.equal(root[0].root_user_id, 2);
  assert.deepEqual(f.service.configuration(), { ok: true, rootUserId: 2 });
  assert.deepEqual(rows(f, 'family_registration_root'), root);
  assert.deepEqual(rows(f, 'family_memberships'), []); assert.deepEqual(rows(f, 'users'), accounts);
  f.env.ACCOUNT_FAMILY_ROOT_USER_ID = '1';
  assert.deepEqual(f.service.configuration(), { ok: false, reason: 'family_unavailable' });
  assert.deepEqual(rows(f, 'family_registration_root'), root); assert.deepEqual(rows(f, 'users'), accounts);
});

test('invalid root settings and inactive, unenrolled or invalid-mobile root accounts never bootstrap', t => {
  const f = fixture(t);
  for (const value of ['', '0', '-2', '2.0', ' 2 ', '02', 'not-an-id', '9007199254740993', '99']) {
    f.env.ACCOUNT_FAMILY_ROOT_USER_ID = value;
    assert.equal(f.service.configuration().ok, false); assert.equal(rows(f, 'family_registration_root').length, 0);
  }
  f.env.ACCOUNT_FAMILY_ROOT_USER_ID = '2';
  for (const status of ['blocked', 'registered_unverified']) {
    f.db.prepare('UPDATE users SET account_status=? WHERE id=2').run(status);
    assert.equal(f.service.configuration().ok, false); assert.equal(rows(f, 'family_registration_root').length, 0);
  }
  f.db.exec("UPDATE users SET account_status='active',sms_2fa_enabled=0 WHERE id=2");
  assert.equal(f.service.configuration().ok, false);
  f.db.exec("UPDATE users SET sms_2fa_enabled=1,sms_2fa_phone_e164='not-a-phone' WHERE id=2");
  assert.equal(f.service.configuration().ok, false); assert.equal(rows(f, 'family_registration_root').length, 0);
});

test('family root can sponsor only a beneficiary with both normalized saved contacts; unrelated account contacts confer no eligibility', t => {
  const f = fixture(t);
  beneficiary(f, 11, 2, '  APPLICANT@Example.Test ', '082 000 0003');
  beneficiary(f, 12, 1, 'outsider@example.test', '+27820000004');
  assert.deepEqual(f.service.findSponsor({ email: ' applicant@example.test ', phone: '+27 (82) 000-0003' }), { ok: true, sponsorUserId: 2, beneficiaryId: 11 });
  for (const contact of [
    { email: 'applicant@example.test', phone: '+27820000004' },
    { email: 'different@example.test', phone: '+27820000003' },
    { email: 'outsider@example.test', phone: '+27820000004' },
    { email: 'applicant@example.test' }, { phone: '+27820000003' }
  ]) assert.deepEqual(f.service.findSponsor(contact), { ok: false, reason: 'family_eligibility_required' });
  assert.equal(rows(f, 'family_memberships').length, 0);
});

test('duplicate family contacts choose root then lowest beneficiary ID without reassigning an existing bound request', t => {
  const f = fixture(t); member(f, 3);
  beneficiary(f, 6, 3, 'applicant@example.test', '+27820000004');
  beneficiary(f, 11, 2, 'applicant@example.test', '+27820000004');
  beneficiary(f, 12, 1, 'applicant@example.test', '+27820000004');
  const contact = { email: 'applicant@example.test', phone: '+27820000004' };
  assert.deepEqual(f.service.findSponsor(contact), { ok: true, sponsorUserId: 2, beneficiaryId: 11 });
  const bound = { email: contact.email, phone_e164: contact.phone, family_sponsor_user_id: 2, family_beneficiary_id: 11 };
  beneficiary(f, 10, 2, contact.email, contact.phone);
  assert.equal(f.service.findSponsor(contact).beneficiaryId, 10, 'new requests choose the lowest eligible root-owned ID');
  assert.deepEqual(f.service.validateBinding(bound), { ok: true, sponsorUserId: 2, beneficiaryId: 11 }, 'an additional family contact does not invalidate a bound invitation');
});

test('request binding remains attached to the exact original beneficiary and sponsor after contact edits or replacement rows', t => {
  const f = fixture(t), person = user(f, 3);
  beneficiary(f, 11, 2, person.email, person.sms_2fa_phone_e164);
  const application = request(f, 'synthetic-bound', 3, 2, 11, { status: 'approved' });
  assert.equal(f.service.validateBinding(application).ok, true);
  f.db.prepare('UPDATE beneficiaries SET email=? WHERE id=11').run('changed@example.test');
  assert.equal(f.service.validateBinding(application).ok, false);
  beneficiary(f, 12, 2, person.email, person.sms_2fa_phone_e164);
  assert.equal(f.service.findSponsor({ email: person.email, phone: person.sms_2fa_phone_e164 }).beneficiaryId, 12);
  assert.equal(f.service.validateBinding(application).ok, false, 'replacement contact must not substitute the original beneficiary ID');
  assert.equal(f.service.validateBinding({ ...application, family_beneficiary_id: 12, family_sponsor_user_id: 1 }).ok, false);
  assert.equal(f.service.validateBinding({ ...application, family_beneficiary_id: 12, eligibility_invalidated_at: new Date(NOW).toISOString() }).ok, false);
});

test('a consumed approved registration creates one immutable rooted membership and does not activate or alter the account', t => {
  const f = fixture(t), person = user(f, 3);
  beneficiary(f, 11, 2, person.email, person.sms_2fa_phone_e164);
  const application = request(f, 'synthetic-consumed', 3, 2, 11);
  assert.throws(() => f.service.enroll(application, 3), /account-creation transaction/);
  const result = f.db.transaction(() => f.service.enroll({ ...application, status: 'approved' }, 3)).immediate();
  assert.deepEqual(result, { ok: true, rootUserId: 2, sponsorUserId: 2, beneficiaryId: 11 });
  assert.deepEqual(rows(f, 'users').find(row => row.id === 3), person);
  assert.deepEqual(rows(f, 'family_memberships'), [{ user_id: 3, root_user_id: 2, sponsor_user_id: 2,
    sponsor_beneficiary_id: 11, source_registration_request_id: 'synthetic-consumed', created_at: new Date(NOW).toISOString() }]);
  assert.equal(f.service.findSponsor({ email: person.email, phone: person.sms_2fa_phone_e164 }).ok, false, 'consumed beneficiary cannot sponsor another account');
  assert.equal(f.db.transaction(() => f.service.enroll(application, 3))().ok, false);
  assert.equal(rows(f, 'family_memberships').length, 1);
});

test('pending, unconsumed, mismatching and pre-existing registered accounts cannot be automatically enrolled', t => {
  const f = fixture(t), person = user(f, 3);
  beneficiary(f, 11, 2, person.email, person.sms_2fa_phone_e164);
  const application = request(f, 'synthetic-not-ready', 3, 2, 11, { status: 'approved' });
  const enroll = () => f.db.transaction(() => f.service.enroll(application, 3))();
  assert.equal(enroll().ok, false);
  f.db.prepare("UPDATE registration_requests SET status='registered',registered_user_id=3 WHERE id=?").run(application.id);
  assert.equal(enroll().ok, false);
  f.db.prepare('UPDATE registration_requests SET invitation_used_at=? WHERE id=?').run(new Date(NOW).toISOString(), application.id);
  f.db.prepare('UPDATE users SET email=? WHERE id=3').run('mismatch@example.test'); assert.equal(enroll().ok, false);
  f.db.prepare("UPDATE users SET email=?,account_status='active' WHERE id=3").run(person.email); assert.equal(enroll().ok, false);
  f.db.exec("UPDATE users SET account_status='registered_unverified' WHERE id=3");
  f.db.prepare('UPDATE registration_requests SET family_sponsor_user_id=NULL,family_beneficiary_id=NULL WHERE id=?').run(application.id);
  assert.equal(enroll().ok, false, 'old registered requests without an explicit family binding are never grandfathered in');
  assert.equal(rows(f, 'family_memberships').length, 0);
});

test('current sponsor must be an active SMS-verified family member before a beneficiary can join the next generation', t => {
  const f = fixture(t); member(f, 3);
  beneficiary(f, 14, 3, 'next@example.test', '+27820000004');
  const contact = { email: 'next@example.test', phone: '+27820000004' };
  assert.deepEqual(f.service.findSponsor(contact), { ok: true, sponsorUserId: 3, beneficiaryId: 14 });
  for (const update of ["account_status='blocked'", "account_status='registered_unverified'", "account_status='active',sms_2fa_enabled=0"]) {
    f.db.exec('UPDATE users SET ' + update + ' WHERE id=3');
    assert.equal(f.service.findSponsor(contact).ok, false);
  }
  f.db.exec("UPDATE users SET account_status='active',sms_2fa_enabled=1 WHERE id=3");
  assert.equal(f.service.findSponsor(contact).ok, true);
  f.db.exec("UPDATE users SET account_status='blocked' WHERE id=2");
  assert.deepEqual(f.service.findSponsor(contact), { ok: false, reason: 'family_unavailable' });
});

test('completed lineage survives historical beneficiary deletion and a blocked intermediate ancestor without revoking legitimate descendants', t => {
  const f = fixture(t), first = member(f, 3), second = member(f, 4, 3);
  const memberships = rows(f, 'family_memberships');
  f.db.prepare('DELETE FROM beneficiaries WHERE id IN (?,?)').run(first.beneficiaryId, second.beneficiaryId);
  f.db.exec("UPDATE users SET account_status='blocked' WHERE id=3");
  beneficiary(f, 15, 4, 'descendant@example.test', '+27820000005');
  assert.deepEqual(f.service.findSponsor({ email: 'descendant@example.test', phone: '+27820000005' }), { ok: true, sponsorUserId: 4, beneficiaryId: 15 });
  assert.deepEqual(rows(f, 'family_memberships'), memberships);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('database rejects replacing, reassigning or deleting roots and memberships and refuses unrooted chain insertion', t => {
  const f = fixture(t); member(f, 3); user(f, 4);
  const before = rows(f, 'family_memberships'), root = rows(f, 'family_registration_root');
  for (const sql of [
    'UPDATE family_registration_root SET root_user_id=1', 'DELETE FROM family_registration_root',
    "INSERT OR REPLACE INTO family_registration_root VALUES(1,1,'2026-01-01')",
    'UPDATE family_memberships SET sponsor_user_id=1 WHERE user_id=3', 'DELETE FROM family_memberships WHERE user_id=3',
    "INSERT OR REPLACE INTO family_memberships VALUES(3,2,2,99,'replacement-request','2026-01-01')",
    "INSERT INTO family_memberships VALUES(4,2,1,99,'unrooted-request','2026-01-01')",
    'DELETE FROM users WHERE id=2', 'DELETE FROM users WHERE id=3'
  ]) assert.throws(() => f.db.exec(sql));
  assert.deepEqual(rows(f, 'family_memberships'), before); assert.deepEqual(rows(f, 'family_registration_root'), root);
});

test('schema initialization tolerates absent beneficiary tables and eligibility fails closed on missing columns', t => {
  const f = fixture(t, { beneficiaries: false });
  assert.deepEqual(f.service.configuration(), { ok: true, rootUserId: 2 });
  assert.deepEqual(f.service.findSponsor({ email: 'child@example.test', phone: '+27820000003' }), { ok: false, reason: 'family_unavailable' });
  f.db.exec('CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY,user_id INTEGER,email TEXT)');
  assert.equal(f.service.findSponsor({ email: 'child@example.test', phone: '+27820000003' }).ok, false);
  const root = rows(f, 'family_registration_root'); initFamilyRegistrationSchema(f.db); initFamilyRegistrationSchema(f.db);
  assert.deepEqual(rows(f, 'family_registration_root'), root);
});

test('partial family schema fails before changing the existing schema or claiming initialization', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY);CREATE TABLE family_memberships(user_id INTEGER PRIMARY KEY)');
  assert.throws(() => initFamilyRegistrationSchema(db), /Incomplete family registration schema/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='family_registration_root'").get(), undefined);
});

test('failed membership insertion allows the account-creation caller to roll back user creation and invitation consumption atomically', t => {
  const f = fixture(t); f.service.configuration();
  beneficiary(f, 11, 2, 'new@example.test', '+27820000003');
  f.db.prepare(`INSERT INTO registration_requests(id,email,phone_e164,status,decided_at,decided_by_user_id,
    family_sponsor_user_id,family_beneficiary_id) VALUES('synthetic-atomic','new@example.test','+27820000003','approved',?,2,2,11)`)
    .run(new Date(NOW).toISOString());
  f.db.exec("CREATE TRIGGER fixture_fail_membership BEFORE INSERT ON family_memberships BEGIN SELECT RAISE(ABORT,'synthetic insertion failure'); END");
  const beforeUsers = rows(f, 'users'), beforeRequests = rows(f, 'registration_requests');
  assert.throws(() => f.db.transaction(() => {
    user(f, 3, { email: 'new@example.test' });
    f.db.prepare("UPDATE registration_requests SET status='registered',registered_user_id=3,invitation_used_at=? WHERE id='synthetic-atomic'")
      .run(new Date(NOW).toISOString());
    const result = f.service.enroll({ id: 'synthetic-atomic' }, 3);
    if (!result.ok) throw new Error('roll back account creation');
  }).immediate(), /roll back account creation/);
  assert.deepEqual(rows(f, 'users'), beforeUsers); assert.deepEqual(rows(f, 'registration_requests'), beforeRequests);
  assert.equal(rows(f, 'family_memberships').length, 0);
});

test('initialized root configuration works read-only and independent concurrent bootstraps persist only one explicit root', async t => {
  const f = fixture(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-family-root-'));
  fs.chmodSync(root, 0o700); const databasePath = path.join(root, 'synthetic.db');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await f.db.backup(databasePath);
  const source = `const{parentPort,workerData}=require('node:worker_threads');const Database=require(workerData.databaseModule);
    const{createFamilyRegistrationService}=require(workerData.serviceModule);const db=new Database(workerData.databasePath,{timeout:10000});db.pragma('foreign_keys=ON');
    parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage(createFamilyRegistrationService({db,env:workerData.env}).configuration());}finally{db.close();parentPort.close();}});`;
  const workers = [0, 1].map(() => new Worker(source, { eval: true, workerData: { databaseModule: require.resolve('better-sqlite3'),
    serviceModule: require.resolve('../server/family-registration'), databasePath, env: ENV } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const outcomes = workers.map(worker => once(worker, 'message')); workers.forEach(worker => worker.postMessage('start'));
  for (const [result] of await Promise.all(outcomes)) assert.deepEqual(result, { ok: true, rootUserId: 2 });
  const readonly = new Database(databasePath, { readonly: true });
  try {
    assert.equal(readonly.prepare('SELECT COUNT(*) AS n FROM family_registration_root').get().n, 1);
    assert.deepEqual(createFamilyRegistrationService({ db: readonly, env: ENV }).configuration(), { ok: true, rootUserId: 2 });
  } finally { readonly.close(); }
});
