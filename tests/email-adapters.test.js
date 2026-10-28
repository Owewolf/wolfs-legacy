'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseReply, validateReplyMetadata } = require('../server/notifications/parser');
const { renderTemplate, localDate } = require('../server/notifications/templates');
const { createSmtpTransport, createImapReceiver, safeTransportError } = require('../server/notifications/transport');

const challenge = 'WL-7K9P-4Q2R-Z6TM';
const offline = 'RC-8FQ2-V9KB-7L5D';
const policy = { expectedFrom: 'owner@example.com', replyMailbox: 'reply@example.net', expectedMessageId: '<reminder@example.net>', trustedAuthservIds: ['mx.example.net'] };

function mime(body = `CONFIRM ${challenge} ${offline}`, extra = {}, encoding = '8bit') {
  const headers = {
    From: 'Vault Owner <owner@example.com>', To: 'reply@example.net',
    'Message-ID': '<reply@example.com>', 'In-Reply-To': '<reminder@example.net>',
    References: '<reminder@example.net>', Subject: "Re: Wolf's Legacy check-in",
    'Content-Type': 'text/plain; charset=utf-8', 'Content-Transfer-Encoding': encoding,
    ...extra,
  };
  return Buffer.from(Object.entries(headers).filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n' + body);
}

test('MIME reply accepts two factors with harmless case/whitespace and ignores quotes/signature', async () => {
  const parsed = await parseReply(mime(`  confirm  ${challenge.toLowerCase()}\t${offline.toLowerCase()} \n\n> CONFIRM BAD BAD\n-- \nCONFIRM not-a-code not-a-code`), policy);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.challenge, challenge);
  assert.equal(parsed.recoveryCode, offline);
  assert.equal(parsed.from, 'owner@example.com');
  assert.equal(parsed.authentication.status, 'unavailable');
  const encoded = Buffer.from(`CONFIRM ${challenge} ${offline}`).toString('base64');
  assert.equal((await parseReply(mime(encoded, {}, 'base64'), policy)).ok, true);
});

test('MIME parser rejects missing, ambiguous, quoted, automated and forwarded confirmations', async () => {
  const cases = [
    [mime('CONFIRM'), 'confirmation_format'],
    [mime(`CONFIRM ${challenge}`), 'confirmation_format'],
    [mime(`CONFIRM ${challenge} ${offline}\nCONFIRM ${challenge} RC-OTHER-CODE-1234`), 'confirmation_ambiguous'],
    [mime(`> CONFIRM ${challenge} ${offline}`), 'confirmation_missing'],
    [mime(`On Tuesday Someone wrote:\nCONFIRM ${challenge} ${offline}`), 'confirmation_missing'],
    [mime(undefined, { 'Auto-Submitted': 'auto-replied' }), 'automatic_message'],
    [mime(undefined, { Precedence: 'bulk' }), 'automatic_message'],
    [mime(undefined, { Subject: 'Fwd: reminder' }), 'forwarded_message'],
    [mime(undefined, { 'Resent-From': 'owner@example.com' }), 'forwarded_message'],
    [mime(`---------- Forwarded message ---------\nCONFIRM ${challenge} ${offline}`), 'forwarded_message'],
    [mime(undefined, { From: 'Display Owner <attacker@example.org>' }), 'origin_mismatch'],
    [mime(undefined, { From: 'owner@example.com, attacker@example.org' }), 'invalid_origin'],
    [mime(undefined, { 'Reply-To': 'attacker@example.org' }), 'invalid_origin'],
    [mime(undefined, { To: 'other@example.net' }), 'recipient_mismatch'],
    [mime(undefined, { 'In-Reply-To': '<other@example.net>' }), 'thread_mismatch'],
    [mime(undefined, { 'In-Reply-To': null }), 'invalid_thread'],
    [mime(undefined, { 'Message-ID': null }), 'invalid_message_id'],
    [mime(undefined, { 'Content-Type': 'text/html' }), 'plain_text_required'],
  ];
  for (const [source, reason] of cases) {
    const parsed = await parseReply(source, policy);
    assert.deepEqual(parsed, { ok: false, reason }, reason);
    assert.equal(JSON.stringify(parsed).includes(offline), false);
  }
});

test('bounded MIME processing never examines oversized raw input or confirmation attachments', async () => {
  assert.deepEqual(await parseReply(Buffer.alloc(65537), policy), { ok: false, reason: 'message_size' });
  const multipart = mime([
    '--parts', 'Content-Type: text/plain', '', 'No confirmation here.',
    '--parts', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="codes.txt"', '',
    `CONFIRM ${challenge} ${offline}`, '--parts--', '',
  ].join('\r\n'), { 'Content-Type': 'multipart/mixed; boundary=parts' });
  assert.equal((await parseReply(multipart, policy)).reason, 'confirmation_missing');
});

test('duplicate identity/thread headers, mismatched sender and signature-only codes fail closed', async () => {
  const duplicate = (name, value) => {
    const source = mime().toString();
    return source.replace('\r\n\r\n', `\r\n${name}: ${value}\r\n\r\n`);
  };
  const cases = [
    [duplicate('From', 'owner@example.com'), 'invalid_origin'],
    [duplicate('Message-ID', '<other@example.com>'), 'invalid_message_id'],
    [duplicate('In-Reply-To', '<other@example.net>'), 'invalid_thread'],
    [duplicate('References', '<other@example.net>'), 'invalid_thread'],
    [mime(undefined, { Sender: 'attacker@example.org' }), 'invalid_origin'],
    [mime(`Thank you.\n-- \nCONFIRM ${challenge} ${offline}`), 'confirmation_missing'],
    [mime(`Sent from my phone\nCONFIRM ${challenge} ${offline}`), 'confirmation_missing'],
    [mime(`On 28 October Owner wrote:\n> CONFIRM ${challenge} ${offline}`), 'confirmation_missing'],
  ];
  for (const [source, reason] of cases) assert.deepEqual(await parseReply(source, policy), { ok: false, reason });
});

test('trusted receiver authentication failure rejects; untrusted Authentication-Results never authenticates', async () => {
  assert.equal((await parseReply(mime(undefined, { 'Authentication-Results': 'mx.example.net; dmarc=fail header.from=example.com' }), policy)).reason, 'authentication_failed');
  const untrusted = await parseReply(mime(undefined, { 'Authentication-Results': 'attacker.invalid; dmarc=pass' }), policy);
  assert.equal(untrusted.ok, true);
  assert.equal(untrusted.authentication.status, 'unavailable');
  assert.deepEqual(validateReplyMetadata(untrusted, { expectedFrom: 'different@example.com' }), { ok: false, reason: 'origin_mismatch' });
  assert.deepEqual(validateReplyMetadata(untrusted, { expectedMessageId: '<unrelated@example.net>' }), { ok: false, reason: 'thread_mismatch' });
  const reviewed = await parseReply(mime(undefined, { 'Authentication-Results': 'mx.example.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com' }), policy);
  assert.equal(reviewed.authentication.status, 'reviewed');
  const conflicting = mime(undefined, { 'Authentication-Results': 'mx.example.net; dmarc=fail' }).toString()
    .replace('\r\n\r\n', '\r\nAuthentication-Results: attacker.invalid; dmarc=pass\r\n\r\n');
  assert.deepEqual(await parseReply(conflicting, policy), { ok: false, reason: 'authentication_failed' });
});

test('templates present South Africa deadlines, both factors and supersession without private payload leakage', () => {
  const rendered = renderTemplate('reminder', {
    releaseAt: '2026-11-01T22:30:00Z', challengeExpiresAt: '2026-10-28T22:30:00Z',
    daysRemaining: 5, reminderNumber: 1, challenge, offlineCode: offline,
    accessToken: 'private-access-token', accountBalance: 'private-balance', smtpPassword: 'private-password',
  });
  assert.match(rendered.text, /2 November 2026.*00:30/);
  assert.match(rendered.text, /24 hours/);
  assert.match(rendered.text, /newer reminder invalidates/);
  assert.match(rendered.text, /CONFIRM WL-7K9P-4Q2R-Z6TM <YOUR-NEXT-UNUSED-OFFLINE-CODE>/);
  assert.match(rendered.html, /&lt;YOUR-NEXT-UNUSED-OFFLINE-CODE&gt;/);
  assert.equal(/<img|https?:\/\//.test(rendered.html), false);
  for (const secret of [offline, 'private-access-token', 'private-balance', 'private-password']) assert.equal(JSON.stringify(rendered).includes(secret), false);
  assert.match(renderTemplate('reminder', { releaseAt: '2026-11-01T00:00:00Z', challengeExpiresAt: '2026-10-31T00:00:00Z', daysRemaining: 1, reminderNumber: 5, challenge }).subject, /1 day before/);
});

test('template interpolation escapes markup and strips control characters; all required variants render', () => {
  const common = { beneficiaryName: '<script>alert("x")</script>\nname', eventAt: '2026-10-28T12:00:00Z', accessGranted: false };
  const rendered = renderTemplate('access_revoked', common);
  assert.match(rendered.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; name/);
  assert.equal(rendered.html.includes('<script>'), false);
  const variants = {
    checkin_confirmed: { confirmedAt: common.eventAt, nextCheckinAt: common.eventAt, nextReleaseAt: common.eventAt },
    checkin_failed: {}, verify_address: { verificationCode: 'VERIFY-123456', expiresAt: common.eventAt },
    emergency_requested: { ...common, requestedAt: common.eventAt, eligibleAt: common.eventAt, waitingDays: 7 },
    deadswitch_released: { grantedAt: common.eventAt }, deadswitch_granted: { grantedAt: common.eventAt },
    emergency_denied: common, emergency_granted: common, access_granted: common,
    email_test: { timestamp: common.eventAt }, transport_health: { timestamp: common.eventAt, status: 'degraded' },
  };
  for (const [event, payload] of Object.entries(variants)) {
    const output = renderTemplate(event, payload);
    assert.ok(output.subject && output.text && output.html, event);
  }
  assert.equal(localDate('2026-10-28 12:00:00'), localDate(common.eventAt));
  assert.throws(() => renderTemplate('unknown', {}));
});

const env = {
  SMTP_HOST: 'smtp.example.net', SMTP_PORT: '587', SMTP_SECURE: 'false',
  SMTP_USERNAME: 'smtp-user', SMTP_PASSWORD: 'smtp-secret', SMTP_FROM: 'vault@example.net',
  CHECKIN_REPLY_MAILBOX: 'reply@example.net', CHECKIN_IMAP_HOST: 'imap.example.net',
  CHECKIN_IMAP_PORT: '993', CHECKIN_IMAP_USERNAME: 'imap-user', CHECKIN_IMAP_PASSWORD: 'imap-secret',
};

test('SMTP requires authenticated verified TLS and whitelists content and sender configuration', async () => {
  let options;
  let outgoing;
  const transport = createSmtpTransport(env, { createTransport(settings) {
    options = settings;
    return { async sendMail(mail) { outgoing = mail; return { accepted: [mail.to], rejected: [], messageId: mail.messageId }; }, async verify() { return true; } };
  } });
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.opportunisticTLS, false);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.logger, false);
  const mail = { to: 'owner@example.com', subject: 'Test', text: 'Safe', html: '<p>Safe</p>', messageId: '<test@example.net>', attachments: [{ path: '/etc/passwd' }], from: 'attacker@example.org' };
  const result = await transport.sendMail(mail);
  assert.equal(result.status, 'sent_to_server');
  assert.equal(result.acceptedCount, 1);
  assert.equal(outgoing.from.address, 'vault@example.net');
  assert.equal(outgoing.replyTo, 'reply@example.net');
  assert.equal(outgoing.attachments, undefined);
  assert.equal(outgoing.disableFileAccess, true);
  assert.equal(await transport.verify(), true);
  let implicit;
  createSmtpTransport({ ...env, SMTP_PORT: '465', SMTP_SECURE: 'true' }, { createTransport(settings) { implicit = settings; return {}; } });
  assert.equal(implicit.secure, true);
  assert.equal(implicit.tls.rejectUnauthorized, true);
  for (const invalid of [{ SMTP_PORT: '25' }, { SMTP_PORT: '465' }, { SMTP_PASSWORD: '' }, { SMTP_FROM: 'owner@example.com\r\nBcc: attacker@example.org' }]) {
    assert.throws(() => createSmtpTransport({ ...env, ...invalid }, { createTransport() { throw new Error('must never construct'); } }), { code: 'EMAIL_CONFIGURATION' });
  }
});

test('SMTP errors omit credentials, arbitrary provider strings and recipient metadata', async () => {
  const transport = createSmtpTransport(env, { createTransport() { return { async sendMail() {
    const failure = new Error('smtp-secret owner@example.com raw MIME body');
    failure.code = 'EAUTH'; failure.responseCode = 535;
    throw failure;
  } }; } });
  await assert.rejects(transport.sendMail({ to: 'owner@example.com', subject: 'x', text: 'x', html: 'x', messageId: '<test@example.net>' }), error => {
    assert.equal(error.code, 'SMTP_REJECTED');
    assert.equal(error.transient, false);
    assert.equal(error.responseCode, 535);
    assert.equal(/smtp-secret|owner@example.com|raw MIME/.test(String(error.stack) + JSON.stringify(error)), false);
    return true;
  });
});

test('SMTP preserves only sanitized ambiguity at the provider acceptance boundary', () => {
  assert.equal(safeTransportError({ code: 'ECONNRESET', command: 'DATA' }, 'SMTP').ambiguous, true);
  assert.equal(safeTransportError({ code: 'ETIMEDOUT' }, 'SMTP').ambiguous, true);
  assert.equal(safeTransportError({ code: 'ESOCKET' }, 'SMTP').ambiguous, true);
  assert.equal(safeTransportError({ code: 'ETIMEDOUT', command: 'CONN' }, 'SMTP').ambiguous, false);
  assert.equal(safeTransportError({ code: 'ECONNRESET', command: 'RCPT TO' }, 'SMTP').ambiguous, false);
  assert.equal(safeTransportError({ responseCode: 451, command: 'DATA' }, 'SMTP').ambiguous, false);
  assert.equal(safeTransportError({ responseCode: 550, command: 'DATA' }, 'SMTP').ambiguous, false);
  assert.equal(safeTransportError({ code: 'EAUTH' }, 'SMTP').ambiguous, false);
  assert.equal('command' in safeTransportError({ code: 'ECONNRESET', command: 'DATA private-content' }, 'SMTP'), false);
});

function fakeMailbox({ validity = '11', messages, fail = false }) {
  const state = { clientOptions: null, readOnly: null, sourceRequests: [], sourceBytes: 0, logouts: 0 };
  state.createClient = options => {
    state.clientOptions = options;
    const client = new EventEmitter();
    Object.assign(client, {
      mailbox: { uidValidity: BigInt(validity), uidNext: Math.max(0, ...Object.keys(messages).map(Number)) + 1 },
      async connect() { if (fail) throw new Error('imap-secret raw provider failure'); },
      async getMailboxLock(path, settings) { state.readOnly = settings.readOnly; return { release() {} }; },
      async search(query, options) {
        assert.equal(options.uid, true);
        const [start, end] = query.uid.split(':').map(Number);
        return Object.keys(messages).map(Number).filter(uid => uid >= start && uid <= end);
      },
      async fetchOne(uid, query, options) {
        assert.equal(options.uid, true);
        const source = messages[uid];
        if (query.source) {
          state.sourceRequests.push(uid);
          state.sourceBytes += query.source.maxLength;
          return { uid, source: source.subarray(0, query.source.maxLength) };
        }
        return { uid, size: source.length };
      },
      async logout() { state.logouts++; }, close() {},
    });
    return client;
  };
  return state;
}

test('read-only IMAP advances durable cursor after processing, skips seen UIDs and bounds MIME retrieval', async () => {
  const mailbox = fakeMailbox({ messages: { 1: mime(), 2: Buffer.alloc(65537), 3: mime('invalid') } });
  const checkpoints = new Map();
  const seen = new Set();
  const outcomes = [];
  const callbacks = {
    getCheckpoint: key => checkpoints.get(JSON.stringify(key)),
    saveCheckpoint: ({ lastUid, ...key }) => checkpoints.set(JSON.stringify(key), lastUid),
    hasProcessed: identity => seen.has(identity),
    processMessage: message => { outcomes.push(message); seen.add(message.identity); },
  };
  const receiver = createImapReceiver(env, { createClient: mailbox.createClient });
  assert.deepEqual(await receiver.poll(callbacks), { processed: 3 });
  assert.deepEqual(await receiver.poll(callbacks), { processed: 0 });
  assert.equal(mailbox.readOnly, true);
  assert.equal(mailbox.clientOptions.secure, true);
  assert.equal(mailbox.clientOptions.tls.rejectUnauthorized, true);
  assert.equal(mailbox.clientOptions.logger, false);
  assert.deepEqual(mailbox.sourceRequests, [1, 3]);
  assert.equal(outcomes[1].rejectionReason, 'message_size');
  assert.equal(outcomes[1].source, undefined);
  assert.equal(outcomes[0].identity.length, 64);
  assert.equal(checkpoints.values().next().value, 3);
  const resetMailbox = fakeMailbox({ validity: '12', messages: { 1: mime() } });
  await createImapReceiver(env, { createClient: resetMailbox.createClient }).poll(callbacks);
  assert.notEqual(outcomes[0].identity, outcomes[3].identity, 'UID validity scopes identity and cursor');
});

test('IMAP restart retries the same message when processing persistence fails', async () => {
  const mailbox = fakeMailbox({ messages: { 1: mime() } });
  let checkpoint = 0;
  let shouldFail = true;
  const identities = [];
  const callbacks = {
    getCheckpoint: () => checkpoint,
    saveCheckpoint: ({ lastUid }) => { checkpoint = lastUid; },
    processMessage: message => { identities.push(message.identity); if (shouldFail) throw new Error('database failure with private content'); },
  };
  const receiver = createImapReceiver(env, { createClient: mailbox.createClient });
  await assert.rejects(receiver.poll(callbacks), { code: 'IMAP_UNAVAILABLE' });
  assert.equal(checkpoint, 0);
  shouldFail = false;
  assert.equal((await receiver.poll(callbacks)).processed, 1);
  assert.equal(checkpoint, 1);
  assert.equal(identities[0], identities[1]);
  const outage = fakeMailbox({ messages: {}, fail: true });
  await assert.rejects(createImapReceiver(env, { createClient: outage.createClient }).poll(callbacks), error => {
    assert.equal(error.code, 'IMAP_UNAVAILABLE');
    assert.equal(/imap-secret|raw provider/.test(String(error.stack)), false);
    return true;
  });
});
