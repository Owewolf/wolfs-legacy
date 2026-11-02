const jwt = require('jsonwebtoken');
const { getDb } = require('../db');

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    const dbGetter = typeof req.app?.locals?.getDb === 'function' ? req.app.locals.getDb : getDb;
    const db = dbGetter();
    const user = db.prepare('SELECT sms_2fa_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (user.sms_2fa_enabled && req.user.mfa !== 'sms_otp') {
      return res.status(403).json({ error: 'Second-factor verification required' });
    }
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticateToken };
