/**
 * GEN-10898 (security triage 22893): unit contract for security.js, the pure decision logic behind
 * the claude-api-server hardening. The end-to-end behaviour (a real server, real sockets) is pinned
 * in api-auth.test.js; this file pins the individual decisions so a regression names the rule it broke.
 *
 *   - loadApiKey         the shared secret must exist and be long enough; never echoed in an error
 *   - keysMatch          constant-time comparison; never throws on hostile input
 *   - isPublicRoute      exactly GET/HEAD /health is exempt from authentication, nothing else
 *   - parseEnabledFlag   /ask is opt-in: only an explicit yes enables it, a typo fails closed
 *   - resolveListenAddresses  never the wildcard by default; tailnet addresses only when present
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const security = require('../security');

// Built at runtime: a token-shaped literal in a test file trips the credential scanner.
const KEY = 'unit-' + crypto.randomBytes(24).toString('hex');

// ── loadApiKey ───────────────────────────────────────────────────────────────

test('loadApiKey: a key of at least MIN_KEY_LENGTH characters is accepted', () => {
  const exactlyMin = 'k'.repeat(security.MIN_KEY_LENGTH);

  const result = security.loadApiKey({ CLAUDE_API_KEY: exactlyMin });

  assert.equal(result.ok, true, 'a key exactly at the minimum length must be accepted');
  assert.equal(result.key, exactlyMin);
});

test('loadApiKey: unset, blank and whitespace-only keys are refused and the error names the variable', () => {
  for (const env of [{}, { CLAUDE_API_KEY: '' }, { CLAUDE_API_KEY: '   \n\t ' }]) {
    const result = security.loadApiKey(env);

    assert.equal(result.ok, false, `env ${JSON.stringify(env)} must not yield a usable key`);
    assert.match(result.error, /CLAUDE_API_KEY/, 'the operator must be told which variable to set');
  }
});

test('loadApiKey: a key one character below the minimum is refused (a guessable key is no key)', () => {
  const result = security.loadApiKey({ CLAUDE_API_KEY: 'k'.repeat(security.MIN_KEY_LENGTH - 1) });

  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(String(security.MIN_KEY_LENGTH)), 'the error states the minimum length');
});

test('loadApiKey: surrounding whitespace is trimmed (an env file with a trailing newline must still match the client)', () => {
  const result = security.loadApiKey({ CLAUDE_API_KEY: `  ${KEY}\n` });

  assert.equal(result.ok, true);
  assert.equal(result.key, KEY, 'the stored key must equal what a client sending the trimmed value presents');
});

test('loadApiKey: no error message ever contains the key value', () => {
  const tooShort = 'secret-' + 'x'.repeat(5);

  const result = security.loadApiKey({ CLAUDE_API_KEY: tooShort });

  assert.equal(result.ok, false);
  assert.ok(!result.error.includes(tooShort), 'a rejected key must not be echoed into logs');
});

// ── keysMatch ────────────────────────────────────────────────────────────────

test('keysMatch: identical keys match', () => {
  assert.equal(security.keysMatch(KEY, KEY), true);
});

test('keysMatch: different keys, a prefix, an extension and a case change do not match', () => {
  const swapped = KEY.slice(0, -1) + (KEY.endsWith('0') ? '1' : '0');
  for (const presented of [swapped, KEY.slice(0, -1), KEY + 'x', KEY.toUpperCase(), '']) {
    assert.equal(security.keysMatch(presented, KEY), false, `"${presented.slice(0, 8)}…" must not match`);
  }
});

test('keysMatch: non-string input never matches and never throws', () => {
  for (const presented of [undefined, null, 0, 12345, {}, [], [KEY], true]) {
    assert.doesNotThrow(() => security.keysMatch(presented, KEY));
    assert.equal(security.keysMatch(presented, KEY), false, `${JSON.stringify(presented)} must not authenticate`);
  }
});

test('keysMatch: a very long or non-ASCII presented value does not throw (timingSafeEqual needs equal lengths)', () => {
  assert.doesNotThrow(() => security.keysMatch('é'.repeat(100000), KEY));
  assert.equal(security.keysMatch('é'.repeat(100000), KEY), false);
});

test('keysMatch: the comparison goes through crypto.timingSafeEqual on equal-length digests, never ===', () => {
  // Timing cannot be asserted in a unit test, so spy on the primitive instead: replacing the call with
  // `presented === expected` (or an early return on length) is the tempting "simplification" to catch.
  const original = crypto.timingSafeEqual;
  const calls = [];
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return original(a, b); };
  let result;
  try {
    result = security.keysMatch(KEY, KEY + 'longer-than-the-key');
  } finally {
    crypto.timingSafeEqual = original;
  }

  assert.equal(result, false);
  assert.equal(calls.length, 1, 'the comparison must call crypto.timingSafeEqual exactly once, even for unequal input lengths');
  assert.equal(calls[0][0], calls[0][1], 'both sides are hashed first, so the compared buffers always have equal length');
});

// ── isPublicRoute ────────────────────────────────────────────────────────────

test('isPublicRoute: GET and HEAD /health are the only public routes', () => {
  assert.equal(security.isPublicRoute({ method: 'GET', path: '/health' }), true);
  assert.equal(security.isPublicRoute({ method: 'HEAD', path: '/health' }), true);
});

test('isPublicRoute: everything near /health is NOT public (fail closed on any variation)', () => {
  const near = [
    { method: 'POST', path: '/health' },
    { method: 'PUT', path: '/health' },
    { method: 'DELETE', path: '/health' },
    { method: 'GET', path: '/health/' },
    { method: 'GET', path: '/HEALTH' },
    { method: 'GET', path: '/healthz' },
    { method: 'GET', path: '/health/extra' },
    { method: 'GET', path: '//health' },
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/ask' },
    { method: 'GET', path: undefined },
  ];
  for (const req of near) {
    assert.equal(security.isPublicRoute(req), false, `${req.method} ${req.path} must require the key`);
  }
});

// ── parseEnabledFlag ─────────────────────────────────────────────────────────

test('parseEnabledFlag: only an explicit yes enables the feature', () => {
  for (const raw of ['1', 'true', 'TRUE', 'True', 'yes', 'on', ' 1 ', ' true\n']) {
    assert.equal(security.parseEnabledFlag(raw), true, `"${raw}" is an explicit yes`);
  }
});

test('parseEnabledFlag: unset, 0, false and every typo stay disabled (fail closed)', () => {
  for (const raw of [undefined, null, '', '   ', '0', 'false', 'no', 'off', 'y', 'enabled', 'tru', '2', '-1', 'maybe', '1.0']) {
    assert.equal(security.parseEnabledFlag(raw), false, `${JSON.stringify(raw)} must NOT enable /ask`);
  }
});

// ── isTailnetAddress ─────────────────────────────────────────────────────────

test('isTailnetAddress: exactly the CGNAT range 100.64.0.0/10 that Tailscale uses', () => {
  assert.equal(security.isTailnetAddress('100.64.0.0'), true);
  assert.equal(security.isTailnetAddress('100.100.100.100'), true);
  assert.equal(security.isTailnetAddress('100.127.255.255'), true);
});

test('isTailnetAddress: neighbours of the range, private ranges, IPv6 and garbage are not tailnet', () => {
  for (const ip of ['100.63.255.255', '100.128.0.0', '10.0.0.1', '172.20.4.247', '192.168.0.10', '127.0.0.1', '0.0.0.0', '::1', 'fd7a:115c:a1e0::1', 'not-an-ip', '', undefined]) {
    assert.equal(security.isTailnetAddress(ip), false, `${ip} must not be treated as a tailnet address`);
  }
});

// ── resolveListenAddresses ───────────────────────────────────────────────────

function iface(address, { internal = false, family = 'IPv4' } = {}) {
  return { address, internal, family };
}

test('resolveListenAddresses: with nothing configured and no tailnet interface the default is loopback only', () => {
  const { addresses } = security.resolveListenAddresses({}, { lo: [iface('127.0.0.1', { internal: true })], eth0: [iface('172.20.4.247')] });

  assert.deepEqual(addresses, ['127.0.0.1'], 'the default must never include the wildcard or a non-tailnet LAN address');
});

test('resolveListenAddresses: the default adds the tailnet address found on a local interface', () => {
  const { addresses } = security.resolveListenAddresses({}, {
    lo: [iface('127.0.0.1', { internal: true })],
    eth0: [iface('192.168.0.50')],
    tailscale0: [iface('100.100.100.100'), iface('fd7a:115c:a1e0::1', { family: 'IPv6' })],
  });

  assert.deepEqual(addresses, ['127.0.0.1', '100.100.100.100'], 'loopback plus the tailnet IPv4 address, nothing else');
});

test('resolveListenAddresses: a blank CLAUDE_API_LISTEN is treated as unset, not as "bind nothing"', () => {
  const { addresses } = security.resolveListenAddresses({ CLAUDE_API_LISTEN: '  ' }, {});

  assert.deepEqual(addresses, ['127.0.0.1']);
});

test('resolveListenAddresses: an explicit list replaces the default; whitespace, blanks and duplicates are cleaned', () => {
  const { addresses } = security.resolveListenAddresses({ CLAUDE_API_LISTEN: ' 127.0.0.1 , 172.20.4.247,,127.0.0.1 ' }, {
    tailscale0: [iface('100.100.100.100')],
  });

  assert.deepEqual(addresses, ['127.0.0.1', '172.20.4.247'], 'explicit means explicit: the detected tailnet address is not added');
});

test('resolveListenAddresses: IPv6 literals are accepted', () => {
  const { addresses } = security.resolveListenAddresses({ CLAUDE_API_LISTEN: '::1' }, {});

  assert.deepEqual(addresses, ['::1']);
});

test('resolveListenAddresses: an entry that is not an IP literal throws and names the variable and the entry', () => {
  for (const bad of ['localhost', 'not-an-ip', '127.0.0.1:3333', '999.1.1.1', 'eth0']) {
    assert.throws(
      () => security.resolveListenAddresses({ CLAUDE_API_LISTEN: `127.0.0.1,${bad}` }, {}),
      (err) => /CLAUDE_API_LISTEN/.test(err.message) && err.message.includes(bad),
      `"${bad}" must be refused, not silently dropped (a dropped address leaves a consumer dead with no explanation)`
    );
  }
});

test('resolveListenAddresses: a wildcard is allowed only when written explicitly, and always carries a warning', () => {
  for (const wildcard of ['0.0.0.0', '::']) {
    const { addresses, warnings } = security.resolveListenAddresses({ CLAUDE_API_LISTEN: `127.0.0.1,${wildcard}` }, {});

    assert.ok(addresses.includes(wildcard), `an explicit ${wildcard} is honoured`);
    assert.ok(warnings.length >= 1, 'a wildcard bind must be flagged loudly');
    assert.match(warnings.join(' '), /wildcard/i);
  }
});

test('resolveListenAddresses: the default never produces a warning (nothing to warn about)', () => {
  const { warnings } = security.resolveListenAddresses({}, { lo: [iface('127.0.0.1', { internal: true })] });

  assert.deepEqual(warnings, []);
});

// ── createAskGate / createAuthMiddleware: behaviour on fake req/res ──────────

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('createAuthMiddleware: a request without the key is answered 401 and next() is NOT called', () => {
  const mw = security.createAuthMiddleware({ key: KEY });
  const res = fakeRes();
  let nextCalled = false;

  mw({ method: 'POST', path: '/ask', get: () => undefined }, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.equal(nextCalled, false, 'the handler behind the gate must not run for an unauthenticated request');
});

test('createAuthMiddleware: onDenied receives the request and never the presented key', () => {
  const seen = [];
  const mw = security.createAuthMiddleware({ key: KEY, onDenied: (info) => seen.push(info) });
  const presented = 'presented-' + 'y'.repeat(40);

  mw({ method: 'GET', path: '/outbound-calls', get: () => presented, socket: { remoteAddress: '203.0.113.9' } }, fakeRes(), () => {});

  assert.equal(seen.length, 1, 'a denial is reported exactly once');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].path, '/outbound-calls');
  assert.ok(!JSON.stringify(seen[0]).includes(presented), 'the presented key must never be passed to the logger');
});

test('createAuthMiddleware: the right key calls next() and does not report a denial', () => {
  const denied = [];
  const mw = security.createAuthMiddleware({ key: KEY, onDenied: (i) => denied.push(i) });
  let nextCalled = false;

  mw({ method: 'POST', path: '/ask', get: () => KEY }, fakeRes(), () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(denied.length, 0);
});

test('createAuthMiddleware: refuses to be constructed without a usable key (no accidental open server)', () => {
  for (const key of [undefined, null, '', 'short']) {
    assert.throws(() => security.createAuthMiddleware({ key }), /key/i, `key ${JSON.stringify(key)} must not build a middleware`);
  }
});

test('createAskGate: disabled answers 403 and never calls next(); enabled calls next()', () => {
  const resOff = fakeRes();
  let offNext = false;
  security.createAskGate({ enabled: false })({}, resOff, () => { offNext = true; });

  const resOn = fakeRes();
  let onNext = false;
  security.createAskGate({ enabled: true })({}, resOn, () => { onNext = true; });

  assert.equal(resOff.statusCode, 403);
  assert.equal(resOff.body.success, false);
  assert.match(resOff.body.error, /CLAUDE_API_ASK_ENABLED/, 'an authenticated operator is told how to enable it');
  assert.equal(offNext, false, 'the CLI-spawning handler must not run while disabled');
  assert.equal(onNext, true);
  assert.equal(resOn.statusCode, 200);
});
