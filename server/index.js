require('dotenv').config({ debug: false });
const { ensureSecrets } = require('./config');
ensureSecrets();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { getDb } = require('./db');
const log = require('./logger');

const app = express();
const PORT = process.env.PORT || 4444;

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      frameSrc: ["'self'", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      scriptSrcAttr: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(log.requestLogger);

// Rate limiting
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api/beneficiaries/emergency-access', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
app.use('/api/beneficiaries/access', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/health', (req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// Audit log endpoint (owner only)
const { authenticateToken } = require('./middleware/auth');
app.get('/api/audit', authenticateToken, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const { total } = db.prepare('SELECT COUNT(*) as total FROM audit_log WHERE user_id = ? OR user_id IS NULL').get(req.user.id);
  const logs = db.prepare(
    'SELECT * FROM audit_log WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(req.user.id, limit, offset);
  res.json({ logs, total, page, pages: Math.ceil(total / limit) });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/vault', require('./routes/vault'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/final-wishes', require('./routes/legacy').ownerRouter);
app.use('/api/beneficiary-access', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }), require('./routes/legacy').beneficiaryRouter);
app.use('/api/beneficiaries', require('./routes/beneficiaries'));
app.use('/api/deadswitch', require('./routes/deadswitch'));
app.use('/api/homebank', require('./routes/homebank'));
app.use('/api/notifications', require('./routes/notifications'));

// Dead man's switch background check — runs every hour
function checkDeadSwitches() {
  try {
    const db = getDb();
    require('./notifications/service').createNotificationService({ db }).releaseDue();
  } catch (err) {
    log.error('Dead switch check error', { error: err.message });
  }
}

setInterval(checkDeadSwitches, 60 * 60 * 1000);

// Unknown API requests must never fall through to the browser application.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.get('{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const startupDb = getDb();
const beneficiaryWishes = require('./beneficiary-final-wishes').backfillBeneficiaryFinalWishes(startupDb);
if (beneficiaryWishes.created) log.info('Created missing private beneficiary wishes', { count: beneficiaryWishes.created });
app.listen(PORT, process.env.LISTEN_HOST || '0.0.0.0', () => {
  log.info("Wolf's Vault started", { port: PORT });
  checkDeadSwitches();
  require('./homebank-service').startWatcher();
  const mailWorker = require('./notifications/worker').createNotificationWorker({ db: getDb() });
  mailWorker.start();
  process.once('SIGTERM', () => { mailWorker.stop(); process.exit(0); });
});
