'use strict';

// The relational marker is the authority for automatic ownership. JSON origin
// metadata is only a historical migration hint and never grants access.
function forContent(db, contentId) {
  const active = db.prepare(`SELECT a.*,b.name AS beneficiary_name,b.auto_wish_access_revoked_at
    FROM legacy_beneficiary_auto_wishes a LEFT JOIN beneficiaries b ON b.id=a.beneficiary_id
    WHERE a.content_id=?`).get(contentId);
  if (active) return active;
  return db.prepare(`SELECT r.*,r.retired_at AS created_at,'Deleted beneficiary' AS beneficiary_name,
      r.retired_at AS auto_wish_access_revoked_at
    FROM legacy_beneficiary_auto_wish_retirements r WHERE r.content_id=?`).get(contentId);
}

function forBeneficiary(db, beneficiaryId) {
  return db.prepare(`SELECT a.*,b.name AS beneficiary_name,b.auto_wish_access_revoked_at
    FROM legacy_beneficiary_auto_wishes a LEFT JOIN beneficiaries b ON b.id=a.beneficiary_id
    WHERE a.beneficiary_id=?`).get(beneficiaryId);
}

function validBinding(db, marker) {
  if (!marker || marker.retired_at) return false;
  return !!db.prepare(`SELECT 1 FROM legacy_beneficiary_auto_wishes a
    JOIN beneficiaries b ON b.id=a.beneficiary_id AND b.user_id=a.owner_user_id
    JOIN legacy_contents c ON c.id=a.content_id AND c.user_id=a.owner_user_id
    WHERE a.beneficiary_id=? AND a.content_id=? AND a.owner_user_id=?
      AND NOT EXISTS(SELECT 1 FROM legacy_beneficiary_auto_wish_retirements r WHERE r.content_id=a.content_id)
      AND (SELECT COUNT(*) FROM legacy_content_beneficiaries m WHERE m.content_id=a.content_id)=1
      AND EXISTS(SELECT 1 FROM legacy_content_beneficiaries m
        WHERE m.content_id=a.content_id AND m.beneficiary_id=a.beneficiary_id)`)
    .get(marker.beneficiary_id, marker.content_id, marker.owner_user_id);
}

function publicIdentity(marker) {
  return marker ? { beneficiary_id: marker.beneficiary_id, beneficiary_name: marker.beneficiary_name } : null;
}

module.exports = { forContent, forBeneficiary, validBinding, publicIdentity };
