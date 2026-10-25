/**
 * HOME-11645: the voice-app HTTP API on :3000 used to answer anyone who could open a TCP connection.
 * POST /api/outbound-call dialed whatever `to` the body named, GET /api/calls listed in-flight calls,
 * POST /api/query reached the Claude bridge, and POST /audio wrote files. These tests drive the REAL
 * createHttpServer and the REAL outbound and query routers over real sockets.
 *
 * No test can place a call. The SIP layer is a spy: `mediaServer.createEndpoint()` is the first thing
 * the dial path calls, so "a dial was attempted" is observable as a recorded call, and the spy rejects.
 * The positive control (an allowlisted number DOES reach the spy) is what makes the "denied numbers
 * never reach the spy" assertions mean something.
 *
 * Groups:
 *   A  keyed server: every route but GET/HEAD /health needs X-Claude-Api-Key
 *   B  no usable key: the API is locked, the process still serves its own audio fetches
 *   C  the destination allowlist on POST /api/outbound-call
 *   D  FreeSWITCH's loopback fetches of /audio-files and /static keep working, and only those
 *
 * Run with: node --test test/http-api-auth.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LIB = path.join(__dirname, '..', 'lib');
// Built at runtime: a token-shaped literal in a test file trips the credential scanner.
const KEY = 'voice-http-' + crypto.randomBytes(24).toString('hex');
// 555-01xx is the range reserved for fiction: no real subscriber can ever sit behind these.
const ALLOWED = '+15555550100';
const ALLOWED_2 = '+15555550101';
const OTHER = '+15555550199';

/**
 * tts-service starts a module-level setInterval that keeps the process alive. Load the modules with
 * unref'd intervals so `node --test` can exit, then put the real setInterval back.
 */
function loadModules() {
  const realSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    const timer = realSetInterval(...args);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };
  try {
    for (const name of ['outbound-routes', 'query-routes']) {
      delete require.cache[require.resolve(path.join(LIB, name))];
    }
    return {
      createHttpServer: require(path.join(LIB, 'http-server')).createHttpServer,
      outbound: require(path.join(LIB, 'outbound-routes')),
      query: require(path.join(LIB, 'query-routes'))
    };
  } finally {
    global.setInterval = realSetInterval;
  }
}

/**
 * outbound-session keeps a finished session for 60 s with a plain setTimeout, which would hold this test
 * process open for a minute after the last assertion. Unref only the long timers (the tests' own sleeps
 * are 50-100 ms and are untouched) and put the real setTimeout back when the file is done.
 */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => {
  const timer = realSetTimeout(fn, ms, ...args);
  if (typeof ms === 'number' && ms >= 10000 && timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};
test.after(() => { global.setTimeout = realSetTimeout; });

function withEnv(vars, fn) {
  const saved = {};
  for (const name of Object.keys(vars)) {
    saved[name] = process.env[name];
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  }
  try {
    return fn();
  } finally {
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const apps = [];

/**
 * Start the real HTTP server on an ephemeral port with the real routers mounted exactly as index.js
 * mounts them. `env` is what the server believes process.env is; `allowed` goes to the outbound router
 * (undefined = let it read OUTBOUND_ALLOWED_TO from `env`).
 */
async function startApp({ env = {}, allowed, isLocalRequest } = {}) {
  const { createHttpServer, outbound, query } = loadModules();
  const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home11645-audio-'));
  fs.writeFileSync(path.join(audioDir, 'tts-1.wav'), 'RIFFfake-audio');

  const dialAttempts = [];
  const mediaServer = {
    createEndpoint: async () => {
      dialAttempts.push(Date.now());
      throw new Error('test double: no real media endpoint');
    }
  };

  const options = { env };
  if (isLocalRequest) options.isLocalRequest = isLocalRequest;
  const hs = createHttpServer(audioDir, 0, options);
  if (!hs.server.listening) await new Promise((resolve) => hs.server.once('listening', resolve));

  const deps = { srf: {}, mediaServer };
  if (allowed !== undefined) deps.allowedDestinations = allowed;
  withEnv({ OUTBOUND_ALLOWED_TO: env.OUTBOUND_ALLOWED_TO }, () => outbound.setupRoutes(deps));
  hs.app.use('/api', outbound.router);
  query.setupRoutes({ claudeBridge: null });
  hs.app.use('/api', query.router);
  hs.finalize();

  const app = { port: hs.server.address().port, dialAttempts, audioDir, close: () => hs.close() };
  apps.push(app);
  return app;
}

test.after(() => {
  for (const app of apps) {
    try { app.close(); } catch { /* already closed */ }
    fs.rmSync(app.audioDir, { recursive: true, force: true });
  }
});

/** Raw request: the path is sent exactly as written (fetch would normalise `..` away). */
function request(app, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port: app.port,
      method,
      path: urlPath,
      headers: Object.assign({}, payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers)
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const withKey = (key = KEY) => ({ 'X-Claude-Api-Key': key });
const validCall = (to) => ({ to, message: 'test message' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run fn with console output captured, so a test can assert what was (not) logged. */
async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    saved[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// A. keyed server
// ---------------------------------------------------------------------------------------------

const PROTECTED = [
  ['POST', '/api/outbound-call', validCall(ALLOWED)],
  ['GET', '/api/calls'],
  ['GET', '/api/call/some-call-id'],
  ['POST', '/api/call/some-call-id/hangup', {}],
  ['GET', '/api/devices'],
  ['GET', '/api/device/anything'],
  ['POST', '/api/query', { query: 'hello' }],
  ['POST', '/audio', 'RIFFfake'],
  ['GET', '/does-not-exist'],
  ['GET', '/Health'],
  ['GET', '/health/'],
  ['GET', '/health?x=1/../api/calls']
];

test('A1. every route but /health is a 401 without the key, including a route that does not exist', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  for (const [method, urlPath, body] of PROTECTED) {
    const r = await request(app, method, urlPath, { body });
    if (urlPath === '/health?x=1/../api/calls') {
      assert.equal(r.status, 200, 'a query string does not change which path was requested');
      continue;
    }
    assert.equal(r.status, 401, `${method} ${urlPath}`);
    assert.deepEqual(r.json, { success: false, error: 'unauthorized' }, `${method} ${urlPath}`);
  }
  assert.equal(app.dialAttempts.length, 0, 'an unauthenticated request must never reach the SIP layer');
});

test('A2. a wrong, empty or differently-sent key is a 401 (only the X-Claude-Api-Key header counts)', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const attempts = [
    { headers: withKey(KEY.slice(0, -1) + 'X') },
    { headers: withKey(KEY + 'x') },
    { headers: withKey('') },
    { headers: { Authorization: `Bearer ${KEY}` } },
    { headers: { 'X-Api-Key': KEY } },
    { headers: {}, urlSuffix: `?key=${KEY}` },
    { headers: {}, urlSuffix: `?api_key=${KEY}` }
  ];
  for (const a of attempts) {
    const r = await request(app, 'GET', `/api/calls${a.urlSuffix || ''}`, { headers: a.headers });
    assert.equal(r.status, 401, JSON.stringify(a.headers) + (a.urlSuffix ? ' (query)' : ''));
  }
  assert.equal(app.dialAttempts.length, 0);
});

test('A3. GET and HEAD /health stay public and answer without a key', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const get = await request(app, 'GET', '/health');
  assert.equal(get.status, 200);
  assert.equal(get.json.status, 'healthy');
  const head = await request(app, 'HEAD', '/health');
  assert.equal(head.status, 200);
  const post = await request(app, 'POST', '/health', { body: {} });
  assert.equal(post.status, 401, 'only reads of /health are public');
});

test('A4. the right key passes the gate and reaches the real handler', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const r = await request(app, 'GET', '/api/calls', { headers: withKey() });
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  const missing = await request(app, 'GET', '/api/call/no-such-call', { headers: withKey() });
  assert.equal(missing.status, 404, 'an authenticated caller gets the application answer, not a 401');
  assert.equal(missing.json.error, 'not_found');
});

test('A5. the gate runs before the body parser: unauthenticated garbage is a 401, not a 400 or 500', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const r = await request(app, 'POST', '/api/outbound-call', { body: '{"to": ' });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { success: false, error: 'unauthorized' });
});

test('A6. a denial is logged by method and path, and the credential never reaches the logs or the response', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const presented = 'presented-' + KEY;
  let r;
  const lines = await captureConsole(async () => {
    r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(presented), body: validCall(ALLOWED) });
  });
  assert.equal(r.status, 401);
  assert.ok(lines.some((l) => l.includes('/api/outbound-call') && l.includes('POST')), 'the denial must be visible in the log');
  for (const l of lines) {
    assert.ok(!l.includes(presented) && !l.includes(KEY), 'no credential in the log');
  }
  assert.ok(!r.text.includes(KEY) && !r.text.includes(presented), 'no credential in the response');
});

// ---------------------------------------------------------------------------------------------
// B. no usable key: locked, but alive
// ---------------------------------------------------------------------------------------------

test('B1. with no CLAUDE_API_KEY the API is locked: every route but /health is a 401, an empty header included', async () => {
  for (const env of [{}, { CLAUDE_API_KEY: '' }, { CLAUDE_API_KEY: 'short' }]) {
    const app = await startApp({ allowed: [ALLOWED], env });
    for (const headers of [{}, withKey(''), withKey('short'), withKey('anything')]) {
      const r = await request(app, 'POST', '/api/outbound-call', { headers, body: validCall(ALLOWED) });
      assert.equal(r.status, 401, `${JSON.stringify(env)} ${JSON.stringify(headers)}`);
    }
    const calls = await request(app, 'GET', '/api/calls', { headers: withKey('') });
    assert.equal(calls.status, 401);
    assert.equal(app.dialAttempts.length, 0, 'a locked API must not dial');
    const health = await request(app, 'GET', '/health');
    assert.equal(health.status, 200, 'the process still serves /health so a missing key is diagnosable, not a crash loop');
  }
});

test('B2. the lock is announced at startup so the operator sees why every call is a 401', async () => {
  let app;
  const lines = await captureConsole(async () => { app = await startApp({ allowed: [ALLOWED], env: {} }); });
  assert.ok(app);
  assert.ok(
    lines.some((l) => /CLAUDE_API_KEY/.test(l) && /(locked|LOCKED|denied|refus)/.test(l)),
    'expected a startup line naming CLAUDE_API_KEY and the locked state, got:\n' + lines.join('\n')
  );
});

// ---------------------------------------------------------------------------------------------
// C. destination allowlist
// ---------------------------------------------------------------------------------------------

test('C1. positive control: an allowlisted number with the key is accepted and DOES reach the SIP layer', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(ALLOWED) });
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.status, 'queued');
  await sleep(100);
  assert.equal(app.dialAttempts.length, 1, 'the spy must see exactly one dial attempt, or the denial tests below prove nothing');
});

test('C2. a number that is not on the list is a 403 and never reaches the SIP layer', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(OTHER) });
  assert.equal(r.status, 403);
  assert.equal(r.json.success, false);
  assert.equal(r.json.error, 'destination_not_allowed');
  assert.ok(!r.text.includes(ALLOWED), 'the refusal must not disclose what IS on the list');
  await sleep(100);
  assert.equal(app.dialAttempts.length, 0);
});

test('C3. near-misses of an allowlisted number are all refused: raw dial strings, prefixes, extensions, other lengths', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  for (const to of [
    '15555550100',    // same digits without "+": the dial path sends this string as-is
    '915555550100',   // 3CX outbound-rule prefix + number: PSTN toll-fraud shape
    '5555550100',
    '5755',           // an internal extension, not listed
    '+1555555010',
    '+155555501000',
    '+15555550102'
  ]) {
    const r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(to) });
    assert.equal(r.status, 403, to);
    assert.equal(r.json.error, 'destination_not_allowed', to);
  }
  await sleep(100);
  assert.equal(app.dialAttempts.length, 0);
});

test('C4. with no allowlist configured every call is refused, even a well-formed one (fail closed)', async () => {
  for (const env of [{ CLAUDE_API_KEY: KEY }, { CLAUDE_API_KEY: KEY, OUTBOUND_ALLOWED_TO: '' }, { CLAUDE_API_KEY: KEY, OUTBOUND_ALLOWED_TO: ' , ,' }]) {
    const app = await startApp({ env }); // allowed undefined: read OUTBOUND_ALLOWED_TO from env
    const r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(ALLOWED) });
    assert.equal(r.status, 403, JSON.stringify(env));
    assert.equal(r.json.error, 'destination_not_allowed');
    await sleep(50);
    assert.equal(app.dialAttempts.length, 0);
  }
});

test('C5. wildcards and junk in the list match nothing', async () => {
  const app = await startApp({ allowed: ['*', '+1555*', 'ALL', 'any', '', '+0000'], env: { CLAUDE_API_KEY: KEY } });
  for (const to of [ALLOWED, OTHER, '5755', '*']) {
    const r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(to) });
    assert.ok([400, 403].includes(r.status), `${to} -> ${r.status}`);
    assert.notEqual(r.status, 200, to);
  }
  await sleep(100);
  assert.equal(app.dialAttempts.length, 0);
});

test('C6. the list is read from OUTBOUND_ALLOWED_TO: whitespace tolerated, each listed number works, an unlisted one does not', async () => {
  const env = { CLAUDE_API_KEY: KEY, OUTBOUND_ALLOWED_TO: ` ${ALLOWED} , ${ALLOWED_2} ` };
  const app = await startApp({ env });
  for (const to of [ALLOWED, ALLOWED_2]) {
    const r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(to) });
    assert.equal(r.status, 200, to);
  }
  const denied = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(OTHER) });
  assert.equal(denied.status, 403);
  await sleep(100);
  assert.equal(app.dialAttempts.length, 2);
});

test('C7. authentication comes first: an unauthenticated request for an allowlisted number is a 401, not a dial', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const r = await request(app, 'POST', '/api/outbound-call', { body: validCall(ALLOWED) });
  assert.equal(r.status, 401);
  await sleep(100);
  assert.equal(app.dialAttempts.length, 0);
});

test('C8. validation still answers first for an authenticated caller: a malformed request is a 400, not a 403', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const noMessage = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: { to: ALLOWED } });
  assert.equal(noMessage.status, 400);
  const badTo = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall('not a number') });
  assert.equal(badTo.status, 400);
  assert.equal(badTo.json.error, 'validation_failed');
  assert.equal(app.dialAttempts.length, 0);
});

test('C9. a refused call is logged without the full number, and with no credential', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  let r;
  const lines = await captureConsole(async () => {
    r = await request(app, 'POST', '/api/outbound-call', { headers: withKey(), body: validCall(OTHER) });
  });
  assert.equal(r.status, 403);
  const refusal = lines.filter((l) => /refus|not allowed|allowlist/i.test(l));
  assert.ok(refusal.length >= 1, 'a refusal must leave a log line, got:\n' + lines.join('\n'));
  for (const l of refusal) {
    assert.ok(!l.includes(OTHER), 'the refusal line must not carry the full destination number');
    assert.ok(!l.includes(KEY));
  }
});

// ---------------------------------------------------------------------------------------------
// D. FreeSWITCH's loopback fetches
// ---------------------------------------------------------------------------------------------

test('D1. from the local host, GET of a generated audio file and of a static beep needs no key (FreeSWITCH cannot send one)', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const audio = await request(app, 'GET', '/audio-files/tts-1.wav');
  assert.equal(audio.status, 200);
  assert.equal(audio.text, 'RIFFfake-audio');
  const beep = await request(app, 'GET', '/static/ready-beep.wav');
  assert.equal(beep.status, 200);
  const headAudio = await request(app, 'HEAD', '/audio-files/tts-1.wav');
  assert.equal(headAudio.status, 200);
});

test('D2. the same fetch from a non-local peer is a 401 without the key, and works with it', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY }, isLocalRequest: () => false });
  const denied = await request(app, 'GET', '/audio-files/tts-1.wav');
  assert.equal(denied.status, 401);
  const deniedStatic = await request(app, 'GET', '/static/ready-beep.wav');
  assert.equal(deniedStatic.status, 401);
  const allowed = await request(app, 'GET', '/audio-files/tts-1.wav', { headers: withKey() });
  assert.equal(allowed.status, 200);
});

test('D3. the loopback exemption covers reads of one file name and nothing else', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: { CLAUDE_API_KEY: KEY } });
  const locked = [
    ['POST', '/audio'],                       // upload
    ['POST', '/audio-files/tts-1.wav'],       // write verb on the exempt prefix
    ['DELETE', '/audio-files/tts-1.wav'],
    ['GET', '/audio-files/'],                 // directory
    ['GET', '/audio-files/../health'],        // traversal spelling
    ['GET', '/audio-files/..%2fhealth'],
    ['GET', '/audio-files/%2e%2e/api/calls'],
    ['GET', '/audio-files/sub/tts-1.wav'],
    ['GET', '/Audio-Files/tts-1.wav'],
    ['GET', '/api/calls'],
    ['GET', '/api/devices'],
    ['GET', '/audio-files-evil/x.wav']
  ];
  for (const [method, urlPath] of locked) {
    const r = await request(app, method, urlPath, { body: method === 'POST' ? 'RIFFfake' : undefined });
    assert.equal(r.status, 401, `${method} ${urlPath}`);
  }
});

test('D4. a locked server (no key) still lets FreeSWITCH fetch its own audio, so a missing key cannot silence the phone', async () => {
  const app = await startApp({ allowed: [ALLOWED], env: {} });
  const audio = await request(app, 'GET', '/audio-files/tts-1.wav');
  assert.equal(audio.status, 200);
  const api = await request(app, 'GET', '/api/calls');
  assert.equal(api.status, 401);
});
