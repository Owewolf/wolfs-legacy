'use strict';

const legacy = require('./legacy-content');
const BENEFICIARY_WISH_CATEGORY = 'Beneficiary Instructions';

// The same owner-scoped assignment check is used for startup repair and new
// beneficiaries. Any existing content counts, including an archived wish, so
// an owner's edited content or deliberate archive is never replaced.
function assignedWish(db, userId, beneficiaryId) {
  return db.prepare(`SELECT c.id FROM legacy_contents c
    JOIN legacy_content_beneficiaries m ON m.content_id=c.id
    WHERE c.user_id=? AND m.beneficiary_id=? ORDER BY c.created_at,c.id LIMIT 1`)
    .get(userId, beneficiaryId);
}

function ensureBeneficiaryFinalWish(db, userId, beneficiaryId) {
  return db.transaction(() => {
    const beneficiary = db.prepare('SELECT id,name FROM beneficiaries WHERE id=? AND user_id=?')
      .get(beneficiaryId, userId);
    if (!beneficiary) throw Object.assign(new Error('Beneficiary not found'), { status: 404 });
    const existing = assignedWish(db, userId, beneficiary.id);
    if (existing) return { id: existing.id, created: false };
    const wish = legacy.save(db, userId, {
      // Keep the existing internal content type for schema compatibility. The
      // empty selection identifies an ordinary wish with no optional content.
      type: 'instruction', title: beneficiary.name.trim(), body_markdown: '',
      status: 'draft', release_policy: 'owner_only', beneficiary_ids: [beneficiary.id], review_enabled: false,
      metadata: {
        final_wishes: { content_type: '', category: BENEFICIARY_WISH_CATEGORY, details: '', contact_person: '', contact_phone: '', notes: '' },
        origin: { type: 'beneficiary', beneficiary_id: beneficiary.id }
      }
    });
    return { id: wish.id, created: true };
  }).immediate();
}

const blank = value => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

// Earlier automatically generated drafts used an instructional presentation
// and a prefixed title. Upgrade only those untouched content defaults. Review
// scheduling is disabled for these plain drafts while review history remains.
// An owner edit, attachment, link or release takes precedence over this repair.
function upgradePristineBeneficiaryFinalWishes(db, beneficiary) {
  const candidates = db.prepare(`SELECT c.* FROM legacy_contents c
    JOIN legacy_content_beneficiaries m ON m.content_id=c.id
    WHERE c.user_id=? AND m.beneficiary_id=? AND c.type='instruction'
      AND c.status='draft' AND c.release_policy='owner_only' AND c.revision=1
      AND c.final_wishes_entry_id IS NULL`)
    .all(beneficiary.user_id, beneficiary.id);
  for (const row of candidates) {
    const payload = legacy.payload(row), metadata = payload.metadata || {}, wishes = metadata.final_wishes || {};
    if (typeof wishes !== 'object' || Array.isArray(wishes) ||
        metadata.origin?.type !== 'beneficiary' || metadata.origin.beneficiary_id !== beneficiary.id ||
        payload.title !== `Final Wishes for ${beneficiary.name.trim()}` ||
        Object.prototype.hasOwnProperty.call(wishes, 'content_type') ||
        ![payload.body_markdown, payload.introduction, payload.description].every(blank) ||
        !['category', 'details', 'contact_person', 'contact_phone', 'notes', 'contact_recipients'].every(key => blank(wishes[key])) ||
        !['event_date', 'date_precision', 'relationship', 'place', 'recorded_at', 'category', 'priority',
          'related_legacy_content_id', 'people', 'tags', 'responsible_people', 'helpful_contacts', 'checklist']
          .every(key => blank(metadata[key]))) continue;
    if (['legacy_content_attachments', 'legacy_content_links', 'legacy_content_versions', 'legacy_content_acknowledgements']
      .some(table => db.prepare('SELECT 1 FROM ' + table + ' WHERE content_id=? LIMIT 1').get(row.id))) continue;
    if (db.prepare(`SELECT 1 FROM legacy_content_beneficiaries WHERE content_id=?
      AND (released_at IS NOT NULL OR revoked_at IS NOT NULL OR release_scope IS NOT NULL) LIMIT 1`).get(row.id)) continue;
    legacy.save(db, beneficiary.user_id, {
      title: beneficiary.name.trim(),
      metadata: { ...metadata, final_wishes: { ...wishes, content_type: '', category: BENEFICIARY_WISH_CATEGORY } },
      review_enabled: false, next_review_at: null
    }, row.id);
  }
}

// Accept an existing initialized connection so maintenance can use this without
// starting the application or its notification workers. The write lock is taken
// before selecting missing assignments; concurrent startups cannot create two
// drafts. One failed draft/event/audit rolls the entire backfill back.
function backfillBeneficiaryFinalWishes(db) {
  return db.transaction(() => {
    const beneficiaries = db.prepare('SELECT id,user_id,name FROM beneficiaries ORDER BY user_id,id').all();
    let created = 0;
    for (const beneficiary of beneficiaries) {
      if (ensureBeneficiaryFinalWish(db, beneficiary.user_id, beneficiary.id).created) created++;
      upgradePristineBeneficiaryFinalWishes(db, beneficiary);
    }
    return { created, total: beneficiaries.length };
  }).immediate();
}

module.exports = { ensureBeneficiaryFinalWish, backfillBeneficiaryFinalWishes };
