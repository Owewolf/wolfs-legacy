'use strict';

const crypto = require('node:crypto');
const { normalizeAddress, MAX_MESSAGE_BYTES } = require('./parser');

function configurationError() {
  const error = new Error('Invalid email transport configuration');
  error.code = 'EMAIL_CONFIGURATION';
  error.transient = false;
  return error;
}

function safeTransportError(error, protocol) {
  const responseCode = Number(error && error.responseCode);
  const permanent = error && error.code === 'EAUTH' || responseCode >= 500 && responseCode < 600;
  const safe = new Error(`${protocol} operation failed`);
  safe.code = permanent ? `${protocol}_REJECTED` : `${protocol}_UNAVAILABLE`;
  safe.transient = !permanent;
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599) safe.responseCode = responseCode;
  if (protocol === 'SMTP') {
    const definiteRejection = responseCode >= 400 && responseCode <= 599;
    const beforeSubmission = /^(?:CONN|EHLO|HELO|AUTH(?:\s|$)|STARTTLS|MAIL FROM|RCPT TO)/i.test(String(error && error.command || '')) ||
      /^(?:EAUTH|EDNS|ECONNECTION|EENVELOPE|EMESSAGE)$/.test(String(error && error.code || ''));
    // A dropped DATA reply may mean the SMTP server already accepted the mail.
    // The worker must quarantine this boundary rather than automatically resend.
    safe.ambiguous = !definiteRejection && !beforeSubmission;
  }
  // Never retain cause, response, command, stack from provider, envelope or body.
  return safe;
}

function host(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(value)) throw configurationError();
  return value;
}

function credential(value) {
  if (typeof value !== 'string' || !value || /[\r\n\u0000]/.test(value)) throw configurationError();
  return value;
}

function header(value, max = 998) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw configurationError();
  return value;
}

function createSmtpTransport(env = process.env, dependencies = {}) {
  const port = Number(env.SMTP_PORT || 587);
  const secure = env.SMTP_SECURE === undefined || env.SMTP_SECURE === '' ? port === 465 : String(env.SMTP_SECURE) === 'true';
  if (!['true', 'false', '', undefined].includes(env.SMTP_SECURE) ||
    !((port === 465 && secure) || (port === 587 && !secure))) throw configurationError();
  const smtpHost = host(env.SMTP_HOST);
  const from = normalizeAddress(env.SMTP_FROM);
  const replyTo = normalizeAddress(env.CHECKIN_REPLY_MAILBOX);
  if (!from || !replyTo) throw configurationError();
  const createTransport = dependencies.createTransport || require('nodemailer').createTransport;
  const client = createTransport({
    host: smtpHost, port, secure, requireTLS: !secure, ignoreTLS: false, opportunisticTLS: false,
    auth: { user: credential(env.SMTP_USERNAME), pass: credential(env.SMTP_PASSWORD) },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: smtpHost },
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000, dnsTimeout: 10000,
    logger: false, debug: false, transactionLog: false,
    disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
  });
  return {
    async sendMail(message) {
      const to = normalizeAddress(message && message.to);
      if (!to || typeof message.text !== 'string' || typeof message.html !== 'string') throw configurationError();
      const outgoing = {
        from: { name: "Wolf's Vault", address: from }, replyTo, to,
        subject: header(message.subject, 240), messageId: header(message.messageId, 500),
        text: message.text, html: message.html,
        priority: message.priority === 'high' ? 'high' : 'normal',
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        disableFileAccess: true, disableUrlAccess: true,
      };
      try {
        const result = await client.sendMail(outgoing);
        const acceptedCount = Array.isArray(result.accepted) ? result.accepted.length : 0;
        const rejectedCount = Array.isArray(result.rejected) ? result.rejected.length : 0;
        if (!acceptedCount || rejectedCount) throw { responseCode: 550 };
        return { messageId: outgoing.messageId, acceptedCount, rejectedCount, status: 'sent_to_server' };
      } catch (error) { throw safeTransportError(error, 'SMTP'); }
    },
    async verify() {
      try { await client.verify(); return true; }
      catch (error) { throw safeTransportError(error, 'SMTP'); }
    },
    close() { if (typeof client.close === 'function') client.close(); },
  };
}

function createImapReceiver(env = process.env, dependencies = {}) {
  const imapHost = host(env.CHECKIN_IMAP_HOST);
  const port = Number(env.CHECKIN_IMAP_PORT || 993);
  if (port !== 993) throw configurationError();
  const username = credential(env.CHECKIN_IMAP_USERNAME);
  const password = credential(env.CHECKIN_IMAP_PASSWORD);
  const mailbox = env.CHECKIN_IMAP_MAILBOX || 'INBOX';
  if (typeof mailbox !== 'string' || mailbox.length > 200 || /[\x00-\x1f\x7f]/.test(mailbox)) throw configurationError();
  const maxBytes = Math.min(Number(dependencies.maxBytes || env.EMAIL_MAX_MESSAGE_BYTES) || MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES);
  const maxMessages = Math.min(Number(env.EMAIL_MAX_MESSAGES_PER_POLL) || 50, 100);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(maxMessages) || maxMessages < 1) throw configurationError();
  const account = crypto.createHash('sha256').update(JSON.stringify([imapHost, port, username])).digest('hex');
  const createClient = dependencies.createClient || (options => new (require('imapflow').ImapFlow)(options));
  let polling = false;
  return {
    async poll(callbacks) {
      if (polling) return { skipped: true, processed: 0 };
      for (const name of ['getCheckpoint', 'saveCheckpoint', 'processMessage']) {
        if (!callbacks || typeof callbacks[name] !== 'function') throw configurationError();
      }
      polling = true;
      let client;
      let lock;
      let processed = 0;
      try {
        client = createClient({
          host: imapHost, port, secure: true, auth: { user: username, pass: password },
          tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: imapHost },
          logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true,
          connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000,
          disableCompression: true, maxLineLength: maxBytes + 16384,
          maxLiteralSize: maxBytes + 1, maxResponseSize: maxBytes + 32768,
        });
        // EventEmitter 'error' must always be handled, with no raw error logging.
        if (typeof client.on === 'function') client.on('error', () => {});
        await client.connect();
        lock = await client.getMailboxLock(mailbox, { readOnly: true });
        const uidValidity = String(client.mailbox.uidValidity);
        const lastExistingUid = Number(client.mailbox.uidNext) - 1;
        if (!/^\d+$/.test(uidValidity) || !Number.isSafeInteger(lastExistingUid) || lastExistingUid < 0) throw configurationError();
        const key = { account, mailbox, uidValidity };
        const checkpoint = await callbacks.getCheckpoint(key);
        let cursor = checkpoint == null ? 0 : Number(checkpoint);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw configurationError();
        // Numeric UID windows bound search results and skip expunged gaps. Never
        // use \Seen or sequence numbers as durable processed-message state.
        for (let window = 0; cursor < lastExistingUid && processed < maxMessages && window < 10; window++) {
          const end = Math.min(cursor + 1000, lastExistingUid);
          const found = await client.search({ uid: `${cursor + 1}:${end}` }, { uid: true });
          const uids = [...new Set(found || [])].map(Number).filter(uid => Number.isSafeInteger(uid) && uid > cursor && uid <= end).sort((a, b) => a - b);
          for (const uid of uids) {
            if (processed >= maxMessages) break;
            const identity = crypto.createHash('sha256').update(JSON.stringify([account, mailbox, uidValidity, uid])).digest('hex');
            if (!callbacks.hasProcessed || !await callbacks.hasProcessed(identity)) {
              const metadata = await client.fetchOne(uid, { uid: true, size: true }, { uid: true });
              if (metadata) {
                let source;
                let rejectionReason;
                if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > maxBytes) rejectionReason = 'message_size';
                else {
                  const message = await client.fetchOne(uid, { uid: true, source: { start: 0, maxLength: maxBytes + 1 } }, { uid: true });
                  if (message) source = message.source;
                  if (!Buffer.isBuffer(source) || source.length > maxBytes || source.length !== metadata.size) rejectionReason = 'message_size';
                }
                // The processor persists the inbound outcome and all accepted
                // state changes atomically before resolving. Failed persistence
                // throws, so the cursor is not advanced and the same UID retries.
                await callbacks.processMessage({ identity, ...key, uid, size: metadata.size,
                  ...(rejectionReason ? { rejectionReason } : { source }) });
                processed++;
              }
            }
            cursor = uid;
            await callbacks.saveCheckpoint({ ...key, lastUid: cursor });
          }
          if (processed >= maxMessages) break;
          cursor = end;
          await callbacks.saveCheckpoint({ ...key, lastUid: cursor });
        }
        return { processed };
      } catch (error) {
        if (error && error.code === 'EMAIL_CONFIGURATION') throw error;
        throw safeTransportError(error, 'IMAP');
      } finally {
        try { if (lock) lock.release(); } catch (_) {}
        try { if (client) await client.logout(); } catch (_) { try { client.close(); } catch (_) {} }
        polling = false;
      }
    },
  };
}

module.exports = { createSmtpTransport, createImapReceiver, safeTransportError };
