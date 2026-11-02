'use strict';

const log = require('./logger');

const REQUEST_TIMEOUT_MS = 10000;
const UNAVAILABLE = 'SMS transport is unavailable';

function booleanSetting(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return 'invalid';
}

function unavailable() {
  return { configured: false, simulated: false, async sendOtp() { throw new Error(UNAVAILABLE); } };
}

function createSmsProvider(env = process.env) {
  const provider = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  const flags = [env.COLLECTOR_SMS_ENABLED, env.SMS_ENABLED].map(booleanSetting).filter(value => value !== null);
  // Explicit disabling wins over provider aliases and conflicting flags.
  const enabled = !flags.includes(false) && !flags.includes('invalid') &&
    (flags.includes(true) || provider === 'clickatell');
  const simulateFlags = [env.COLLECTOR_SMS_SIMULATE, env.SMS_SIMULATE].map(booleanSetting);
  const simulate = simulateFlags.includes(true);
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const endpoint = env.COLLECTOR_SMS_ENDPOINT || env.CLICKATELL_ENDPOINT || 'https://platform.clickatell.com/v1/message';
  const authorization = env.COLLECTOR_SMS_AUTHORIZATION || env.CLICKATELL_API_KEY || '';
  const from = env.CLICKATELL_FROM || env.COLLECTOR_SMS_FROM || '';

  if (!enabled || (provider && provider !== 'clickatell') || simulateFlags.includes('invalid') || (simulate && production)) {
    return unavailable();
  }

  if (simulate) {
    return {
      configured: true,
      simulated: true,
      async sendOtp({ to, message }) {
        log.info('sms_otp_simulated_send', { message_length: String(message || '').length });
        return { messages: [{ to: String(to || '').replace(/^\+/, ''), accepted: true, apiMessageId: 'simulated' }] };
      }
    };
  }

  if (!String(authorization).trim()) return unavailable();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return unavailable();
  } catch { return unavailable(); }

  return {
    configured: true,
    simulated: false,
    async sendOtp({ to, message }) {
      const target = String(to || '').trim().replace(/^\+/, '');
      if (!/^[1-9]\d{7,14}$/.test(target) || typeof message !== 'string' || !message.trim()) {
        throw new Error(UNAVAILABLE);
      }
      const payload = { messages: [{ channel: 'sms', to: target, content: message, ...(from ? { from } : {}) }] };

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: 'error'
        });
        if (!response.ok) throw new Error(UNAVAILABLE);
        const data = JSON.parse(await response.text());
        const accepted = data?.messages?.[0];
        // One API can reject a message inside an HTTP 2xx response. Require the
        // documented per-message acceptance, ID and exact echoed SMS recipient.
        // https://help.clickatell.com/developers-api-reference/reference/one-api
        if (!data || data.error != null || !Array.isArray(data.messages) || data.messages.length !== 1 ||
            !accepted || accepted.error != null || accepted.accepted !== true || accepted.to !== target ||
            typeof accepted.apiMessageId !== 'string' || !accepted.apiMessageId.trim()) {
          throw new Error(UNAVAILABLE);
        }
        return { messages: [{ accepted: true, apiMessageId: accepted.apiMessageId, to: target }] };
      } catch {
        // Provider responses and network errors can echo credentials or OTP
        // content. Do not attach their body, request, cause or status to errors.
        throw new Error(UNAVAILABLE);
      }
    }
  };
}

module.exports = { createSmsProvider };
