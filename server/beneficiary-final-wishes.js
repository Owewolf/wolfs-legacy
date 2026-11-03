'use strict';

const legacy = require('./legacy-content');
const autoWish = require('./beneficiary-auto-wish');
const BENEFICIARY_WISH_CATEGORY = 'Beneficiary Instructions';

function historicalCandidates(db, beneficiary) {
  const candidates = [], reconciliation = [];
  const contents = db.prepare(`SELECT c.* FROM legacy_contents c
    WHERE c.user_id=? AND NOT EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wishes a WHERE a.content_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wish_retirements r WHERE r.content_id=c.id)
    ORDER BY c.created_at,c.id`).all(beneficiary.user_id);
  for (const row of contents) {
    const mappings = db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=?').all(row.id);
    const mappedHere = mappings.some(mapping => mapping.beneficiary_id === beneficiary.id);
    let metadata;
    try { metadata = legacy.payload(row).metadata || {}; }
    catch (error) {
      if (mappedHere) reconciliation.push({ content_id: row.id, reason: 'unreadable_historical_payload' });
      continue;
    }
    if (metadata.origin?.type !== 'beneficiary') continue;
    if (metadata.origin.beneficiary_id !== beneficiary.id) {
      if (mappedHere) reconciliation.push({ content_id: row.id, reason: 'origin_recipient_mismatch' });
      continue;
    }
    const wishes = metadata.final_wishes;
    if (mappings.length !== 1 || !mappedHere || !wishes || typeof wishes !== 'object' || Array.isArray(wishes) ||
        (wishes.contact_recipients !== undefined && (!Array.isArray(wishes.contact_recipients) || wishes.contact_recipients.length)) ||
        row.final_wishes_entry_id !== null) {
      reconciliation.push({ content_id: row.id, reason: 'ambiguous_historical_recipients' });
      continue;
    }
    candidates.push({ row, mapping: mappings[0] });
  }
  if (candidates.length > 1) {
    reconciliation.push(...candidates.map(({ row }) => ({ content_id: row.id, reason: 'duplicate_historical_automatic_wish' })));
  }
  return { candidates, reconciliation };
}

// Existing deletion suppressions are retained as documented administrative
// disablements. They never restore deleted payloads or create a replacement.
function ensureBeneficiaryFinalWish(db, userId, beneficiaryId) {
  return db.transaction(() => {
    const beneficiary = db.prepare('SELECT * FROM beneficiaries WHERE id=? AND user_id=?').get(beneficiaryId, userId);
    if (!beneficiary) throw Object.assign(new Error('Beneficiary not found'), { status: 404 });
    const existing = autoWish.forBeneficiary(db, beneficiary.id);
    if (existing) {
      if (existing.owner_user_id !== userId || !autoWish.validBinding(db, existing)) {
        throw Object.assign(new Error('Automatic wish ownership requires reconciliation'), { status: 409 });
      }
      return { id: existing.content_id, created: false };
    }
    if (db.prepare('SELECT 1 FROM legacy_beneficiary_wish_suppressions WHERE user_id=? AND beneficiary_id=?')
      .get(userId, beneficiary.id)) return { id: null, created: false, suppressed: true };

    const { candidates, reconciliation } = historicalCandidates(db, beneficiary);
    // Ambiguity never makes an edited historical record newly token-readable.
    // Preserve every old row and create a separate empty dedicated wish instead.
    const adopt = candidates.length === 1 && reconciliation.length === 0 ? candidates[0] : null;
    const wish = adopt ? { id: adopt.row.id } : legacy.save(db, userId, {
      type: 'instruction', title: beneficiary.name.trim(), body_markdown: '',
      status: 'draft', release_policy: 'owner_only', beneficiary_ids: [beneficiary.id], review_enabled: false,
      metadata: {
        final_wishes: { content_type: '', category: BENEFICIARY_WISH_CATEGORY, details: '', contact_person: '', contact_phone: '', notes: '' },
        origin: { type: 'beneficiary', beneficiary_id: beneficiary.id }
      }
    }, null, { allowAutomaticOrigin: true });
    const at = legacy.now();
    db.prepare(`INSERT INTO legacy_beneficiary_auto_wishes(beneficiary_id,content_id,owner_user_id,created_at)
      VALUES(?,?,?,?)`).run(beneficiary.id, wish.id, userId, at);
    const lastAccessDecision = db.prepare(`SELECT action,created_at FROM audit_log
      WHERE user_id=? AND target_type='beneficiary' AND target_id=? AND action IN ('revoke_access','grant_access')
      ORDER BY created_at DESC,id DESC LIMIT 1`).get(userId, beneficiary.id);
    const revokedAt = adopt?.mapping.revoked_at ||
      candidates.find(candidate => candidate.mapping.revoked_at)?.mapping.revoked_at ||
      (lastAccessDecision?.action === 'revoke_access' ? lastAccessDecision.created_at : null);
    if (revokedAt) {
      db.prepare(`UPDATE beneficiaries SET auto_wish_access_revoked_at=COALESCE(auto_wish_access_revoked_at,?)
        WHERE id=? AND user_id=?`).run(revokedAt, beneficiary.id, userId);
    }
    legacy.event(db, { userId, contentId: wish.id, beneficiaryId: beneficiary.id,
      type: adopt ? 'auto_wish_adopted' : 'auto_wish_linked', key: `auto-wish:${beneficiary.id}:${wish.id}`, at });
    if (reconciliation.length) {
      db.prepare(`INSERT INTO audit_log(user_id,action,target_type,target_id,detail,created_at)
        VALUES(?,?,?,?,?,?)`).run(userId, 'legacy_auto_wish_reconciliation', 'beneficiary', beneficiary.id,
        JSON.stringify({ replacement_content_id: wish.id, preserved: reconciliation }), at);
    }
    return { id: wish.id, created: !adopt, ...(adopt ? { adopted: true } : {}),
      ...(reconciliation.length ? { reconciliation } : {}) };
  }).immediate();
}

// The write lock is acquired before any missing-marker checks. Nested creation,
// identity, recipient and audit writes all roll back on any failure. This helper
// imports no application entry point and sends no notifications.
function backfillBeneficiaryFinalWishes(db) {
  return db.transaction(() => {
    const beneficiaries = db.prepare('SELECT id,user_id FROM beneficiaries ORDER BY user_id,id').all();
    const result = { created: 0, total: beneficiaries.length, adopted: 0, suppressed: 0, reconciliation: [] };
    for (const beneficiary of beneficiaries) {
      const wish = ensureBeneficiaryFinalWish(db, beneficiary.user_id, beneficiary.id);
      if (wish.created) result.created++;
      if (wish.adopted) result.adopted++;
      if (wish.suppressed) result.suppressed++;
      if (wish.reconciliation) result.reconciliation.push({ beneficiary_id: beneficiary.id, ...wish });
    }
    return result;
  }).immediate();
}

module.exports = { ensureBeneficiaryFinalWish, backfillBeneficiaryFinalWishes };
