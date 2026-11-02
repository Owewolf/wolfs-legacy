const express = require('express');
const { getDb } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { validateInt, validationError } = require('../validate');
const { createNotificationService } = require('../notifications/service');
const { utc, deadlines } = require('../notifications/time');

const router = express.Router();
router.use(authenticateToken);

router.get('/status', (req, res) => {
  const db = getDb();
  const config = db.prepare('SELECT * FROM dead_switch_config WHERE user_id = ?').get(req.user.id);
  const user = db.prepare('SELECT last_check_in FROM users WHERE id = ?').get(req.user.id);
  if (!config) return res.status(404).json({ error: 'Config not found' });

  const times = deadlines(user.last_check_in, config.check_in_interval_days, config.grace_period_days);
  const next = utc(times.nextCheckinAt);
  const grace = utc(times.releaseAt);

  res.json({
    ...config,
    last_check_in: user.last_check_in,
    next_check_in: next.toISOString(),
    grace_deadline: grace.toISOString(),
    is_overdue: new Date() > next,
    is_past_grace: new Date() > grace
  });
});

router.put('/config', (req, res) => {
  const { check_in_interval_days, grace_period_days, is_active } = req.body;
  const interval = parseInt(check_in_interval_days) || 30;
  const grace = parseInt(grace_period_days) || 7;
  if (!validateInt(interval, 1, 365)) return validationError(res, 'Check-in interval must be 1-365 days');
  if (!validateInt(grace, 1, 90)) return validationError(res, 'Grace period must be 1-90 days');

  const db = getDb();
  createNotificationService({ db }).configureSwitch(req.user.id, { interval, grace, active: !!is_active });
  res.json({ success: true });
});

router.post('/checkin', (req, res) => {
  const db = getDb();
  res.json(createNotificationService({ db }).signedInCheckin(req.user.id));
});

module.exports = router;
