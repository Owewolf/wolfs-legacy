'use strict';

const { simpleParser } = require('mailparser');
const { compile } = require('html-to-text');

const MAX_MESSAGE_BYTES = 65536;
const MAX_BODY_BYTES = 16384;
const ADDRESS = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/i;
const MESSAGE_ID = /^<[^<>\s\x00-\x1f\x7f]{1,240}@[^<>\s\x00-\x1f\x7f]{1,240}>$/;
const BUTTON_REPLY_SUBJECT = "Wolf's Vault check-in confirmation";
// Already-sent reminders remain usable until their bound challenge expires.
// Keep this an exact allowlist: prefixed/forwarded subjects gain no exception.
function isButtonReplySubject(subject) {
  return subject === BUTTON_REPLY_SUBJECT || subject === "Wolf's Legacy check-in confirmation";
}
const HTML_LIMIT_MARKER = 'UNSUPPORTED_HTML_REPLY_LIMIT';
const HTML_BLOCKS = new Set(['address', 'article', 'aside', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
const HTML_IGNORED = new Set(['head', 'title', 'script', 'style', 'template', 'noscript', 'img', 'svg', 'math', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'form', 'input', 'button', 'select', 'textarea']);
// This converter only reads the bounded MIME body. It neither loads resources
// nor follows links. Quote/signature boundaries stop command extraction just
// as the corresponding plain-text boundaries do.
const htmlReplyText = compile({
  wordwrap: false, preserveNewlines: true,
  baseElements: { selectors: [], returnDomByDefault: true },
  limits: { maxInputLength: MAX_BODY_BYTES, maxDepth: 32, maxChildNodes: 1024, ellipsis: `\n${HTML_LIMIT_MARKER}\n` },
  selectors: [...new Set(['*', ...HTML_BLOCKS, ...HTML_IGNORED, 'a', 'blockquote', 'br', 'hr', 'wbr'])]
    .map(selector => ({ selector, format: 'replyElement' })),
  formatters: {
    replyElement(element, walk, builder) {
      const tag = element.name.toLowerCase();
      const attrs = element.attribs || {};
      const markers = `${attrs.id || ''} ${attrs.class || ''}`.toLowerCase().split(/\s+/);
      if (tag === 'blockquote' || markers.some(marker => /^(?:gmail_quote|gmail_signature|yahoo_quoted|moz-cite-prefix|moz-signature|applemailsignature|appleoriginalcontents|divrplyfwdmsg|signature)$/.test(marker))) {
        builder.openBlock({ leadingLineBreaks: 1 });
        builder.addInline('--');
        builder.closeBlock({ trailingLineBreaks: 1 });
        return;
      }
      if (HTML_IGNORED.has(tag) || Object.hasOwn(attrs, 'hidden') || attrs['aria-hidden'] === 'true' ||
          /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attrs.style || '')) return;
      if (tag === 'br' || tag === 'hr') { builder.addLineBreak(); return; }
      const block = HTML_BLOCKS.has(tag);
      if (block) builder.openBlock({ leadingLineBreaks: 1 });
      walk(element.children, builder);
      if (block) builder.closeBlock({ trailingLineBreaks: 1 });
    },
  },
});

function normalizeAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !ADDRESS.test(value)) return null;
  return value.toLowerCase();
}

function addresses(value) {
  if (!value || !Array.isArray(value.value)) return [];
  // Address groups/display names are not originating addresses.
  return value.value.map(item => normalizeAddress(item.address)).filter(Boolean);
}

function rejected(reason) { return { ok: false, reason }; }

function headerStrings(mail, key) {
  return mail.headerLines.filter(header => header.key === key)
    .map(header => header.line.slice(header.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim());
}

function extractHeaderIds(mail, key) {
  const fields = headerStrings(mail, key);
  if (!fields.length) return [];
  if (fields.length !== 1 || !fields[0]) return null;
  const ids = fields[0].match(/<[^<>\s]+>/g) || [];
  if (!ids.length || ids.some(id => !MESSAGE_ID.test(id)) || fields[0].replace(/<[^<>\s]+>/g, '').trim()) return null;
  return ids;
}

function authenticationResults(mail, trustedAuthservIds = []) {
  const configured = Array.isArray(trustedAuthservIds) ? trustedAuthservIds : String(trustedAuthservIds).split(',');
  const trusted = new Set(configured.map(id => String(id).trim().toLowerCase()).filter(Boolean));
  let reviewed = false;
  let failed = false;
  // Trust only receiver-owned Authentication-Results. The provider must strip
  // incoming fields claiming its own authserv-id (RFC 8601 section 5).
  for (const line of headerStrings(mail, 'authentication-results')) {
    const id = line.split(';', 1)[0].trim().replace(/\s+\d+$/, '').toLowerCase();
    if (!trusted.has(id)) continue;
    reviewed = true;
    const results = [...line.matchAll(/(?:^|;)\s*(dmarc|dkim|spf)\s*=\s*([a-z]+)/gi)];
    // SPF may fail for legitimate forwarding, but forwarded check-ins are
    // intentionally unsupported. Failure/temporary errors never authenticate.
    if (results.some(([, , result]) => /^(?:fail|softfail|temperror|permerror)$/i.test(result))) failed = true;
  }
  return { status: failed ? 'failed' : reviewed ? 'reviewed' : 'unavailable' };
}

function validateReplyMetadata(reply, policy = {}) {
  if (!reply || !reply.ok) return rejected('invalid_reply');
  if (policy.expectedFrom && normalizeAddress(policy.expectedFrom) !== reply.from) return rejected('origin_mismatch');
  if (policy.replyMailbox && !reply.to.includes(normalizeAddress(policy.replyMailbox))) return rejected('recipient_mismatch');
  const buttonReply = policy.allowButtonReply === true && isButtonReplySubject(reply.subject) &&
    reply.inReplyTo === null && reply.references.length === 0;
  if (!reply.inReplyTo && !buttonReply) return rejected('thread_mismatch');
  if (policy.expectedMessageId) {
    if (!MESSAGE_ID.test(policy.expectedMessageId)) return rejected('thread_mismatch');
    // A mailto button creates a new message. The service must bind its opaque
    // challenge to the verified sender before applying this exception.
    if (buttonReply) {
      if (!policy.expectedFrom || !policy.replyMailbox) return rejected('thread_mismatch');
    } else {
      if (reply.inReplyTo !== policy.expectedMessageId) return rejected('thread_mismatch');
      if (reply.references.length && !reply.references.includes(policy.expectedMessageId)) return rejected('thread_mismatch');
    }
  }
  return { ok: true };
}

async function parseReply(raw, policy = {}) {
  const maxBytes = Math.min(Number(policy.maxBytes) || MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES);
  if (!(Buffer.isBuffer(raw) || typeof raw === 'string')) return rejected('malformed_message');
  const source = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (!source.length || source.length > maxBytes) return rejected('message_size');
  let mail;
  try {
    mail = await simpleParser(source, {
      skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true,
      skipTextLinks: true, maxHtmlLengthToParse: MAX_BODY_BYTES,
    });
  } catch (_) { return rejected('malformed_message'); }
  const from = addresses(mail.from);
  const to = [...addresses(mail.to), ...addresses(mail.cc)];
  if (headerStrings(mail, 'from').length !== 1 || from.length !== 1 || mail.from.value.length !== 1) return rejected('invalid_origin');
  const sender = addresses(mail.headers.get('sender'));
  if (sender.length && (sender.length !== 1 || sender[0] !== from[0])) return rejected('invalid_origin');
  if (mail.replyTo && (addresses(mail.replyTo).length !== 1 || addresses(mail.replyTo)[0] !== from[0])) return rejected('invalid_origin');
  if (!to.length || to.length > 10) return rejected('invalid_recipient');
  const autoSubmitted = headerStrings(mail, 'auto-submitted');
  if (autoSubmitted.some(value => value.toLowerCase() !== 'no') ||
    ['x-autoreply', 'x-autorespond', 'list-id'].some(key => mail.headers.has(key)) ||
    headerStrings(mail, 'precedence').some(value => /\b(?:bulk|junk|list|auto_reply)\b/i.test(value))) return rejected('automatic_message');
  if (mail.headerLines.some(({ key }) => /^(?:resent-|x-forwarded-|x-ms-exchange-inbox-rules-loop)/.test(key)) ||
    /(?:^|\s)(?:fw|fwd)\s*:/i.test(mail.subject || '')) return rejected('forwarded_message');
  if (mail.attachments.some(attachment => /^message\//i.test(attachment.contentType))) return rejected('forwarded_message');
  if (headerStrings(mail, 'message-id').length !== 1 || !MESSAGE_ID.test(mail.messageId || '')) return rejected('invalid_message_id');
  if (headerStrings(mail, 'subject').length !== 1) return rejected('invalid_subject');
  const parentIds = extractHeaderIds(mail, 'in-reply-to');
  const references = extractHeaderIds(mail, 'references');
  if (!parentIds || !references || parentIds.length > 1 || (!parentIds.length && references.length)) return rejected('invalid_thread');
  if (!parentIds.length && !(policy.allowButtonReply === true && isButtonReplySubject(mail.subject))) return rejected('invalid_thread');
  const authentication = authenticationResults(mail, policy.trustedAuthservIds);
  if (authentication.status === 'failed') return rejected('authentication_failed');
  let body = mail.text;
  if (typeof body !== 'string' || !body.trim()) {
    if (typeof mail.html !== 'string' || !mail.html.trim() || Buffer.byteLength(mail.html, 'utf8') > MAX_BODY_BYTES) return rejected('unsupported_mime');
    try { body = htmlReplyText(mail.html); } catch (_) { return rejected('unsupported_mime'); }
    if (body.includes(HTML_LIMIT_MARKER)) return rejected('unsupported_mime');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return rejected('body_size');

  const lines = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:-{2,}\s*(?:original|forwarded) message\s*-*|begin forwarded message:)/i.test(line)) return rejected('forwarded_message');
    if (/^\s*(?:On .{1,300}wrote:|Le .{1,300}écrit\s*:|Am .{1,300}schrieb.{0,100}:)/i.test(line)) break;
    if (/^--\s*$/.test(line) || /^\s*Sent from my\b/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(?:From|De|Von):\s*.+/i.test(line)) break;
    if (/^\s*CONFIRM\b/i.test(line)) lines.push(line.trim().replace(/[ \t\u00a0]+/g, ' ').toUpperCase());
  }
  if (!lines.length) return rejected('confirmation_missing');
  if (lines.length !== 1) return rejected('confirmation_ambiguous');
  const match = /^CONFIRM (WL-[A-Z0-9-]{8,96})$/.exec(lines[0]);
  if (!match || /--/.test(match[1])) return rejected('confirmation_format');
  const reply = {
    ok: true, challenge: match[1], from: from[0], to,
    messageId: mail.messageId, inReplyTo: parentIds[0] || null, references, subject: mail.subject, authentication,
  };
  const metadata = validateReplyMetadata(reply, policy);
  return metadata.ok ? reply : metadata;
}

module.exports = { parseReply, validateReplyMetadata, normalizeAddress, MAX_MESSAGE_BYTES, BUTTON_REPLY_SUBJECT };
