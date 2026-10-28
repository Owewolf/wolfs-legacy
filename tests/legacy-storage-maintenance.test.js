'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { maintenance, MIN_AGE_MS } = require('../scripts/maintenance-legacy-storage');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-legacy-maintenance-'));
  const storageRoot = path.join(root, 'managed'), databasePath = path.join(root, 'vault.db');
  for (const folder of [storageRoot, path.join(storageRoot, '.incoming'), path.join(storageRoot, 'owner-1')]) fs.mkdirSync(folder, { mode: 0o700 });
  const db = new Database(databasePath); db.exec('CREATE TABLE managed_documents(id TEXT,stored_filename TEXT,status TEXT)');
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const names = {
    tracked: 'owner-1/00000000-0000-4000-8000-000000000001.wav',
    unassigned: 'owner-1/00000000-0000-4000-8000-000000000002.wav',
    orphan: 'owner-1/00000000-0000-4000-8000-000000000003.wav',
    incoming: '.incoming/upload-00000000-0000-4000-8000-000000000004',
    unknown: 'owner-1/not-an-app-original.wav'
  };
  for (const relative of Object.values(names)) fs.writeFileSync(path.join(storageRoot, relative), 'synthetic bytes', { mode: 0o600 });
  db.prepare('INSERT INTO managed_documents VALUES(?,?,?)').run('tracked', names.tracked, 'active');
  db.prepare('INSERT INTO managed_documents VALUES(?,?,?)').run('unassigned', names.unassigned, 'unassigned');
  return { root, db, storageRoot, databasePath, names, now: Date.now() + MIN_AGE_MS * 2 };
}

test('maintenance reports only aged generated orphans/temporary uploads and leaves all bytes intact by default', t => {
  const f = fixture(t), report = maintenance(f);
  assert.equal(report.mode, 'report_only');
  assert.deepEqual(report.candidates.map(item => item.path).sort(), [f.names.orphan, f.names.incoming].sort());
  for (const relative of Object.values(f.names)) assert.ok(fs.existsSync(path.join(f.storageRoot, relative)));
});

test('maintenance preserves recent files even when they are untracked', t => {
  const f = fixture(t), report = maintenance({ ...f, now: Date.now() });
  assert.deepEqual(report.candidates, []); assert.equal(report.preservedRecent, 2);
});

test('explicit stopped purge removes only aged generated candidates and preserves active/unassigned copies and originals', t => {
  const f = fixture(t);
  assert.throws(() => maintenance({ ...f, purge: true }), /Stop all application writers/);
  const report = maintenance({ ...f, purge: true, serviceStopped: true });
  assert.equal(report.mode, 'purged');
  for (const relative of [f.names.orphan, f.names.incoming]) assert.equal(fs.existsSync(path.join(f.storageRoot, relative)), false);
  for (const relative of [f.names.tracked, f.names.unassigned, f.names.unknown]) assert.ok(fs.existsSync(path.join(f.storageRoot, relative)));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM managed_documents').get().n, 2);
});

test('symlink and invalid database candidates abort before any purge', t => {
  const f = fixture(t), target = path.join(f.storageRoot, f.names.orphan);
  fs.unlinkSync(target); fs.symlinkSync(path.join(f.storageRoot, f.names.tracked), target);
  assert.throws(() => maintenance({ ...f, purge: true, serviceStopped: true }), /Unsafe candidate/);
  assert.ok(fs.existsSync(path.join(f.storageRoot, f.names.incoming)));
  assert.ok(fs.existsSync(path.join(f.storageRoot, f.names.tracked)));
  const invalid = path.join(f.root, 'not-a-database'); fs.writeFileSync(invalid, 'invalid', { mode: 0o600 });
  assert.throws(() => maintenance({ ...f, databasePath: invalid, purge: true, serviceStopped: true }));
  assert.ok(fs.existsSync(path.join(f.storageRoot, f.names.incoming)));
});
