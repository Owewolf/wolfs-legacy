'use strict';

// Independent, adversarial acceptance against real signup routes and services.
// All users, family relationships, phones, passwords and SMS are invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { initSmsOtpSchema } = require('../server/sms-otp');
const { initRegistrationApprovalSchema, createRegistrationApprovalService } = require('../server/registration-approval');
const { initFamilyRegistrationSchema, createFamilyRegistrationService } = require('../server/family-registration');
require.cache[require.resolve('better-sqlite3')].exports = function SyntheticDatabase(filename, ...args) {
  assert.equal(filename, ':memory:', 'family security checks may not open an application vault');
  return new Database(filename, ...args);
};
const { createAuthRouter } = require('../server/routes/auth');
const OWNER = 2, ROOT = 4, UNRELATED = 9;
const PASSWORD = 'SyntheticFamilyPassword123!';
const CHILD = { name: 'Synthetic Child', email: 'child@example.test', phone: '+27821110001' };
const GRANDCHILD = { name: 'Synthetic Grandchild', email: 'grandchild@example.test', phone: '+27821110003' };

async function fixture(t, { failOwnerSms = false } = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE,name TEXT,password_hash TEXT,
      sms_2fa_enabled INTEGER DEFAULT 0,sms_2fa_phone_e164 TEXT,sms_2fa_enrolled_at TEXT,totp_enabled INTEGER DEFAULT 0,
      created_at TEXT,last_check_in TEXT);
    CREATE TABLE beneficiaries(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER REFERENCES users(id),name TEXT,email TEXT,phone TEXT);
    CREATE TABLE dead_switch_config(id INTEGER PRIMARY KEY,user_id INTEGER UNIQUE REFERENCES users(id));
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,
      detail TEXT,ip_address TEXT,created_at TEXT);`);
  initSmsOtpSchema(db); initRegistrationApprovalSchema(db); initFamilyRegistrationSchema(db);
  const user = db.prepare('INSERT INTO users(id,email,name,password_hash,sms_2fa_enabled,sms_2fa_phone_e164) VALUES(?,?,?,?,1,?)');
  for (const [id, name] of [[OWNER, 'Approving owner outside the family'], [ROOT, 'Explicit family root'], [UNRELATED, 'Unrelated existing account']]) {
    user.run(id, 'user-' + id + '@example.test', name, bcrypt.hashSync(PASSWORD, 4), '+2782000000' + id);
  }
  const insertBeneficiary = db.prepare('INSERT INTO beneficiaries(user_id,name,email,phone) VALUES(?,?,?,?)');
  const childBeneficiary = Number(insertBeneficiary.run(ROOT, CHILD.name, CHILD.email, CHILD.phone).lastInsertRowid);
  const secondBeneficiary = Number(insertBeneficiary.run(ROOT, 'Second synthetic person', 'second@example.test', '+27821110002').lastInsertRowid);
  const unrelatedBeneficiary = Number(insertBeneficiary.run(UNRELATED, 'Unrelated nominee', 'outsider@example.test', '+27829990001').lastInsertRowid);
  let clock = Date.now();
  const env = { ACCOUNT_FAMILY_ROOT_USER_ID: String(ROOT), ACCOUNT_APPROVAL_OWNER_USER_ID: String(OWNER),
    ACCOUNT_APPROVAL_OWNER_SMS_E164: '+27820000002', APP_BASE_URL: 'https://family.example.test',
    ACCOUNT_APPROVAL_REQUIRED: 'true', AUTH_SMS_REQUIRED: 'true', JWT_SECRET: 'synthetic-family-jwt-secret-32-characters',
    OTP_HASH_KEY: 'synthetic-family-otp-hash-key-32-characters' };
  const sms = [], sender = { configured: true, simulated: false, async sendOtp(message) {
    sms.push(message); if (failOwnerSms && message.to === env.ACCOUNT_APPROVAL_OWNER_SMS_E164) throw new Error('Synthetic owner transport failure'); return {};
  } };
  const auditWriter = (userId, action, type, targetId, detail, ip) => db.prepare('INSERT INTO audit_log(user_id,action,target_type,target_id,detail,ip_address) VALUES(?,?,?,?,?,?)')
    .run(userId ?? null, action, type ?? null, targetId ?? null, detail ?? null, ip ?? null);
  const family = createFamilyRegistrationService({ db, env, now: () => clock });
  assert.equal(family.configuration().ok, true);
  const approval = createRegistrationApprovalService({ db, env, now: () => clock, smsSender: sender, auditWriter });
  const app = express(); app.use(express.json()); app.locals.getDb = () => db; app.locals.authEnv = env;
  app.use('/api/auth', createAuthRouter({ dbGetter: () => db, env, now: () => clock, auditWriter, smsProvider: sender }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  async function route(path, body) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/auth' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  function beneficiary(sponsorUserId, applicant) {
    return Number(insertBeneficiary.run(sponsorUserId, applicant.name, applicant.email, applicant.phone).lastInsertRowid);
  }
  const actor = { id: OWNER, auth_version: 0, mfa: 'sms_otp' };
  const submit = applicant => approval.requestAccess({ ...CHILD, ...applicant, ipAddress: '198.51.100.17' });
  function approve(request) {
    const result = approval.decide({ requestId: request.request_id, actor, decision: 'approve', confirmed: true });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.invitation_token;
  }
  async function registeredChild({ activate = true, applicant = CHILD } = {}) {
    const request = await submit(applicant), invitationToken = approve(request);
    const id = db.transaction(() => {
      const id = Number(db.prepare("INSERT INTO users(email,name,password_hash,sms_2fa_phone_e164,account_status) VALUES(?,?,?,?,'registered_unverified')")
        .run(applicant.email, applicant.name, bcrypt.hashSync(PASSWORD, 4), applicant.phone).lastInsertRowid);
      assert.equal(approval.consumeInvitation({ invitationToken, userId: id }).ok, true);
      return id;
    }).immediate();
    if (activate) db.prepare("UPDATE users SET account_status='active',sms_2fa_enabled=1,sms_2fa_enrolled_at=? WHERE id=?").run(new Date(clock).toISOString(), id);
    return { id, request, invitationToken };
  }
  return { db, env, sms, sender, family, approval, actor, route, beneficiary, submit, approve, registeredChild,
    childBeneficiary, secondBeneficiary, unrelatedBeneficiary, advance: ms => { clock += ms; } };
}
function count(f, table) { return f.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n; }
function assertNoInvitation(result) {
  for (const key of ['invitation_token', 'invitation_url']) assert.equal(result[key], undefined);
}

test('outsiders cannot create applications, trigger SMS or exhaust the family registration throttle quota', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 45; i++) await f.submit({ email: 'outsider-' + i + '@example.test', phone: '+2782999' + String(i).padStart(4, '0') });
  assert.equal(count(f, 'registration_requests'), 0); assert.equal(f.sms.length, 0);
  assert.equal(count(f, 'registration_throttle_events'), 0);
  assert.equal(count(f, 'family_memberships'), 0);
  const legitimate = await f.submit();
  assert.ok(f.db.prepare('SELECT id FROM registration_requests WHERE id=?').get(legitimate.request_id));
  assert.equal(f.sms.length, 1); assert.equal(count(f, 'registration_throttle_events'), 1);
});

test('both contacts must match one saved beneficiary of an eligible sponsor; unrelated active users and the approval-owner role grant no sponsorship', async t => {
  const f = await fixture(t);
  f.beneficiary(OWNER, { name: 'Owner nominee', email: 'owner-nominee@example.test', phone: '+27829990002' });
  for (const applicant of [
    { email: CHILD.email, phone: '+27821110002' }, { email: 'second@example.test', phone: CHILD.phone },
    { email: CHILD.email, phone: '+27829990001' }, { email: 'outsider@example.test', phone: CHILD.phone },
    { email: 'outsider@example.test', phone: '+27829990001' }, { email: 'owner-nominee@example.test', phone: '+27829990002' }
  ]) await f.submit(applicant);
  assert.equal(count(f, 'registration_requests'), 0); assert.equal(f.sms.length, 0);
  assert.equal(count(f, 'family_memberships'), 0);
  assert.equal(f.approval.accountAccess(f.db.prepare('SELECT * FROM users WHERE id=?').get(OWNER)).ok, true);
  assert.equal(f.approval.accountAccess(f.db.prepare('SELECT * FROM users WHERE id=?').get(UNRELATED)).ok, true);
});

test('normalized same-row contacts bind the request to server-selected immutable sponsorship, without converting historical accounts to members', async t => {
  const f = await fixture(t);
  const request = await f.submit({ email: '  CHILD@EXAMPLE.TEST  ', phone: '082 111 0001', family_sponsor_user_id: UNRELATED, family_beneficiary_id: f.unrelatedBeneficiary });
  const row = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(request.request_id);
  assert.equal(row.email, CHILD.email); assert.equal(row.phone_e164, CHILD.phone);
  assert.equal(row.family_sponsor_user_id, ROOT); assert.equal(row.family_beneficiary_id, f.childBeneficiary);
  assert.equal(row.eligibility_invalidated_at, null); assert.equal(count(f, 'family_memberships'), 0);
  assert.equal(f.sms.length, 1);
});

test('a rooted child is ineligible to sponsor before OTP activation and may sponsor a grandchild after actual verification', async t => {
  const f = await fixture(t), request = await f.submit(), invitationToken = f.approve(request);
  const registered = await f.route('/register', { invitation_token: invitationToken, password: PASSWORD });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  assert.equal(registered.data.token, undefined); assert.equal(registered.data.requires_second_factor, true);
  const child = f.db.prepare('SELECT * FROM users WHERE email=?').get(CHILD.email);
  assert.equal(child.account_status, 'registered_unverified'); assert.equal(count(f, 'family_memberships'), 1);
  const lineage = f.db.prepare('SELECT * FROM family_memberships WHERE user_id=?').get(child.id);
  assert.equal(lineage.root_user_id, ROOT); assert.equal(lineage.sponsor_user_id, ROOT);
  assert.equal(lineage.sponsor_beneficiary_id, f.childBeneficiary); assert.equal(lineage.source_registration_request_id, request.request_id);
  f.beneficiary(child.id, GRANDCHILD);
  const messages = f.sms.length, requests = count(f, 'registration_requests');
  await f.submit(GRANDCHILD);
  assert.equal(f.sms.length, messages); assert.equal(count(f, 'registration_requests'), requests);
  const code = f.sms.findLast(message => message.to === CHILD.phone).message.match(/\b\d{6}\b/)[0];
  const verified = await f.route('/login/challenge/verify', { challenge_id: registered.data.challenge_id,
    challenge_token: registered.data.challenge_token, otp: code });
  assert.equal(verified.status, 200, JSON.stringify(verified.data)); assert.ok(verified.data.token);
  assert.equal(f.db.prepare('SELECT account_status FROM users WHERE id=?').get(child.id).account_status, 'active');
  const grandRequest = await f.submit(GRANDCHILD);
  const grandRow = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(grandRequest.request_id);
  assert.equal(grandRow.family_sponsor_user_id, child.id); assert.equal(f.sms.length, messages + 1);
});

for (const mutation of ['email', 'phone', 'delete']) {
  test(`a beneficiary ${mutation} change invalidates owner retry and approval without further SMS`, async t => {
    const f = await fixture(t, { failOwnerSms: true }), request = await f.submit();
    const before = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(request.request_id);
    assert.equal(before.notification_attempts, 1); assert.equal(before.notification_status, 'failed');
    if (mutation === 'delete') f.db.prepare('DELETE FROM beneficiaries WHERE id=?').run(f.childBeneficiary);
    else f.db.prepare('UPDATE beneficiaries SET ' + mutation + '=? WHERE id=?').run(mutation === 'email' ? 'different@example.test' : '+27824440001', f.childBeneficiary);
    f.advance(6 * 60000);
    const retried = await f.approval.notifyOwner(request.request_id, { retry: true, actorId: OWNER });
    assert.equal(retried.ok, false); assert.equal(f.sms.length, 1);
    assert.equal(f.db.prepare('SELECT notification_attempts FROM registration_requests WHERE id=?').get(request.request_id).notification_attempts, 1);
    assert.equal(f.approval.decide({ requestId: request.request_id, actor: f.actor, decision: 'approve', confirmed: true }).ok, false);
    assertNoInvitation(f.approval.requestStatus({ requestId: request.request_id, statusSecret: request.status_secret }));
    assert.equal(count(f, 'users'), 3); assert.equal(count(f, 'family_memberships'), 0);
  });
}

test('approved invitations and private status responses stop exposing enrollment after sponsorship contact mutation', async t => {
  const f = await fixture(t), request = await f.submit(), token = f.approve(request);
  f.db.prepare('UPDATE beneficiaries SET phone=? WHERE id=?').run('+27825550001', f.childBeneficiary);
  assert.equal(f.approval.validateInvitation({ invitationToken: token }).ok, false);
  assertNoInvitation(f.approval.requestStatus({ requestId: request.request_id, statusSecret: request.status_secret }));
  for (const row of f.approval.listRequests({ status: 'approved' })) assertNoInvitation(row);
  const registered = await f.route('/register', { invitation_token: token, password: PASSWORD });
  assert.equal(registered.status, 403); assert.equal(count(f, 'users'), 3);
  assert.equal(count(f, 'family_memberships'), 0); assert.equal(f.sms.length, 1);
});

for (const mutation of ['blocked', 'unenrolled']) {
  test(`a ${mutation} sponsoring member cannot continue pending enrollment or cause more owner SMS`, async t => {
    const f = await fixture(t), child = await f.registeredChild();
    f.beneficiary(child.id, GRANDCHILD);
    const request = await f.submit(GRANDCHILD), token = f.approve(request), messages = f.sms.length;
    if (mutation === 'blocked') f.db.prepare("UPDATE users SET account_status='blocked' WHERE id=?").run(child.id);
    else f.db.prepare('UPDATE users SET sms_2fa_enabled=0 WHERE id=?').run(child.id);
    assert.equal(f.approval.validateInvitation({ invitationToken: token }).ok, false);
    assertNoInvitation(f.approval.requestStatus({ requestId: request.request_id, statusSecret: request.status_secret }));
    const registered = await f.route('/register', { invitation_token: token, password: PASSWORD });
    assert.equal(registered.status, 403); assert.equal(f.sms.length, messages);
    assert.equal(count(f, 'family_memberships'), 1); assert.equal(count(f, 'users'), 4);
  });
}

test('changing sponsorship during password hashing rolls back account creation and immutable lineage consumption', async t => {
  const f = await fixture(t), request = await f.submit(), token = f.approve(request);
  const originalHash = bcrypt.hash;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const continueHash = new Promise(resolve => { release = resolve; });
  bcrypt.hash = async password => { entered(); await continueHash; return bcrypt.hashSync(password, 4); };
  t.after(() => { bcrypt.hash = originalHash; });
  const pending = f.route('/register', { invitation_token: token, password: PASSWORD });
  await started;
  f.db.prepare('UPDATE beneficiaries SET email=? WHERE id=?').run('changed-during-hash@example.test', f.childBeneficiary);
  release();
  const result = await pending;
  assert.equal(result.status, 403); assert.equal(count(f, 'users'), 3); assert.equal(count(f, 'family_memberships'), 0);
  assert.equal(f.db.prepare('SELECT registered_user_id,invitation_used_at FROM registration_requests WHERE id=?').get(request.request_id).registered_user_id, null);
  assert.equal(f.sms.length, 1);
});

test('membership persistence failure rolls back the user and consumed invitation before applicant SMS, and retry creates once', async t => {
  const f = await fixture(t), request = await f.submit(), token = f.approve(request);
  f.db.exec("CREATE TRIGGER fail_family_membership BEFORE INSERT ON family_memberships BEGIN SELECT RAISE(ABORT,'Synthetic family write failure'); END");
  const failed = await f.route('/register', { invitation_token: token, password: PASSWORD });
  assert.equal(failed.status, 500); assert.equal(count(f, 'users'), 3); assert.equal(count(f, 'family_memberships'), 0);
  const row = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(request.request_id);
  assert.equal(row.status, 'approved'); assert.equal(row.registered_user_id, null); assert.equal(row.invitation_used_at, null);
  assert.equal(f.sms.length, 1);
  f.db.exec('DROP TRIGGER fail_family_membership');
  const retry = await f.route('/register', { invitation_token: token, password: PASSWORD });
  assert.equal(retry.status, 201); assert.equal(count(f, 'users'), 4); assert.equal(count(f, 'family_memberships'), 1);
  assert.equal(f.sms.length, 2);
});

test('a completed family member keeps identity, lineage and sponsorship ability after source beneficiary edits or deletion', async t => {
  const f = await fixture(t), child = await f.registeredChild();
  const before = f.db.prepare('SELECT * FROM family_memberships WHERE user_id=?').get(child.id);
  f.db.prepare('UPDATE beneficiaries SET email=?,phone=? WHERE id=?').run('other-person@example.test', '+27827770001', f.childBeneficiary);
  f.db.prepare('DELETE FROM beneficiaries WHERE id=?').run(f.childBeneficiary);
  const user = f.db.prepare('SELECT * FROM users WHERE id=?').get(child.id);
  assert.equal(f.approval.accountAccess(user).ok, true);
  assert.deepEqual(f.db.prepare('SELECT * FROM family_memberships WHERE user_id=?').get(child.id), before);
  f.beneficiary(child.id, GRANDCHILD);
  const request = await f.submit(GRANDCHILD);
  assert.ok(f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(request.request_id));
  assert.equal(f.db.prepare('SELECT family_sponsor_user_id FROM registration_requests WHERE id=?').get(request.request_id).family_sponsor_user_id, child.id);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('changing or omitting the persisted root fails closed for new signup but leaves legitimate account access intact', async t => {
  const f = await fixture(t), rootBefore = f.db.prepare('SELECT * FROM family_registration_root').all();
  for (const root of [String(UNRELATED), undefined]) {
    f.env.ACCOUNT_FAMILY_ROOT_USER_ID = root;
    await f.submit();
    assert.equal(count(f, 'registration_requests'), 0); assert.equal(f.sms.length, 0);
    assert.equal(f.approval.accountAccess(f.db.prepare('SELECT * FROM users WHERE id=?').get(UNRELATED)).ok, true);
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM family_registration_root').all(), rootBefore);
  assert.equal(count(f, 'family_memberships'), 0);
});

for (const status of ['pending', 'approved']) {
  test(`old unbound ${status} applications are quarantined rather than adopted, and do not reserve eligible contacts forever`, async t => {
    const f = await fixture(t), id = crypto.randomUUID(), secret = crypto.randomBytes(32).toString('hex');
    const hash = (purpose, value) => crypto.createHmac('sha256', f.env.OTP_HASH_KEY).update(purpose + ':' + value).digest('hex');
    const at = new Date().toISOString(), expiry = new Date(Date.now() + 86400000).toISOString();
    f.db.prepare(`INSERT INTO registration_requests(id,name,email,phone_e164,status,status_secret_hash,created_at,updated_at,
      decided_at,decided_by_user_id,invitation_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, CHILD.name, CHILD.email, CHILD.phone, status, hash('status', id + ':' + secret), at, at,
        status === 'approved' ? at : null, status === 'approved' ? OWNER : null, status === 'approved' ? expiry : null);
    const old = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(id);
    const oldToken = f.approval.invitationView(old).invitation_token;
    if (status === 'approved') f.db.prepare('UPDATE registration_requests SET invitation_token_hash=? WHERE id=?').run(hash('invitation-token', oldToken), id);
    initRegistrationApprovalSchema(f.db);
    assert.ok(f.db.prepare('SELECT eligibility_invalidated_at FROM registration_requests WHERE id=?').get(id).eligibility_invalidated_at);
    assert.equal(f.approval.validateInvitation({ invitationToken: oldToken }).ok, false);
    assertNoInvitation(f.approval.requestStatus({ requestId: id, statusSecret: secret }));
    assert.equal(count(f, 'family_memberships'), 0); assert.equal(f.sms.length, 0);
    const current = await f.submit();
    assert.notEqual(current.request_id, id);
    const bound = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(current.request_id);
    assert.equal(bound.family_beneficiary_id, f.childBeneficiary); assert.equal(bound.eligibility_invalidated_at, null);
    assert.equal(count(f, 'registration_requests'), 2); assert.equal(count(f, 'registration_denials'), 0); assert.equal(f.sms.length, 1);
  });
}

test('deleting and recreating a beneficiary can create a fresh eligible request without reviving or rejecting the stale invitation', async t => {
  const f = await fixture(t), stale = await f.submit(), staleToken = f.approve(stale);
  f.db.prepare('DELETE FROM beneficiaries WHERE id=?').run(f.childBeneficiary);
  const replacement = f.beneficiary(ROOT, CHILD);
  assert.notEqual(replacement, f.childBeneficiary);
  const current = await f.submit();
  assert.notEqual(current.request_id, stale.request_id);
  const oldRow = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(stale.request_id);
  assert.ok(oldRow.eligibility_invalidated_at); assert.equal(oldRow.status, 'approved');
  assert.equal(f.approval.validateInvitation({ invitationToken: staleToken }).ok, false);
  assert.equal(f.db.prepare('SELECT family_beneficiary_id FROM registration_requests WHERE id=?').get(current.request_id).family_beneficiary_id, replacement);
  assert.equal(count(f, 'registration_denials'), 0); assert.equal(f.sms.length, 2);
});

test('a temporary root configuration outage cannot permanently invalidate a legitimate approved invitation', async t => {
  const f = await fixture(t), request = await f.submit(), token = f.approve(request);
  delete f.env.ACCOUNT_FAMILY_ROOT_USER_ID;
  assert.equal(f.approval.validateInvitation({ invitationToken: token }).ok, false);
  const status = f.approval.requestStatus({ requestId: request.request_id, statusSecret: request.status_secret });
  assert.equal(status.ok, false); assert.equal(status.reason, 'family_unavailable'); assertNoInvitation(status);
  const listed = f.approval.listRequests({ status: 'approved' }).find(row => row.id === request.request_id);
  assert.equal(listed.status, 'temporarily_unavailable'); assertNoInvitation(listed);
  assert.equal(f.db.prepare('SELECT eligibility_invalidated_at FROM registration_requests WHERE id=?').get(request.request_id).eligibility_invalidated_at, null);
  assert.equal(f.db.prepare('SELECT status FROM registration_requests WHERE id=?').get(request.request_id).status, 'approved');
  assert.equal(count(f, 'registration_requests'), 1);
  f.env.ACCOUNT_FAMILY_ROOT_USER_ID = String(ROOT);
  assert.equal(f.approval.validateInvitation({ invitationToken: token }).ok, true);
  assert.equal(f.sms.length, 1);
});

test('an existing account remains outside the family even when a current root beneficiary happens to match both its contacts', async t => {
  const f = await fixture(t);
  f.beneficiary(ROOT, { name: 'Existing unrelated account', email: 'user-9@example.test', phone: '+27820000009' });
  await f.submit({ email: 'user-9@example.test', phone: '+27820000009' });
  await f.submit({ email: 'outsider@example.test', phone: '+27829990001' });
  assert.equal(count(f, 'family_memberships'), 0); assert.equal(count(f, 'registration_requests'), 0); assert.equal(f.sms.length, 0);
  const legitimateLogin = await f.route('/login', { email: 'user-9@example.test', password: PASSWORD });
  assert.equal(legitimateLogin.status, 200); assert.equal(legitimateLogin.data.requires_second_factor, true);
  assert.equal(f.sms.length, 1, 'preserved existing-account sign-in may still send its normal SMS');
  assert.equal(count(f, 'family_memberships'), 0);
});

test('duplicate eligible family beneficiary contacts allow one deterministic sponsorship and cannot invalidate an existing approved binding', async t => {
  const f = await fixture(t), child = await f.registeredChild();
  const first = f.beneficiary(child.id, GRANDCHILD), rootCopy = f.beneficiary(ROOT, GRANDCHILD);
  assert.notEqual(first, rootCopy);
  const request = await f.submit(GRANDCHILD);
  const row = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(request.request_id);
  assert.ok(row, 'more than one legitimate matching record does not exclude a family applicant');
  assert.equal(row.family_sponsor_user_id, ROOT, 'the configured root is preferred consistently');
  assert.equal(row.family_beneficiary_id, rootCopy);
  const token = f.approve(request);
  f.beneficiary(ROOT, GRANDCHILD);
  f.beneficiary(child.id, GRANDCHILD);
  assert.equal(f.approval.validateInvitation({ invitationToken: token }).ok, true);
  assert.ok(f.approval.requestStatus({ requestId: request.request_id, statusSecret: request.status_secret }).invitation_token);
  assert.equal(f.db.prepare('SELECT family_beneficiary_id FROM registration_requests WHERE id=?').get(request.request_id).family_beneficiary_id, rootCopy);
});

test('blocking an intermediate ancestor never removes a completed descendant membership or its independent sponsorship rights', async t => {
  const f = await fixture(t), child = await f.registeredChild();
  f.beneficiary(child.id, GRANDCHILD);
  const grandchild = await f.registeredChild({ applicant: GRANDCHILD });
  f.db.prepare("UPDATE users SET account_status='blocked' WHERE id=?").run(child.id);
  const greatGrandchild = { name: 'Synthetic great grandchild', email: 'great-grandchild@example.test', phone: '+27821110004' };
  f.beneficiary(grandchild.id, greatGrandchild);
  const request = await f.submit(greatGrandchild);
  const bound = f.db.prepare('SELECT * FROM registration_requests WHERE id=?').get(request.request_id);
  assert.ok(bound); assert.equal(bound.family_sponsor_user_id, grandchild.id);
  assert.equal(f.approval.accountAccess(f.db.prepare('SELECT * FROM users WHERE id=?').get(grandchild.id)).ok, true);
  assert.equal(count(f, 'family_memberships'), 2);
});


test('schema initialization recovers missing open indexes with duplicate quarantined history and remains idempotent', async t => {
  const f = await fixture(t);
  f.db.exec('DROP INDEX idx_registration_open_email; DROP INDEX idx_registration_open_phone');
  const at = new Date().toISOString();
  const insert = f.db.prepare(`INSERT INTO registration_requests(id,name,email,phone_e164,status,status_secret_hash,created_at,updated_at,
    family_sponsor_user_id,family_beneficiary_id,eligibility_invalidated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const status of ['pending', 'approved']) {
    insert.run(crypto.randomUUID(), CHILD.name, CHILD.email, CHILD.phone, status, 'a'.repeat(64), at, at, null, null, at);
  }
  const activeId = crypto.randomUUID();
  insert.run(activeId, CHILD.name, CHILD.email, CHILD.phone, 'pending', 'b'.repeat(64), at, at, ROOT, f.childBeneficiary, null);
  const history = f.db.prepare('SELECT * FROM registration_requests ORDER BY id').all();
  initRegistrationApprovalSchema(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM registration_requests ORDER BY id').all(), history);
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_registration_open_email','idx_registration_open_phone') ORDER BY name").all()
    .map(row => row.name), ['idx_registration_open_email', 'idx_registration_open_phone']);
  assert.throws(() => insert.run(crypto.randomUUID(), CHILD.name, CHILD.email, CHILD.phone, 'approved', 'c'.repeat(64), at, at, ROOT, f.childBeneficiary, null), /UNIQUE/,
    'recreated indexes still reject another live application using occupied contacts');
  insert.run(crypto.randomUUID(), CHILD.name, CHILD.email, CHILD.phone, 'approved', 'd'.repeat(64), at, at, null, null, at);
  const withFurtherHistory = f.db.prepare('SELECT * FROM registration_requests ORDER BY id').all();
  initRegistrationApprovalSchema(f.db); initRegistrationApprovalSchema(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM registration_requests ORDER BY id').all(), withFurtherHistory);
  assert.equal(f.db.prepare('SELECT eligibility_invalidated_at FROM registration_requests WHERE id=?').get(activeId).eligibility_invalidated_at, null);
  assert.equal(count(f, 'registration_denials'), 0); assert.equal(count(f, 'family_memberships'), 0); assert.equal(f.sms.length, 0);
});
