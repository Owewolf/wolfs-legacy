const log = require('./logger');

function createSmsProvider(env = process.env) {
  const provider = String(env.SMS_PROVIDER || '').toLowerCase();
  const enabled = env.COLLECTOR_SMS_ENABLED === 'true' || provider === 'clickatell';
  const simulate = env.COLLECTOR_SMS_SIMULATE === 'true';
  const endpoint = env.COLLECTOR_SMS_ENDPOINT || env.CLICKATELL_ENDPOINT || 'https://platform.clickatell.com/v1/message';
  const authorization = env.COLLECTOR_SMS_AUTHORIZATION || env.CLICKATELL_API_KEY || '';
  const from = env.CLICKATELL_FROM || env.COLLECTOR_SMS_FROM || '';

  if (!enabled) {
    return {
      configured: false,
      sendOtp: async () => {
        throw new Error('SMS transport is disabled');
      }
    };
  }

  if (simulate) {
    return {
      configured: true,
      simulated: true,
      async sendOtp({ to, message }) {
        log.info('sms_otp_simulated_send', { phone: to, message_length: String(message || '').length });
        return { SMSMessageData: { Recipients: [{ number: to, status: 'Success', statusCode: 101 }] } };
      }
    };
  }

  if (!authorization) {
    return {
      configured: false,
      sendOtp: async () => {
        throw new Error('Collector SMS credentials are not configured');
      }
    };
  }

  function toCollectorAddress(phone) {
    return String(phone || '').replace(/^\+/, '');
  }

  return {
    configured: true,
    simulated: false,
    async sendOtp({ to, message }) {
      const payload = {
        messages: [
          {
            channel: 'sms',
            to: toCollectorAddress(to),
            content: String(message || ''),
            ...(from ? { from } : {})
          }
        ]
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authorization
        },
        body: JSON.stringify(payload)
      });

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const err = new Error(`Collector SMS request failed with status ${response.status}`);
        err.response = { status: response.status, data };
        throw err;
      }

      return data;
    }
  };
}

module.exports = { createSmsProvider };