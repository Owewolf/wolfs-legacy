'use strict';

const TIMEZONE = 'Africa/Johannesburg';
const { normalizeAddress, BUTTON_REPLY_SUBJECT } = require('./parser');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function field(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
}

function localDate(value) {
  // SQLite's legacy timestamps contain no zone; they are UTC, never host-local.
  const input = typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value;
  const date = new Date(input);
  if (!value || Number.isNaN(date.getTime())) throw new Error('Invalid notification timestamp');
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: TIMEZONE, year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date) + ' (South Africa time, UTC+02:00)';
}

function count(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error('Invalid notification count');
  return number;
}

function code(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{6,120}$/.test(value)) throw new Error('Invalid notification code');
  return value;
}

function renderTemplate(eventType, payload = {}) {
  let subject;
  let title;
  let paragraphs;
  let confirmationUrl;
  switch (eventType) {
    case 'reminder':
    case 'checkin_reminder': {
      const days = count(payload.daysRemaining, 1, 5);
      const ordinal = count(payload.reminderNumber, 1, 5);
      subject = `Wolf's Vault — Check-in required: ${days} ${days === 1 ? 'day' : 'days'} before access release`;
      title = "Wolf's Vault — Confirm you are active";
      const confirmationMailbox = normalizeAddress(payload.confirmationMailbox);
      if (!confirmationMailbox) throw new Error('Invalid confirmation mailbox');
      const mailboxPath = encodeURIComponent(confirmationMailbox).replace(/%40/g, '@');
      confirmationUrl = `mailto:${mailboxPath}?subject=${encodeURIComponent(BUTTON_REPLY_SUBJECT)}&body=${encodeURIComponent(`CONFIRM ${code(payload.challenge)}`)}`;
      paragraphs = [
        { highlight: `Your Dead Man's Switch is scheduled to reach its final release deadline on ${localDate(payload.releaseAt)}.` },
        { highlight: `${days} ${days === 1 ? 'day remains' : 'days remain'}. This is reminder ${ordinal} of 5.` },
        "If no valid check-in is received before the deadline, beneficiary access will be released under your vault's current policy.",
        'Select Confirm I’m here, then send the prepared email from your verified notification address. No code entry or vault sign-in is needed.',
        { button: 'Confirm I’m here' },
        'Your confirmation resets only the Dead Man’s Switch timer. It does not open your vault or grant access to anyone.',
        `This confirmation expires at ${localDate(payload.challengeExpiresAt)}: 24 hours after issue or at the release deadline, whichever comes first. Each newer reminder invalidates the previous reminder’s button; use the newest email. Do not forward this message.`,
        'If you have already confirmed your activity, no further action is needed. You can ignore a delayed duplicate message.',
      ];
      break;
    }
    case 'checkin_confirmed':
      subject = "Wolf's Vault — Check-in confirmed";
      title = 'Your check-in was accepted.';
      paragraphs = [
        `Confirmed at: ${localDate(payload.confirmedAt)}`,
        `Next routine check-in due: ${localDate(payload.nextCheckinAt)}`,
        `Next final release deadline: ${localDate(payload.nextReleaseAt)}`,
        "Your Dead Man's Switch remains enabled and a new cycle has started. Any outstanding beneficiary emergency-access requests remain separate.",
        'If you did not send this confirmation, sign in to your vault and investigate immediately.',
      ];
      break;
    case 'checkin_failed':
      subject = "Wolf's Vault — Check-in could not be verified";
      title = 'Check-in could not be verified';
      paragraphs = [
        'We received a check-in attempt, but it could not be verified.',
        "Your Dead Man's Switch deadline has not changed.",
        'Use Confirm I’m here in your newest reminder and send the prepared email from your verified notification address. You can also sign in to complete a check-in.',
      ];
      break;
    case 'verify_address':
      subject = "Wolf's Vault — Verify your notification address";
      title = 'Verify your notification address';
      paragraphs = [
        "Enter this code in the signed-in Wolf's Vault notification settings to verify this address:",
        { code: code(payload.verificationCode) },
        `The verification code expires at ${localDate(payload.expiresAt)}. Once verified, future reminders let you confirm your activity by sending a prepared email.`,
        'If you did not request this verification, ignore this message.',
      ];
      break;
    case 'emergency_requested':
      subject = "Wolf's Vault — Emergency access requested";
      title = 'Emergency access requested';
      paragraphs = [
        `A registered beneficiary, ${field(payload.beneficiaryName)}, requested emergency access at ${localDate(payload.requestedAt)}.`,
        `Waiting period: ${count(payload.waitingDays, 0, 36500)} days`,
        `Earliest release time under the existing rules: ${localDate(payload.eligibleAt)}`,
        "If this request is unexpected, sign in to Wolf's Vault to review or deny it. Do not reply with access tokens or account credentials.",
      ];
      break;
    case 'deadswitch_released':
    case 'deadswitch_granted':
      subject = "Wolf's Vault — Automatic beneficiary access activated";
      title = 'Automatic beneficiary access activated';
      paragraphs = [
        `The configured Dead Man's Switch release deadline passed, and beneficiary access was granted at ${localDate(payload.grantedAt)} under the vault's current policy.`,
        'A subsequent email reply does not automatically revoke already-granted access. Review the relevant records securely if you believe this was unexpected.',
      ];
      break;
    case 'access_granted':
    case 'access_revoked':
    case 'emergency_granted':
    case 'emergency_denied': {
      const labels = {
        access_granted: 'Beneficiary access granted', access_revoked: 'Beneficiary access revoked',
        emergency_granted: 'Emergency access granted', emergency_denied: 'Emergency access request denied',
      };
      subject = `Wolf's Vault — ${labels[eventType]}`;
      title = labels[eventType];
      paragraphs = [
        `${title} for ${field(payload.beneficiaryName)} at ${localDate(payload.eventAt)}.`,
        `Access is currently ${payload.accessGranted === true || payload.accessGranted === 1 ? 'granted' : 'not granted'}.`,
        "Sign in to Wolf's Vault to review the recorded access state. Do not reply with access tokens or account credentials.",
      ];
      break;
    }
    case 'legacy_review_due':
      subject = "Wolf's Vault — Information review due";
      title = 'Information review due';
      paragraphs = [
        `An item in Final Wishes is due for review from ${localDate(payload.nextReviewAt)}.`,
        "Sign in to Wolf's Vault and open Final Wishes → Information Reviews to review, reschedule or snooze it.",
        "Reviewing information does not confirm a Dead Man's Switch check-in or change beneficiary access. Use the separate check-in process when needed.",
      ];
      break;
    case 'email_test':
      subject = "Wolf's Vault — Email configuration test";
      title = 'Email configuration test';
      paragraphs = [`This confirms that Wolf's Vault handed a test message to your configured SMTP provider at ${localDate(payload.timestamp)}. It does not establish that future delivery is guaranteed.`];
      break;
    case 'transport_health':
      subject = "Wolf's Vault — Email transport status";
      title = 'Email transport status';
      paragraphs = [
        `Email processing was ${payload.status === 'recovered' ? 'restored' : 'degraded'} at ${localDate(payload.timestamp)}.`,
        'Sign in to review notification status and complete a check-in when needed. Email transport status does not confirm activity or change your release deadline.',
      ];
      break;
    default:
      throw new Error('Unknown notification template');
  }

  const footer = "Wolf's Vault — Automated security notification.";
  const text = [title, '', ...paragraphs.flatMap(p => [typeof p === 'object' ? p.button ? `${p.button}: ${confirmationUrl}\nIf your mail app does not open the button, open this mailto link in a configured email app, then send the prepared message.` : p.code || p.highlight : p, '']), footer].join('\n');
  const body = paragraphs.map(p => typeof p === 'object' && p.button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(confirmationUrl)}" style="display:inline-block;background:#12384c;color:#ffffff;padding:16px 24px;border-radius:6px;text-decoration:none;font-size:18px;font-weight:bold;line-height:1.5">${escapeHtml(p.button)}</a></p><p style="margin:0 0 18px;line-height:1.65;font-size:14px">The button opens your email app. Send the prepared message to confirm. If the button does not work, <a href="${escapeHtml(confirmationUrl)}" style="color:#12384c;text-decoration:underline">open the prepared confirmation email</a> in a configured email app.</p>`
    : typeof p === 'object' && p.code
    ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#edf5f7;border:1px solid #bad4da;border-radius:6px;font-size:15px;line-height:1.6;color:#122e42"><code>${escapeHtml(p.code)}</code></pre>`
    : `<p style="margin:0 0 18px;line-height:1.65">${typeof p === 'object' ? `<strong>${escapeHtml(p.highlight)}</strong>` : escapeHtml(p)}</p>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px 12px;background:#edf2f5;color:#173044;font:16px Arial,Helvetica,sans-serif"><main style="max-width:600px;margin:auto;background:#ffffff;border:1px solid #cfdee4;border-radius:8px;overflow:hidden"><header style="padding:24px;background:#12384c;border-bottom:5px solid #287c86;color:#ffffff"><div style="font-size:14px;letter-spacing:1px">WOLF'S VAULT</div><h1 style="font-size:23px;line-height:1.35;margin:14px 0 0">${escapeHtml(title)}</h1></header><div style="padding:24px">${body}<footer style="border-top:1px solid #cfdee4;padding-top:18px;font-size:12px;line-height:1.6;color:#48606e">${escapeHtml(footer)}</footer></div></main></body></html>`;
  return { subject, text, html };
}

module.exports = { renderTemplate, localDate, escapeHtml, TIMEZONE };
