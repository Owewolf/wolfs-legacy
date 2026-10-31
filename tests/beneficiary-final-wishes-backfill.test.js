'use strict';

// Only synthetic in-memory/disposable databases are used. Importing the repair
// helper does not initialize the deployed vault or start application workers.
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const Database = require('better-sqlite3');

process.env.ENCRYPTION_KEY = 'b4'.repeat(32);
process.env.HOMEBANK_OWNER_EMAIL = 'separate-homebank-owner@example.test';
process.env.NOTIFICATIONS_ENABLED = 'false';
const { encrypt, decrypt, hashToken } = require('../server/crypto');
const legacy = require('../server/legacy-content');
const { ensureBeneficiaryFinalWish, backfillBeneficiaryFinalWishes } = require('../server/beneficiary-final-wishes');
const OWNER = 831, OTHER = 832;
const TABLES = ['users', 'beneficiaries', 'vault_entries', 'managed_documents', 'legacy_contents',
  'legacy_content_beneficiaries', 'legacy_content_versions', 'legacy_content_reviews',
  'legacy_content_acknowledgements', 'legacy_content_links', 'legacy_release_events', 'audit_log', 'notification_outbox'];
let db;

function beneficiary(name, userId = OWNER) {
  return Number(db.prepare(`INSERT INTO beneficiaries(user_id,name,access_token,token_expires_at)
    VALUES(?,?,?,'2099-01-01T00:00:00.000Z')`)
    .run(userId, name, hashToken(`synthetic-token-${userId}-${name}`)).lastInsertRowid);
}
function snapshot() {
  return Object.fromEntries(TABLES.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}
function rows(table) { return db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(); }
function oldGeneratedDraft(id, overrides = {}) {
  const person = db.prepare('SELECT * FROM beneficiaries WHERE id=?').get(id);
  return legacy.save(db, person.user_id, {
    type: 'instruction', title: `Final Wishes for ${person.name.trim()}`, body_markdown: '',
    status: 'draft', release_policy: 'owner_only', beneficiary_ids: [id],
    metadata: {
      final_wishes: { category: '', details: '', contact_person: '', contact_phone: '', notes: '' },
      origin: { type: 'beneficiary', beneficiary_id: id }
    }, ...overrides
  });
}

before(() => {
  db = new Database(':memory:');
  const databaseModule = require.cache[require.resolve('better-sqlite3')];
  const originalConstructor = databaseModule.exports;
  databaseModule.exports = function FixtureDatabase(filename) {
    assert.equal(filename, path.resolve(__dirname, '../data/vault.db'));
    return db;
  };
  try { assert.equal(require('../server/db').getDb(), db); }
  finally { databaseModule.exports = originalConstructor; }
  const insert = db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)');
  insert.run(OWNER, 'synthetic-backfill-owner@example.test', 'Synthetic owner', 'synthetic-hash');
  insert.run(OTHER, 'synthetic-backfill-other@example.test', 'Synthetic other', 'synthetic-hash');
});

beforeEach(() => {
  db.exec(`DROP TRIGGER IF EXISTS fixture_backfill_mapping_failure;
    DROP TRIGGER IF EXISTS fixture_backfill_audit_failure;
    DROP TRIGGER IF EXISTS fixture_upgrade_audit_failure;
    DELETE FROM legacy_contents;
    DELETE FROM managed_documents;
    DELETE FROM beneficiaries;
    DELETE FROM vault_entries;
    DELETE FROM audit_log;
    DELETE FROM notification_outbox;`);
});

after(() => { if (db?.open) db.close(); });

test('backfill creates an encrypted editable owner-only draft for every existing unassigned beneficiary', () => {
  const ids = [beneficiary('  Synthetic first  '), beneficiary('Synthetic second'), beneficiary('Synthetic other', OTHER)];
  const existingBeneficiaries = rows('beneficiaries');
  const originalEvents = rows('legacy_release_events');
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 3, total: 3 });
  assert.deepEqual(rows('beneficiaries'), existingBeneficiaries, 'tokens, access and original beneficiary rows are unchanged');
  assert.equal(rows('vault_entries').length, 0);
  assert.equal(rows('notification_outbox').length, 0);
  assert.equal(rows('legacy_contents').length, 3);
  assert.equal(rows('legacy_content_versions').length, 0);
  assert.deepEqual(rows('legacy_release_events').slice(0, originalEvents.length), originalEvents);
  assert.deepEqual(rows('legacy_release_events').slice(originalEvents.length).map(x => x.event_type), ['created', 'created', 'created']);
  assert.deepEqual(rows('audit_log').map(x => x.action), ['legacy_created', 'legacy_created', 'legacy_created']);
  for (const id of ids) {
    const person = existingBeneficiaries.find(row => row.id === id);
    const mapping = db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE beneficiary_id=?').get(id);
    const raw = db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(mapping.content_id);
    assert.equal(raw.user_id, person.user_id);
    assert.equal(raw.type, 'instruction');
    assert.equal(raw.status, 'draft');
    assert.equal(raw.release_policy, 'owner_only');
    assert.equal(raw.final_wishes_entry_id, null);
    assert.equal(raw.revision, 1);
    assert.equal(raw.review_enabled, 0);
    assert.equal(mapping.released_at, null);
    assert.equal(mapping.revoked_at, null);
    assert.equal(mapping.release_scope, null);
    assert.ok(!raw.payload_encrypted.includes(person.name.trim()));
    const payload = JSON.parse(decrypt(raw.payload_encrypted));
    assert.equal(payload.title, person.name.trim());
    assert.equal(payload.body_markdown, '');
    assert.deepEqual(payload.metadata.final_wishes, { content_type: '', category: 'Beneficiary Instructions', details: '', contact_person: '', contact_phone: '', notes: '' });
    assert.deepEqual(payload.metadata.origin, { type: 'beneficiary', beneficiary_id: id });
    assert.equal(legacy.canRead(db, { ...person, access_granted: 1 }, raw), false);
    assert.deepEqual(legacy.list(db, person.user_id, { beneficiary_id: id }).map(item => item.id), [raw.id]);
  }
  const first = legacy.list(db, OWNER, { beneficiary_id: ids[0] })[0];
  const edited = legacy.save(db, OWNER, { body_markdown: 'Synthetic edited message' }, first.id);
  assert.equal(edited.body_markdown, 'Synthetic edited message');
  assert.equal(edited.revision, 2);
});

test('repeating repair and shared new-beneficiary creation does not add duplicates or rewrite saved ciphertext', () => {
  const id = beneficiary('Synthetic existing');
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 1, total: 1 });
  const saved = snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: 1 });
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: 1 });
  assert.deepEqual(ensureBeneficiaryFinalWish(db, OWNER, id), { id: saved.legacy_contents[0].id, created: false });
  assert.deepEqual(snapshot(), saved);
  const added = beneficiary('Synthetic newly added');
  const created = ensureBeneficiaryFinalWish(db, OWNER, added);
  assert.equal(created.created, true);
  assert.notEqual(created.id, saved.legacy_contents[0].id);
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: 2 });
  assert.equal(rows('legacy_contents').length, 2);
});

test('repair normalizes three pristine generated drafts in place and retains unknown metadata and all recipients', () => {
  const ids = [beneficiary('  Synthetic first  '), beneficiary('Synthetic second'), beneficiary('Synthetic third')];
  const originals = ids.map(id => oldGeneratedDraft(id));
  const third = originals[2];
  const metadata = { ...third.metadata, future_extension: { preserve: 'Synthetic unknown value' },
    final_wishes: { ...third.metadata.final_wishes, future_setting: { preserve: true } } };
  // Preserve an unknown extension without recording an authored content edit.
  db.prepare('UPDATE legacy_contents SET payload_encrypted=? WHERE id=?')
    .run(encrypt(JSON.stringify({ title: third.title, body_markdown: '', introduction: '', description: '', metadata })), third.id);
  legacy.review(db, OWNER, third.id, { action: 'reschedule', next_review_at: '2099-05-06' });
  const beneficiariesBefore = rows('beneficiaries'), mappingsBefore = rows('legacy_content_beneficiaries');
  const reviewsBefore = rows('legacy_content_reviews'), eventsBefore = rows('legacy_release_events');
  assert.equal(legacy.owned(db, OWNER, third.id).review_enabled, 1);

  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: 3 });
  assert.deepEqual(rows('beneficiaries'), beneficiariesBefore);
  assert.deepEqual(rows('legacy_content_beneficiaries'), mappingsBefore);
  assert.deepEqual(rows('legacy_content_reviews'), reviewsBefore, 'review history is retained');
  assert.deepEqual(rows('legacy_release_events').slice(0, eventsBefore.length), eventsBefore);
  assert.equal(rows('legacy_contents').length, 3);
  for (const original of originals) {
    const saved = legacy.toView(db, legacy.owned(db, OWNER, original.id));
    const person = beneficiariesBefore.find(row => row.id === original.beneficiary_ids[0]);
    assert.equal(saved.title, person.name.trim());
    assert.equal(saved.metadata.final_wishes.content_type, '');
    assert.equal(saved.metadata.final_wishes.category, 'Beneficiary Instructions');
    assert.equal(saved.body_markdown, '');
    assert.equal(saved.description, '');
    assert.equal(saved.introduction, '');
    assert.equal(saved.review_enabled, false);
    assert.equal(saved.next_review_at, null);
    assert.equal(saved.release_policy, 'owner_only');
    assert.equal(saved.status, 'draft');
    assert.equal(saved.revision, 2);
    assert.deepEqual(saved.beneficiary_ids, original.beneficiary_ids);
    assert.equal(saved.versions[0].payload.title, original.title, 'the original generated payload remains versioned');
  }
  const updatedThird = legacy.toView(db, legacy.owned(db, OWNER, third.id));
  assert.deepEqual(updatedThird.metadata, { ...metadata, final_wishes: { ...metadata.final_wishes, content_type: '', category: 'Beneficiary Instructions' } });
  const repaired = snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: 3 });
  assert.deepEqual(snapshot(), repaired, 'repeating startup leaves repaired ciphertext and history unchanged');
});

test('repair preserves authored or explicitly selected content even when its old generated title remains', () => {
  const protectedDrafts = [];
  function add(label, changes) {
    const id = beneficiary('Synthetic protected ' + label);
    const base = { final_wishes: { category: '', details: '', contact_person: '', contact_phone: '', notes: '' },
      origin: { type: 'beneficiary', beneficiary_id: id } };
    protectedDrafts.push(oldGeneratedDraft(id, typeof changes === 'function' ? changes(base) : changes));
  }
  add('title', { title: 'An owner-written title' });
  add('body', { body_markdown: 'An owner-written message' });
  add('introduction', { introduction: 'A personal introduction' });
  add('description', { description: 'A personal description' });
  add('wish category', metadata => ({ metadata: { ...metadata, final_wishes: { ...metadata.final_wishes, category: 'Owner chosen category' } } }));
  add('wish details', metadata => ({ metadata: { ...metadata, final_wishes: { ...metadata.final_wishes, details: 'Written wishes' } } }));
  add('type metadata', metadata => ({ metadata: { ...metadata, category: 'properties' } }));
  add('explicit content choice', metadata => ({ metadata: { ...metadata, final_wishes: { ...metadata.final_wishes, content_type: 'instruction' } } }));
  add('type', { type: 'letter' });
  add('archive', { status: 'archived' });
  add('ready', { status: 'ready' });
  add('policy', { release_policy: 'manual_release' });
  add('origin', metadata => ({ metadata: { ...metadata, origin: { type: 'manual' } } }));
  add('wrong origin recipient', metadata => ({ metadata: { ...metadata, origin: { type: 'beneficiary', beneficiary_id: 999999 } } }));
  const savedId = beneficiary('Synthetic explicitly saved');
  const saved = oldGeneratedDraft(savedId);
  legacy.save(db, OWNER, { title: saved.title }, saved.id);
  protectedDrafts.push(saved);
  const before = snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: protectedDrafts.length });
  assert.deepEqual(snapshot(), before, 'owner content, choices, custom titles and edited revisions are unchanged');
});

test('repair preserves generated drafts with attachments, vault links, acknowledgements or release history', () => {
  const ids = ['attachment', 'link', 'acknowledgement', 'release'].map(label => beneficiary('Synthetic protected ' + label));
  const drafts = ids.map(id => oldGeneratedDraft(id));
  db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,stored_filename,mime_type,size_bytes,sha256)
    VALUES('synthetic-attachment',?,?,?,?,?,?,?)`)
    .run(OWNER, encrypt('Synthetic.txt'), encrypt('Synthetic.txt'), 'synthetic.bin', 'text/plain', 1, 'a'.repeat(64));
  db.prepare('INSERT INTO legacy_content_attachments(content_id,document_id) VALUES(?,?)').run(drafts[0].id, 'synthetic-attachment');
  const entryId = Number(db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,?,?,?)')
    .run(OWNER, 'property', 'Synthetic linked record', encrypt('{}')).lastInsertRowid);
  db.prepare('INSERT INTO legacy_content_links(content_id,entry_id) VALUES(?,?)').run(drafts[1].id, entryId);
  db.prepare('INSERT INTO legacy_content_acknowledgements VALUES(?,?,?,?,?)').run(drafts[2].id, ids[2], 'synthetic-step', 1, '2026-01-01T00:00:00Z');
  db.prepare("UPDATE legacy_content_beneficiaries SET revoked_at='2026-01-01T00:00:00Z' WHERE content_id=?").run(drafts[3].id);
  const before = snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: 4 });
  assert.deepEqual(snapshot(), before);
});

for (const action of ['legacy_updated', 'legacy_created']) {
  test(`normalization and missing-draft creation share one transaction when ${action} auditing fails`, () => {
    const id = beneficiary('Synthetic old generated');
    oldGeneratedDraft(id);
    beneficiary('Synthetic missing draft');
    const before = snapshot();
    db.exec(`CREATE TRIGGER fixture_upgrade_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='${action}'
      BEGIN SELECT RAISE(ABORT,'synthetic normalization failure'); END;`);
    assert.throws(() => backfillBeneficiaryFinalWishes(db), /synthetic normalization failure/);
    assert.deepEqual(snapshot(), before);
    db.exec('DROP TRIGGER fixture_upgrade_audit_failure');
    assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 1, total: 2 });
    assert.equal(rows('legacy_contents').length, 2);
    assert.ok(legacy.list(db, OWNER).every(item => item.metadata.final_wishes.content_type === '' && item.metadata.final_wishes.category === 'Beneficiary Instructions'));
  });
}

test('edited, archived and released assigned content remains byte-for-byte unchanged', () => {
  const editedId = beneficiary('Synthetic edited recipient');
  const archivedId = beneficiary('Synthetic archived recipient');
  const releasedId = beneficiary('Synthetic released recipient');
  const missingId = beneficiary('Synthetic missing recipient');
  const recordId = Number(db.prepare('INSERT INTO vault_entries(user_id,section,title,fields_encrypted) VALUES(?,?,?,?)')
    .run(OWNER, 'property', 'Synthetic related record', encrypt('{}')).lastInsertRowid);
  const edited = legacy.save(db, OWNER, { type: 'letter', title: 'Custom synthetic letter', beneficiary_ids: [editedId],
    body_markdown: 'Original text', metadata: { custom: 'preserved' }, links: [{ entry_id: recordId }] });
  legacy.save(db, OWNER, { body_markdown: 'Edited text' }, edited.id);
  legacy.save(db, OWNER, { type: 'family_history', title: 'Archived synthetic story', status: 'archived', beneficiary_ids: [archivedId] });
  const released = legacy.save(db, OWNER, { type: 'letter', title: 'Released synthetic letter', status: 'ready',
    release_policy: 'manual_release', beneficiary_ids: [releasedId] });
  db.prepare('UPDATE beneficiaries SET access_granted=1 WHERE id=?').run(releasedId);
  legacy.manualRelease(db, OWNER, released.id, { confirm: true, beneficiary_ids: [releasedId] });
  const original = snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 1, total: 4 });
  const updated = snapshot();
  for (const table of TABLES) {
    for (const row of original[table]) assert.ok(updated[table].some(saved => JSON.stringify(saved) === JSON.stringify(row)), table + ' preserves every original row');
  }
  assert.equal(updated.legacy_contents.length, original.legacy_contents.length + 1);
  assert.equal(updated.legacy_content_beneficiaries.length, original.legacy_content_beneficiaries.length + 1);
  const mapping = updated.legacy_content_beneficiaries.find(row => row.beneficiary_id === missingId);
  assert.ok(mapping);
  const beforeRepeat = snapshot();
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 0, total: 4 });
  assert.deepEqual(snapshot(), beforeRepeat);
});

test('same-name and cross-owner assignments never suppress another owner\'s missing draft', () => {
  const ownerId = beneficiary('Synthetic shared name');
  const otherId = beneficiary('Synthetic shared name', OTHER);
  const foreign = legacy.save(db, OTHER, { type: 'letter', title: 'Other owner custom letter', beneficiary_ids: [otherId] });
  // The schema permits this historical malformed mapping, but an unrelated
  // owner's content must never satisfy the owner-scoped repair check.
  db.prepare('INSERT INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES(?,?)').run(foreign.id, ownerId);
  const before = snapshot();
  assert.throws(() => ensureBeneficiaryFinalWish(db, OTHER, ownerId), { status: 404 });
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 1, total: 2 });
  const own = legacy.list(db, OWNER, { beneficiary_id: ownerId });
  assert.equal(own.length, 1);
  assert.equal(own[0].title, 'Synthetic shared name');
  assert.equal(own[0].metadata.origin.beneficiary_id, ownerId);
  assert.deepEqual(legacy.list(db, OTHER).map(row => row.id), [foreign.id]);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_contents WHERE id=?').get(foreign.id), before.legacy_contents[0]);
});

for (const failure of ['mapping', 'audit']) {
  test(`a mid-backfill ${failure} failure rolls back all newly created drafts and audit events`, () => {
    beneficiary('Synthetic first');
    const second = beneficiary('Synthetic second');
    beneficiary('Synthetic third', OTHER);
    const before = snapshot();
    if (failure === 'mapping') {
      db.exec(`CREATE TRIGGER fixture_backfill_mapping_failure BEFORE INSERT ON legacy_content_beneficiaries
        WHEN NEW.beneficiary_id=${second} BEGIN SELECT RAISE(ABORT,'synthetic mapping failure'); END;`);
    } else {
      db.exec(`CREATE TRIGGER fixture_backfill_audit_failure BEFORE INSERT ON audit_log
        WHEN NEW.action='legacy_created' AND (SELECT COUNT(*) FROM legacy_contents)=2
        BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`);
    }
    assert.throws(() => backfillBeneficiaryFinalWishes(db), new RegExp('synthetic ' + failure + ' failure'));
    assert.deepEqual(snapshot(), before);
    db.exec('DROP TRIGGER fixture_backfill_' + failure + '_failure');
    assert.deepEqual(backfillBeneficiaryFinalWishes(db), { created: 3, total: 3 });
    assert.equal(rows('legacy_contents').length, 3);
  });
}

test('concurrent independent SQLite repair connections serialize before checking for missing assignments', async () => {
  for (let index = 0; index < 6; index++) beneficiary('Synthetic concurrent ' + index);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-beneficiary-backfill-'));
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, 'synthetic.db');
  const workers = [];
  try {
    await db.backup(databasePath);
    fs.chmodSync(databasePath, 0o600);
    const source = `const {parentPort,workerData}=require('node:worker_threads');
      const Database=require(workerData.databaseModule);
      const repair=require(workerData.helperModule).backfillBeneficiaryFinalWishes;
      const db=new Database(workerData.databasePath,{timeout:10000});
      db.pragma('foreign_keys=ON');
      parentPort.postMessage('ready');
      parentPort.once('message',()=>{
        try{parentPort.postMessage({result:repair(db)});}catch(error){parentPort.postMessage({error:error.message});}
        finally{db.close();parentPort.close();}
      });`;
    for (let index = 0; index < 2; index++) {
      const worker = new Worker(source, { eval: true, workerData: {
        databaseModule: require.resolve('better-sqlite3'), helperModule: require.resolve('../server/beneficiary-final-wishes'), databasePath
      } });
      workers.push(worker);
    }
    const ready = await Promise.all(workers.map(worker => once(worker, 'message')));
    assert.deepEqual(ready, [['ready'], ['ready']]);
    const results = workers.map(worker => once(worker, 'message'));
    workers.forEach(worker => worker.postMessage('start'));
    const outcomes = (await Promise.all(results)).map(([message]) => {
      assert.equal(message.error, undefined);
      return message.result;
    });
    assert.deepEqual(outcomes.map(result => result.created).sort(), [0, 6]);
    assert.ok(outcomes.every(result => result.total === 6));
    const repaired = new Database(databasePath, { readonly: true });
    try {
      assert.equal(repaired.prepare('SELECT COUNT(*) AS n FROM legacy_contents').get().n, 6);
      assert.deepEqual(repaired.prepare('SELECT COUNT(*) AS n FROM legacy_content_beneficiaries GROUP BY beneficiary_id').all().map(row => row.n), [1, 1, 1, 1, 1, 1]);
      assert.equal(repaired.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
    } finally { repaired.close(); }
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
