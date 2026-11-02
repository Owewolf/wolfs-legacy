'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createSmsProvider } = require('../server/sms-provider');
const log = require('../server/logger');

const originalFetch = global.fetch;
const originalTimeout = AbortSignal.timeout;
const originalLog = log.info;
const TO = '+27821230001';
const TARGET = '27821230001';
const MESSAGE = 'Your synthetic sign-in code is 456789';
const KEY = 'synthetic-clickatell-authorization-key';
const configuredEnv = { SMS_PROVIDER: 'clickatell', CLICKATELL_API_KEY: KEY, NODE_ENV: 'production' };

function accepted(overrides = {}) {
  return { messages: [{ accepted: true, apiMessageId: 'synthetic-message-id', to: TARGET, ...overrides }] };
}

function response(data, { status = 202, raw } = {}) {
  return { ok: status >= 200 && status < 300, status, async text() { return raw ?? JSON.stringify(data); } };
}

async function failsWithoutSecrets(provider) {
  await assert.rejects(provider.sendOtp({ to: TO, message: MESSAGE }), error => {
    assert.equal(error.message, 'SMS transport is unavailable');
    assert.deepEqual(Object.keys(error), []);
    assert.equal(error.cause, undefined);
    assert.equal(error.response, undefined);
    assert.ok(!error.stack.includes(KEY));
    assert.ok(!error.stack.includes('456789'));
    return true;
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  log.info = originalLog;
});

test('Clickatell SMS uses One API headers, international digits and confirmed per-message acceptance', async () => {
  let request, deadline;
  const controller = new AbortController();
  AbortSignal.timeout = value => { deadline = value; return controller.signal; };
  global.fetch = async (endpoint, options) => {
    request = { endpoint, options };
    return response(accepted());
  };
  const provider = createSmsProvider(configuredEnv);
  assert.equal(provider.configured, true);
  assert.equal(provider.simulated, false);
  assert.deepEqual(await provider.sendOtp({ to: TO, message: MESSAGE }), accepted());
  assert.equal(request.endpoint, 'https://platform.clickatell.com/v1/message');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, KEY);
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { messages: [{ channel: 'sms', to: TARGET, content: MESSAGE }] });
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.signal, controller.signal);
  assert.equal(deadline, 10000);
});

test('Collector aliases retain priority for custom HTTPS endpoint and raw authorization', async () => {
  global.fetch = async (endpoint, options) => {
    assert.equal(endpoint, 'https://sms.example.test/v1/message');
    assert.equal(options.headers.Authorization, 'synthetic-collector-authorization');
    assert.equal(JSON.parse(options.body).messages[0].from, 'SyntheticSender');
    return response(accepted());
  };
  const provider = createSmsProvider({ ...configuredEnv, COLLECTOR_SMS_ENABLED: 'true',
    COLLECTOR_SMS_ENDPOINT: 'https://sms.example.test/v1/message',
    COLLECTOR_SMS_AUTHORIZATION: 'synthetic-collector-authorization', CLICKATELL_FROM: 'SyntheticSender' });
  assert.equal(provider.configured, true);
  assert.deepEqual(await provider.sendOtp({ to: TO, message: MESSAGE }), accepted());
});

test('explicit disabled flags and unknown configuration fail closed without calling fetch', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('Synthetic unexpected request'); };
  const cases = [
    {}, { ...configuredEnv, COLLECTOR_SMS_ENABLED: 'false' }, { ...configuredEnv, SMS_ENABLED: 'false' },
    { ...configuredEnv, COLLECTOR_SMS_ENABLED: 'true', SMS_ENABLED: 'false' },
    { ...configuredEnv, COLLECTOR_SMS_ENABLED: 'invalid' },
    { ...configuredEnv, COLLECTOR_SMS_SIMULATE: 'invalid' },
    { ...configuredEnv, CLICKATELL_API_KEY: '' },
    { ...configuredEnv, SMS_PROVIDER: 'unknown', COLLECTOR_SMS_ENABLED: 'true' },
    { ...configuredEnv, CLICKATELL_ENDPOINT: 'http://sms.example.test/send' },
    { ...configuredEnv, CLICKATELL_ENDPOINT: 'https://user:pass@sms.example.test/send' }
  ];
  for (const env of cases) {
    const provider = createSmsProvider(env);
    assert.equal(provider.configured, false);
    await failsWithoutSecrets(provider);
  }
  assert.equal(calls, 0);
  assert.equal(createSmsProvider({ ...configuredEnv, COLLECTOR_SMS_ENABLED: ' TRUE ' }).configured, true);
});

test('simulation is unavailable in production and development never logs the OTP or phone', async () => {
  global.fetch = async () => assert.fail('Simulation must not call network transport');
  const logs = [];
  log.info = (...args) => logs.push(args);
  for (const key of ['COLLECTOR_SMS_SIMULATE', 'SMS_SIMULATE']) {
    const provider = createSmsProvider({ ...configuredEnv, [key]: 'true' });
    assert.equal(provider.configured, false);
    await failsWithoutSecrets(provider);
  }
  const simulated = createSmsProvider({ SMS_PROVIDER: 'clickatell', COLLECTOR_SMS_SIMULATE: 'true', NODE_ENV: 'development' });
  assert.equal(simulated.configured, true);
  assert.equal(simulated.simulated, true);
  const result = await simulated.sendOtp({ to: TO, message: MESSAGE });
  assert.equal(result.messages[0].accepted, true);
  assert.equal(result.messages[0].apiMessageId, 'simulated');
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes('456789'));
  assert.ok(!JSON.stringify(logs).includes(TARGET));
  assert.ok(!JSON.stringify(logs).includes(KEY));
});

test('HTTP failures, malformed responses, rejection and wrong recipients cannot count as successful delivery', async () => {
  const cases = [
    response(accepted(), { status: 401 }), response(accepted(), { status: 503 }),
    response(null, { raw: '<html>456789 synthetic-clickatell-authorization-key</html>' }),
    response(null, { raw: '' }), response(null), response({}), response({ messages: [] }),
    response({ messages: [accepted().messages[0], accepted().messages[0]] }, { status: 207 }),
    response(accepted({ accepted: false, error: { code: 20, description: MESSAGE } })),
    response(accepted({ accepted: 'true' })), response(accepted({ accepted: undefined })),
    response(accepted({ apiMessageId: '' })), response(accepted({ apiMessageId: 123 })),
    response(accepted({ apiMessageId: undefined, messageId: 'unsupported-id-field' })),
    response(accepted({ to: '+27821230001' })), response(accepted({ to: '27821230002' })),
    response({ ...accepted(), error: { code: 1, description: KEY } }),
    response(accepted({ error: { code: 1, description: KEY } }))
  ];
  const logs = [];
  log.info = (...args) => logs.push(args);
  for (const result of cases) {
    global.fetch = async () => result;
    await failsWithoutSecrets(createSmsProvider(configuredEnv));
  }
  assert.deepEqual(logs, []);
});

test('network, redirect and timeout errors stay generic without provider bodies or secrets', async () => {
  for (const name of ['TypeError', 'AbortError', 'TimeoutError']) {
    global.fetch = async () => { throw Object.assign(new Error(MESSAGE + KEY), { name }); };
    await failsWithoutSecrets(createSmsProvider(configuredEnv));
  }
  global.fetch = async () => ({ ok: true, status: 202, async text() { throw new Error(MESSAGE + KEY); } });
  await failsWithoutSecrets(createSmsProvider(configuredEnv));
});

test('invalid SMS recipients and empty messages fail without any provider request', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('Synthetic unexpected request'); };
  const provider = createSmsProvider(configuredEnv);
  for (const to of ['0821230001', 'not-a-phone', '+012345678', '+2782 123 0001', '+27821230001123456']) {
    await assert.rejects(provider.sendOtp({ to, message: MESSAGE }), { message: 'SMS transport is unavailable' });
  }
  for (const message of ['', ' ', null]) {
    await assert.rejects(provider.sendOtp({ to: TO, message }), { message: 'SMS transport is unavailable' });
  }
  assert.equal(calls, 0);
});
