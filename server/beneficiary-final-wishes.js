'use strict';

const legacy = require('./legacy-content');

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
      type: 'instruction', title: `Final Wishes for ${beneficiary.name.trim()}`, body_markdown: '',
      status: 'draft', release_policy: 'owner_only', beneficiary_ids: [beneficiary.id],
      metadata: {
        final_wishes: { category: '', details: '', contact_person: '', contact_phone: '', notes: '' },
        origin: { type: 'beneficiary', beneficiary_id: beneficiary.id }
      }
    });
    return { id: wish.id, created: true };
  }).immediate();
}

// Accept an existing initialized connection so maintenance can use this without
// starting the application or its notification workers. The write lock is taken
// before selecting missing assignments; concurrent startups cannot create two
// drafts. One failed draft/event/audit rolls the entire backfill back.
function backfillBeneficiaryFinalWishes(db) {
  return db.transaction(() => {
    const beneficiaries = db.prepare('SELECT id,user_id FROM beneficiaries ORDER BY user_id,id').all();
    let created = 0;
    for (const beneficiary of beneficiaries) {
      if (ensureBeneficiaryFinalWish(db, beneficiary.user_id, beneficiary.id).created) created++;
    }
    return { created, total: beneficiaries.length };
  }).immediate();
}

module.exports = { ensureBeneficiaryFinalWish, backfillBeneficiaryFinalWishes };
