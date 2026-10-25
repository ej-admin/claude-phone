/**
 * HOME-11645: contract for voice-app/lib/api-security.js, the pure decisions behind the voice-app HTTP
 * API lock-down. Before this change POST /api/outbound-call (and every other route on :3000) answered
 * anyone who could open a TCP connection, and dialed whatever `to` the body named.
 *
 * Two controls, each a small pure function so the decision is unit-testable without a socket:
 *
 *   1. A shared secret (X-Claude-Api-Key) on every route except GET/HEAD /health, compared in constant
 *      time. No usable key configured = the API is LOCKED (everything but /health is a 401); there is
 *      deliberately no unauthenticated mode. The process still boots: it is also the SIP endpoint, and
 *      a missing env var must not take inbound calls down with it.
 *   2. An exact-match destination allowlist for POST /api/outbound-call (OUTBOUND_ALLOWED_TO). Unset or
 *      empty = every call refused.
 *
 * One narrow exemption exists and is pinned here: FreeSWITCH, on the same host, fetches TTS audio and
 * beeps over http://127.0.0.1:3000/audio-files/... and /static/... and cannot send a header.
 *
 * Run with: node --test test/api-security.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const security = require(path.join(__dirname, '..', 'lib', 'api-security'));

// Built at runtime: a token-shaped literal in a test file trips the credential scanner.
const KEY = 'unit-' + require('node:crypto').randomBytes(24).toString('hex');
// 555-01xx is the range reserved for fiction: no real subscriber can ever sit behind these.
const ALLOWED = '+15555550100';
const ALLOWED_2 = '+15555550101';

function fakeReq({ method = 'GET', reqPath = '/api/calls', headers = {}, remoteAddress = '198.51.100.9' } = {}) {
  const lower = {};
  for (const name of Object.keys(headers)) lower[name.toLowerCase()] = headers[name];
  return {
    method,
    path: reqPath,
    get: (name) => lower[String(name).toLowerCase()],
    socket: { remoteAddress }
  };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// ---------------------------------------------------------------------------------------------
// loadApiKey
// ---------------------------------------------------------------------------------------------

test('API_KEY_HEADER and MIN_KEY_LENGTH match claude-api-server (one convention across the fleet)', () => {
  assert.equal(security.API_KEY_HEADER, 'X-Claude-Api-Key');
  assert.equal(security.MIN_KEY_LENGTH, 32);
});

test('loadApiKey: unset, blank and whitespace-only are not usable', () => {
  for (const env of [{}, { CLAUDE_API_KEY: '' }, { CLAUDE_API_KEY: '   \n' }, null, undefined]) {
    const r = security.loadApiKey(env);
    assert.equal(r.ok, false);
    assert.match(r.error, /CLAUDE_API_KEY/);
  }
});

test('loadApiKey: a key shorter than MIN_KEY_LENGTH is refused and its value is never put in the message', () => {
  const short = 'x'.repeat(security.MIN_KEY_LENGTH - 1);
  const r = security.loadApiKey({ CLAUDE_API_KEY: short });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(short), 'the error must not echo the configured value');
});

test('loadApiKey: exactly MIN_KEY_LENGTH is accepted, and surrounding whitespace (env-file newline) is trimmed', () => {
  const exact = 'k'.repeat(security.MIN_KEY_LENGTH);
  assert.deepEqual(security.loadApiKey({ CLAUDE_API_KEY: exact }), { ok: true, key: exact });
  assert.deepEqual(security.loadApiKey({ CLAUDE_API_KEY: `  ${exact}\n` }), { ok: true, key: exact });
});

// ---------------------------------------------------------------------------------------------
// keysMatch
// ---------------------------------------------------------------------------------------------

test('keysMatch: equal strings match, any difference does not', () => {
  assert.equal(security.keysMatch(KEY, KEY), true);
  assert.equal(security.keysMatch(KEY.slice(0, -1) + 'X', KEY), false);
  assert.equal(security.keysMatch(KEY + 'x', KEY), false);
  assert.equal(security.keysMatch(KEY.slice(1), KEY), false);
});

test('keysMatch: non-string input never matches and never throws', () => {
  for (const bad of [undefined, null, 0, 1, true, {}, [], [KEY], Buffer.from(KEY)]) {
    assert.equal(security.keysMatch(bad, KEY), false);
    assert.equal(security.keysMatch(KEY, bad), false);
  }
});

// ---------------------------------------------------------------------------------------------
// isLoopbackAddress
// ---------------------------------------------------------------------------------------------

test('isLoopbackAddress: only the local host is loopback', () => {
  for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(security.isLoopbackAddress(ok), true, ok);
  }
  for (const no of [
    '192.0.2.50', '198.51.100.5', '172.17.0.2', '10.0.0.1', '0.0.0.0', '::', '::ffff:192.0.2.1',
    '127.0.0.1.evil.example', '1270.0.0.1', '127.0.0', '127.0.0.256', '', 'localhost', undefined, null, 127
  ]) {
    assert.equal(security.isLoopbackAddress(no), false, String(no));
  }
});

// ---------------------------------------------------------------------------------------------
// isPublicRoute
// ---------------------------------------------------------------------------------------------

test('isPublicRoute: only GET and HEAD of /health, spelled exactly', () => {
  assert.equal(security.isPublicRoute(fakeReq({ method: 'GET', reqPath: '/health' })), true);
  assert.equal(security.isPublicRoute(fakeReq({ method: 'HEAD', reqPath: '/health' })), true);
  for (const [method, reqPath] of [
    ['POST', '/health'], ['PUT', '/health'], ['DELETE', '/health'],
    ['GET', '/Health'], ['GET', '/HEALTH'], ['GET', '/health/'], ['GET', '/health/x'], ['GET', '/healthz'],
    ['GET', '//health'], ['GET', '/api/health'], ['GET', '/']
  ]) {
    assert.equal(security.isPublicRoute(fakeReq({ method, reqPath })), false, `${method} ${reqPath}`);
  }
});

// ---------------------------------------------------------------------------------------------
// isLocalMediaFetch: the one narrow exemption
// ---------------------------------------------------------------------------------------------

test('isLocalMediaFetch: GET/HEAD of one file under /audio-files or /static from the local host', () => {
  for (const method of ['GET', 'HEAD']) {
    for (const reqPath of [
      '/audio-files/audio_1700000000000_0123456789abcdef.wav',
      '/audio-files/tts-1.mp3',
      '/static/ready-beep.wav',
      '/static/gotit-beep.wav'
    ]) {
      assert.equal(security.isLocalMediaFetch(fakeReq({ method, reqPath, remoteAddress: '127.0.0.1' })), true, `${method} ${reqPath}`);
    }
  }
  assert.equal(security.isLocalMediaFetch(fakeReq({ reqPath: '/static/ready-beep.wav', remoteAddress: '::1' })), true);
  assert.equal(security.isLocalMediaFetch(fakeReq({ reqPath: '/static/ready-beep.wav', remoteAddress: '::ffff:127.0.0.1' })), true);
});

test('isLocalMediaFetch: a non-local peer gets no exemption, even for the same file', () => {
  for (const remoteAddress of ['192.0.2.50', '198.51.100.5', '172.17.0.2', '::ffff:10.0.0.9', undefined]) {
    assert.equal(
      security.isLocalMediaFetch(fakeReq({ reqPath: '/audio-files/tts-1.wav', remoteAddress })),
      false,
      String(remoteAddress)
    );
  }
});

test('isLocalMediaFetch: nothing but a plain read of a single file name is exempt', () => {
  const local = { remoteAddress: '127.0.0.1' };
  // writes
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(security.isLocalMediaFetch(fakeReq({ method, reqPath: '/audio-files/tts-1.wav', ...local })), false, method);
  }
  // shapes that are not "one file name"
  for (const reqPath of [
    '/audio-files/', '/audio-files', '/static/', '/static',
    '/audio-files/../health', '/audio-files/..', '/audio-files/.', '/audio-files/.hidden',
    '/audio-files/a/b.wav', '/audio-files//x.wav', '//audio-files/x.wav',
    '/audio-files/%2e%2e', '/audio-files/..%2fhealth', '/audio-files/a%2fb.wav', '/audio-files/x.wav%00',
    '/audio-files/x y.wav', '/audio-files/x\\y.wav', '/audio-files/x.wav/',
    // neighbours that must stay locked
    '/audio/x.wav', '/audio', '/Audio-Files/x.wav', '/STATIC/x.wav', '/audio-files-evil/x.wav', '/api/calls', '/api/outbound-call', '/health'
  ]) {
    assert.equal(security.isLocalMediaFetch(fakeReq({ reqPath, ...local })), false, reqPath);
  }
});

// ---------------------------------------------------------------------------------------------
// createAuthMiddleware
// ---------------------------------------------------------------------------------------------

test('createAuthMiddleware: the right key passes, and only the right key', () => {
  const mw = security.createAuthMiddleware({ key: KEY });
  let nexted = 0;
  const res = fakeRes();
  mw(fakeReq({ headers: { 'X-Claude-Api-Key': KEY } }), res, () => { nexted += 1; });
  assert.equal(nexted, 1);
  assert.equal(res.statusCode, null, 'a passing request is not answered by the middleware');
});

test('createAuthMiddleware: missing, wrong, empty and array-valued keys are a bare 401 and never reach next()', () => {
  const mw = security.createAuthMiddleware({ key: KEY });
  for (const headers of [
    {},
    { 'X-Claude-Api-Key': '' },
    { 'X-Claude-Api-Key': KEY.slice(0, -1) + 'X' },
    { 'X-Claude-Api-Key': KEY + ' ' },
    { 'X-Claude-Api-Key': KEY.toUpperCase() },
    { 'X-Claude-Api-Key': [KEY, KEY] },
    { Authorization: `Bearer ${KEY}` },
    { 'X-Api-Key': KEY }
  ]) {
    let nexted = 0;
    const res = fakeRes();
    mw(fakeReq({ headers }), res, () => { nexted += 1; });
    assert.equal(nexted, 0, JSON.stringify(Object.keys(headers)));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { success: false, error: 'unauthorized' });
  }
});

test('createAuthMiddleware: /health is public, every other path and method is not', () => {
  const mw = security.createAuthMiddleware({ key: KEY });
  let nexted = 0;
  mw(fakeReq({ method: 'GET', reqPath: '/health' }), fakeRes(), () => { nexted += 1; });
  mw(fakeReq({ method: 'HEAD', reqPath: '/health' }), fakeRes(), () => { nexted += 1; });
  assert.equal(nexted, 2);
  for (const [method, reqPath] of [
    ['POST', '/api/outbound-call'], ['GET', '/api/calls'], ['GET', '/api/call/x'], ['POST', '/api/call/x/hangup'],
    ['GET', '/api/devices'], ['POST', '/api/query'], ['POST', '/audio'], ['GET', '/does-not-exist'], ['GET', '/Health']
  ]) {
    const res = fakeRes();
    mw(fakeReq({ method, reqPath }), res, () => assert.fail(`${method} ${reqPath} must not pass`));
    assert.equal(res.statusCode, 401, `${method} ${reqPath}`);
  }
});

test('createAuthMiddleware: LOCKED mode (no key) denies everything but the exemptions, even an empty header', () => {
  for (const key of [null, undefined]) {
    const mw = security.createAuthMiddleware({ key });
    // The classic fail-open bug: "" === "" when neither side has a key.
    for (const headers of [{}, { 'X-Claude-Api-Key': '' }, { 'X-Claude-Api-Key': 'anything' }, { 'X-Claude-Api-Key': KEY }]) {
      const res = fakeRes();
      mw(fakeReq({ reqPath: '/api/outbound-call', method: 'POST', headers }), res, () => assert.fail('locked API let a request through'));
      assert.equal(res.statusCode, 401);
    }
    let nexted = 0;
    mw(fakeReq({ reqPath: '/health' }), fakeRes(), () => { nexted += 1; });
    mw(fakeReq({ reqPath: '/static/ready-beep.wav', remoteAddress: '127.0.0.1' }), fakeRes(), () => { nexted += 1; });
    assert.equal(nexted, 2, 'health and the local media fetch keep working while locked');
  }
});

test('createAuthMiddleware: a configured key that is too short is a programming error, not a quiet weak key', () => {
  assert.throws(() => security.createAuthMiddleware({ key: 'short' }), /key/i);
  assert.throws(() => security.createAuthMiddleware({ key: '' }), /key/i);
});

test('createAuthMiddleware: the local media exemption holds for a keyed server too, and only for local peers', () => {
  const mw = security.createAuthMiddleware({ key: KEY });
  let nexted = 0;
  mw(fakeReq({ reqPath: '/audio-files/tts-1.wav', remoteAddress: '127.0.0.1' }), fakeRes(), () => { nexted += 1; });
  assert.equal(nexted, 1);
  const res = fakeRes();
  mw(fakeReq({ reqPath: '/audio-files/tts-1.wav', remoteAddress: '198.51.100.5' }), res, () => assert.fail('remote peer must not be exempt'));
  assert.equal(res.statusCode, 401);
});

test('createAuthMiddleware: onDenied sees method, path and peer, never the presented credential, and cannot break the 401', () => {
  const seen = [];
  const mw = security.createAuthMiddleware({ key: KEY, onDenied: (info) => seen.push(info) });
  const presented = 'presented-' + KEY;
  const res = fakeRes();
  mw(fakeReq({ method: 'POST', reqPath: '/api/outbound-call', headers: { 'X-Claude-Api-Key': presented }, remoteAddress: '198.51.100.7' }), res, () => assert.fail('denied'));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(seen, [{ method: 'POST', path: '/api/outbound-call', remoteAddress: '198.51.100.7' }]);
  assert.ok(!JSON.stringify(seen).includes(presented));
  assert.ok(!JSON.stringify(seen).includes(KEY));

  const throwing = security.createAuthMiddleware({ key: KEY, onDenied: () => { throw new Error('logger down'); } });
  const res2 = fakeRes();
  throwing(fakeReq({ reqPath: '/api/calls' }), res2, () => assert.fail('a logging failure must not let the request through'));
  assert.equal(res2.statusCode, 401, 'a logging failure must not turn a denial into a 500');
});

// ---------------------------------------------------------------------------------------------
// Destination allowlist
// ---------------------------------------------------------------------------------------------

test('parseAllowedDestinations: comma list is trimmed, blanks skipped, duplicates collapse', () => {
  const { allowed, ignored } = security.parseAllowedDestinations(` ${ALLOWED} , ${ALLOWED_2} ,, ${ALLOWED} , `);
  assert.deepEqual([...allowed].sort(), [ALLOWED, ALLOWED_2].sort());
  assert.deepEqual(ignored, []);
});

test('parseAllowedDestinations: unset / empty / blank means an EMPTY set (fail closed), never "allow all"', () => {
  for (const raw of [undefined, null, '', '   ', ',', ' , , ']) {
    const { allowed } = security.parseAllowedDestinations(raw);
    assert.equal(allowed.size, 0, JSON.stringify(raw));
  }
});

test('parseAllowedDestinations: malformed entries (wildcards, words, spaces, bad prefixes) are dropped and reported, never kept', () => {
  const junk = ['*', '+1555*', 'ALL', 'any', '+0123456789', '+1 555 555 0100', '+', '++15555550100', '15555550100;rm', '+1555555010a', '(555)555-0100'];
  const { allowed, ignored } = security.parseAllowedDestinations([ALLOWED, ...junk].join(','));
  assert.deepEqual([...allowed], [ALLOWED]);
  assert.deepEqual([...ignored].sort(), [...junk].sort());
});

test('parseAllowedDestinations: an array is accepted too, and dial strings the route validator accepts may be listed', () => {
  const { allowed } = security.parseAllowedDestinations([ALLOWED, '5755']);
  assert.deepEqual([...allowed].sort(), ['5755', ALLOWED].sort());
});

test('isDestinationAllowed: EXACT string match only, no normalisation of any kind', () => {
  const { allowed } = security.parseAllowedDestinations(ALLOWED);
  assert.equal(security.isDestinationAllowed(allowed, ALLOWED), true);
  for (const to of [
    '15555550100',              // same digits, no "+": the route dials this as a raw dial string
    '915555550100',             // 3CX outbound-rule prefix + number
    '+1555555010',              // prefix of an allowed number
    '+155555501000',            // allowed number plus a digit
    ` ${ALLOWED}`, `${ALLOWED} `, `${ALLOWED}\n`, `${ALLOWED}\u0000`,
    ALLOWED.replace('+', '%2B'),
    '5555550100',
    '', undefined, null, 15555550100, [ALLOWED], { toString: () => ALLOWED }
  ]) {
    assert.equal(security.isDestinationAllowed(allowed, to), false, JSON.stringify(to));
  }
});

test('isDestinationAllowed: an empty allowlist allows nothing', () => {
  assert.equal(security.isDestinationAllowed(new Set(), ALLOWED), false);
  assert.equal(security.isDestinationAllowed(new Set(), '*'), false);
});
