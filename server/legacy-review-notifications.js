'use strict';

const { createHash } = require('node:crypto');
const { utc } = require('./notifications/time');

function hasReviewSchema(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_contents'").get();
}

function reviewState(item) {
  return {
    contentId: item.id,
    nextReviewAt: item.next_review_at,
    snoozedUntil: item.review_snoozed_until || null,
    lastReviewedAt: item.last_reviewed_at || null
  };
}

// Scheduling is separate from the five check-in reminders. The durable outbox's
// unique key deduplicates concurrent workers and restarts for this review date.
function queueReviewReminders({ db, service, now = () => new Date() }) {
  if (!hasReviewSchema(db)) return 0;
  const at = utc(now()).toISOString();
  return db.transaction(() => {
    let queued = 0;
    const items = db.prepare(`SELECT id,user_id,next_review_at,review_snoozed_until,last_reviewed_at
      FROM legacy_contents WHERE review_enabled=1 AND status<>'archived'
      AND next_review_at IS NOT NULL AND next_review_at<=?
      AND (review_snoozed_until IS NULL OR review_snoozed_until<=?)`).all(at, at);
    for (const item of items) {
      const payload = reviewState(item);
      const key = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (service.queue('legacy_review_due', item.user_id, payload,
        { key: `legacy-review:${item.user_id}:${key}`, at })) queued++;
    }
    return queued;
  }).immediate();
}

function prepareReviewReminder(db, job, at = new Date()) {
  if (!hasReviewSchema(db)) return null;
  let payload;
  try { payload = JSON.parse(job.data_json); } catch { return null; }
  if (!payload || typeof payload.contentId !== 'string') return null;
  const item = db.prepare('SELECT * FROM legacy_contents WHERE id=? AND user_id=?')
    .get(payload.contentId, job.user_id);
  const timestamp = utc(at).toISOString();
  if (!item || !item.review_enabled || item.status === 'archived' || !item.next_review_at ||
      item.next_review_at > timestamp || (item.review_snoozed_until && item.review_snoozed_until > timestamp) ||
      JSON.stringify(reviewState(item)) !== JSON.stringify(payload)) return null;
  // No title, letter, checklist, recipient or attachment metadata enters email.
  return { nextReviewAt: item.next_review_at };
}

module.exports = { queueReviewReminders, prepareReviewReminder };
