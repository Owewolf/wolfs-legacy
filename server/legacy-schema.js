'use strict';

// Additive, idempotent migration. No existing vault entry, token or switch state
// is rewritten. Restricted payloads never live in vault_entries.
function initLegacySchema(db) {
  const expected = {
    legacy_schema_migrations: ['version','applied_at'],
    legacy_contents: ['id','user_id','final_wishes_entry_id','type','payload_encrypted','status','release_policy','revision','review_enabled','review_interval_months','last_reviewed_at','next_review_at','review_snoozed_until','created_at','updated_at'],
    legacy_content_beneficiaries: ['content_id','beneficiary_id','released_at','revoked_at','release_scope'],
    legacy_content_attachments: ['content_id','document_id','display_order'],
    legacy_content_links: ['content_id','entry_id'],
    legacy_content_versions: ['id','content_id','revision','payload_encrypted','editor_id','created_at'],
    legacy_content_reviews: ['id','content_id','reviewer_id','action','next_review_at','created_at'],
    legacy_content_acknowledgements: ['content_id','beneficiary_id','step_id','acknowledged','updated_at'],
    legacy_release_events: ['id','user_id','content_id','beneficiary_id','event_type','event_key','created_at'],
    legacy_content_deletion_permissions: ['content_id','user_id'],
    legacy_beneficiary_wish_suppressions: ['user_id','beneficiary_id','created_at']
  };
  db.transaction(() => {
    for (const [table, columns] of Object.entries(expected)) {
      const actual = db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
      if (actual.length && columns.some(c=>!actual.includes(c))) throw new Error('Incomplete legacy schema: '+table);
    }
    if (!db.prepare('PRAGMA table_info(managed_documents)').all().some(c => c.name === 'legacy_restricted')) {
      db.exec('ALTER TABLE managed_documents ADD COLUMN legacy_restricted INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS legacy_contents (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      final_wishes_entry_id INTEGER REFERENCES vault_entries(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK(type IN ('letter','recording','family_history','instruction','review')),
      payload_encrypted TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','released','archived')),
      release_policy TEXT NOT NULL DEFAULT 'owner_only' CHECK(release_policy IN ('owner_only','manual_release','dead_switch_release','emergency_access_release')),
      revision INTEGER NOT NULL DEFAULT 1,
      review_enabled INTEGER NOT NULL DEFAULT 0,
      review_interval_months INTEGER NOT NULL DEFAULT 12,
      last_reviewed_at TEXT,
      next_review_at TEXT,
      review_snoozed_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_owner ON legacy_contents(user_id,type,status);
    CREATE TABLE IF NOT EXISTS legacy_content_beneficiaries (
      content_id TEXT NOT NULL REFERENCES legacy_contents(id) ON DELETE CASCADE,
      beneficiary_id INTEGER NOT NULL REFERENCES beneficiaries(id) ON DELETE CASCADE,
      released_at TEXT,
      revoked_at TEXT,
      release_scope TEXT,
      PRIMARY KEY(content_id,beneficiary_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_content_attachments (
      content_id TEXT NOT NULL REFERENCES legacy_contents(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES managed_documents(id) ON DELETE RESTRICT,
      display_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(content_id,document_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_content_links (
      content_id TEXT NOT NULL REFERENCES legacy_contents(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
      PRIMARY KEY(content_id,entry_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_content_versions (
      id INTEGER PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES legacy_contents(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      payload_encrypted TEXT NOT NULL,
      editor_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(content_id,revision)
    );
    CREATE TABLE IF NOT EXISTS legacy_content_reviews (
      id INTEGER PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES legacy_contents(id) ON DELETE CASCADE,
      reviewer_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      next_review_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_content_acknowledgements (
      content_id TEXT NOT NULL REFERENCES legacy_contents(id) ON DELETE CASCADE,
      beneficiary_id INTEGER NOT NULL REFERENCES beneficiaries(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      acknowledged INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(content_id,beneficiary_id,step_id)
    );
    CREATE TABLE IF NOT EXISTS legacy_release_events (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      content_id TEXT,
      beneficiary_id INTEGER,
      event_type TEXT NOT NULL,
      event_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_events_owner ON legacy_release_events(user_id,content_id);
    CREATE TABLE IF NOT EXISTS legacy_content_deletion_permissions (
      content_id TEXT PRIMARY KEY REFERENCES legacy_contents(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS legacy_beneficiary_wish_suppressions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      beneficiary_id INTEGER NOT NULL REFERENCES beneficiaries(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,beneficiary_id)
    );
    CREATE TRIGGER IF NOT EXISTS legacy_events_no_update BEFORE UPDATE ON legacy_release_events
      BEGIN SELECT RAISE(ABORT,'Legacy events are append-only'); END;
    DROP TRIGGER IF EXISTS legacy_events_no_delete;
    CREATE TRIGGER legacy_events_no_delete BEFORE DELETE ON legacy_release_events
      WHEN NOT EXISTS (
        SELECT 1 FROM legacy_content_deletion_permissions p
        JOIN legacy_contents c ON c.id=p.content_id AND c.user_id=p.user_id
        WHERE p.content_id=OLD.content_id
      )
      BEGIN SELECT RAISE(ABORT,'Legacy events are append-only'); END;
    INSERT OR IGNORE INTO legacy_schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT OR IGNORE INTO legacy_schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  })();
}
module.exports = { initLegacySchema };
