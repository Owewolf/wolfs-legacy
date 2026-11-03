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
    legacy_beneficiary_wish_suppressions: ['user_id','beneficiary_id','created_at'],
    legacy_beneficiary_auto_wishes: ['beneficiary_id','content_id','owner_user_id','created_at'],
    legacy_beneficiary_auto_wish_retirements: ['content_id','owner_user_id','beneficiary_id','retired_at']
  };
  db.transaction(() => {
    for (const [table, columns] of Object.entries(expected)) {
      const actual = db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
      if (actual.length && columns.some(c=>!actual.includes(c))) throw new Error('Incomplete legacy schema: '+table);
    }
    if (!db.prepare('PRAGMA table_info(managed_documents)').all().some(c => c.name === 'legacy_restricted')) {
      db.exec('ALTER TABLE managed_documents ADD COLUMN legacy_restricted INTEGER NOT NULL DEFAULT 0');
    }
    if (!db.prepare('PRAGMA table_info(beneficiaries)').all().some(c => c.name === 'auto_wish_access_revoked_at')) {
      db.exec('ALTER TABLE beneficiaries ADD COLUMN auto_wish_access_revoked_at TEXT');
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
    CREATE TABLE IF NOT EXISTS legacy_beneficiary_auto_wishes (
      beneficiary_id INTEGER PRIMARY KEY REFERENCES beneficiaries(id) ON DELETE CASCADE,
      content_id TEXT NOT NULL UNIQUE REFERENCES legacy_contents(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_auto_wish_owner ON legacy_beneficiary_auto_wishes(owner_user_id);
    CREATE TABLE IF NOT EXISTS legacy_beneficiary_auto_wish_retirements (
      content_id TEXT PRIMARY KEY REFERENCES legacy_contents(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      beneficiary_id INTEGER NOT NULL,
      retired_at TEXT NOT NULL
    );
    DROP TRIGGER IF EXISTS legacy_auto_wish_validate_insert;
    CREATE TRIGGER legacy_auto_wish_validate_insert BEFORE INSERT ON legacy_beneficiary_auto_wishes
      WHEN NOT EXISTS(SELECT 1 FROM beneficiaries b JOIN legacy_contents c ON c.user_id=b.user_id
        WHERE b.id=NEW.beneficiary_id AND c.id=NEW.content_id AND b.user_id=NEW.owner_user_id)
        OR EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wish_retirements WHERE content_id=NEW.content_id)
        OR (SELECT COUNT(*) FROM legacy_content_beneficiaries WHERE content_id=NEW.content_id)<>1
        OR NOT EXISTS(SELECT 1 FROM legacy_content_beneficiaries
          WHERE content_id=NEW.content_id AND beneficiary_id=NEW.beneficiary_id)
      BEGIN SELECT RAISE(ABORT,'Automatic wish ownership or recipient mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_auto_wish_identity_immutable BEFORE UPDATE ON legacy_beneficiary_auto_wishes
      BEGIN SELECT RAISE(ABORT,'Automatic wish identity cannot be changed'); END;
    DROP TRIGGER IF EXISTS legacy_auto_wish_content_owner_immutable;
    CREATE TRIGGER legacy_auto_wish_content_owner_immutable BEFORE UPDATE OF user_id ON legacy_contents
      WHEN NEW.user_id<>OLD.user_id AND (EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wishes WHERE content_id=OLD.id)
        OR EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wish_retirements WHERE content_id=OLD.id))
      BEGIN SELECT RAISE(ABORT,'Automatic wish owner cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_auto_wish_retirement_validate_insert BEFORE INSERT ON legacy_beneficiary_auto_wish_retirements
      WHEN NOT EXISTS(SELECT 1 FROM legacy_contents WHERE id=NEW.content_id AND user_id=NEW.owner_user_id)
        OR NOT EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wishes a WHERE a.content_id=NEW.content_id
          AND a.owner_user_id=NEW.owner_user_id AND a.beneficiary_id=NEW.beneficiary_id)
      BEGIN SELECT RAISE(ABORT,'Automatic wish retirement ownership mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_auto_wish_retirement_identity_immutable BEFORE UPDATE ON legacy_beneficiary_auto_wish_retirements
      BEGIN SELECT RAISE(ABORT,'Retired automatic wish identity cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_auto_wish_retire_before_beneficiary_delete BEFORE DELETE ON beneficiaries
      BEGIN
        INSERT OR IGNORE INTO legacy_beneficiary_auto_wish_retirements(content_id,owner_user_id,beneficiary_id,retired_at)
          SELECT content_id,owner_user_id,beneficiary_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM legacy_beneficiary_auto_wishes WHERE beneficiary_id=OLD.id;
        UPDATE legacy_contents SET status='archived',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id IN (SELECT content_id FROM legacy_beneficiary_auto_wishes WHERE beneficiary_id=OLD.id);
      END;
    CREATE TRIGGER IF NOT EXISTS legacy_auto_wish_beneficiary_owner_immutable BEFORE UPDATE OF user_id ON beneficiaries
      WHEN NEW.user_id<>OLD.user_id AND EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wishes WHERE beneficiary_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'Automatic wish beneficiary owner cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_auto_wish_recipient_insert BEFORE INSERT ON legacy_content_beneficiaries
      WHEN EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wishes a
        WHERE a.content_id=NEW.content_id AND a.beneficiary_id<>NEW.beneficiary_id)
      BEGIN SELECT RAISE(ABORT,'Automatic wish recipient cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS legacy_auto_wish_recipient_update BEFORE UPDATE OF content_id,beneficiary_id ON legacy_content_beneficiaries
      WHEN EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wishes a
        WHERE a.content_id=OLD.content_id OR a.content_id=NEW.content_id)
        AND (NEW.content_id<>OLD.content_id OR NEW.beneficiary_id<>OLD.beneficiary_id)
      BEGIN SELECT RAISE(ABORT,'Automatic wish recipient cannot be changed'); END;
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
    INSERT OR IGNORE INTO legacy_schema_migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  })();
}
module.exports = { initLegacySchema };
