'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./helpers/email-fixture');
const { initLegacySchema } = require('../server/legacy-schema');
process.env.ENCRYPTION_KEY = 'de'.repeat(32);
const { encrypt } = require('../server/crypto');
function fixture(t) {
  const f = createFixture(t);
  f.db.exec('CREATE TABLE vault_entries(id INTEGER PRIMARY KEY); CREATE TABLE managed_documents(id TEXT PRIMARY KEY);');
  initLegacySchema(f.db);
  const insert = f.db.prepare(`INSERT INTO legacy_contents
    (id,user_id,type,payload_encrypted,status,release_policy,created_at,updated_at)
    VALUES(?,1,'letter',?,?,?,?,?)`);
  for (const [id, status, policy] of [
    ['switch-ready', 'ready', 'dead_switch_release'], ['already-granted', 'ready', 'dead_switch_release'],
    ['private', 'ready', 'owner_only'], ['manual', 'ready', 'manual_release'],
    ['emergency', 'ready', 'emergency_access_release'], ['draft', 'draft', 'dead_switch_release'],
    ['archived', 'archived', 'dead_switch_release']
  ]) {
    insert.run(id, encrypt(JSON.stringify({ title: 'Synthetic private message' })), status, policy, f.instant, f.instant);
    f.db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,?)').run(id, id === 'already-granted' ? 2 : 1);
  }
  return f;
}
const mappings = f => f.db.prepare('SELECT * FROM legacy_content_beneficiaries ORDER BY content_id').all();

test('only the configured switch trigger releases ready switch items, including existing access holders', t => {
  const f = fixture(t);
  f.service.reconcile();
  assert.equal(f.jobs().length, 5);
  const before = mappings(f);
  f.issueReminder();
  assert.deepEqual(mappings(f), before, 'ordinary reminder must not release');
  f.setDay(36);
  assert.equal(f.service.releaseDue(), 0);
  assert.deepEqual(mappings(f), before);
  f.setDay(37);
  const existingGrant = f.beneficiaries()[1].access_granted_at;
  assert.equal(f.service.releaseDue(), 1);
  const released = mappings(f).filter(row => row.released_at);
  assert.deepEqual(released.map(row => row.content_id), ['already-granted', 'switch-ready']);
  assert.ok(released.every(row => row.release_scope === 'dead_switch_release' && row.released_at === f.instant));
  assert.equal(f.beneficiaries()[1].access_granted_at, existingGrant);
  const events = f.db.prepare('SELECT * FROM legacy_release_events').all();
  assert.equal(events.filter(event => event.event_type === 'released').length, 2);
  assert.equal(events.filter(event => event.event_type === 'release_condition').length, 1);
  assert.equal(f.service.releaseDue(), 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM legacy_release_events').all(), events);
  const after = mappings(f);
  f.setDay(38); f.service.signedInCheckin(1);
  assert.deepEqual(mappings(f), after, 'late check-in must preserve existing item releases');
  assert.ok(f.beneficiaries().every(b => b.access_granted));
});

test('replaying a consumed switch occurrence never releases later content or recipient mappings', t => {
  const f = fixture(t);
  f.service.reconcile(); f.setDay(37); f.service.releaseDue();
  f.db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,?)').run('switch-ready', 2);
  f.db.prepare(`INSERT INTO legacy_contents(id,user_id,type,payload_encrypted,status,release_policy,created_at,updated_at)
    VALUES('later-content',1,'letter',?,'ready','dead_switch_release',?,?)`)
    .run(encrypt(JSON.stringify({ title: 'Prepared after release' })), f.instant, f.instant);
  f.db.prepare("INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES('later-content',1)").run();
  const { releaseForEvent } = require('../server/legacy-content');
  assert.equal(releaseForEvent(f.db, { userId: 1, policy: 'dead_switch_release',
    eventKey: `dead-switch:${f.config().notification_cycle_id}`, at: f.instant }), 0);
  assert.equal(f.db.prepare("SELECT released_at FROM legacy_content_beneficiaries WHERE content_id='later-content'").get().released_at, null);
  assert.equal(f.db.prepare("SELECT released_at FROM legacy_content_beneficiaries WHERE content_id='switch-ready' AND beneficiary_id=2").get().released_at, null);
});

test('switch, grants, content releases and notification rollback together on durable release failure', t => {
  const f = fixture(t);
  f.service.reconcile();
  const before = { config: f.config(), beneficiaries: f.beneficiaries(), mappings: mappings(f), jobs: f.jobs() };
  f.setDay(37);
  f.db.exec("CREATE TRIGGER fixture_release_failure BEFORE INSERT ON legacy_release_events BEGIN SELECT RAISE(ABORT,'fixture release unavailable'); END");
  assert.throws(() => f.service.releaseDue(), /fixture release unavailable/);
  assert.deepEqual({ config: f.config(), beneficiaries: f.beneficiaries(), mappings: mappings(f), jobs: f.jobs() }, before);
  assert.equal(f.jobs('deadswitch_released').length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_release_events').get().n, 0);
});
