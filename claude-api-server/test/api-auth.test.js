/**
 * GEN-10898 (security triage 22893): end-to-end pins for the claude-api-server hardening.
 *
 * What the triage found: server.js listened on 0.0.0.0:3333 with NO authentication, and POST /ask
 * spawns `claude --dangerously-skip-permissions` -- any LAN device that reached the port could run
 * code as the service user. Four requirements, one test group each:
 *
 *   A. Every route except GET /health requires the X-Claude-Api-Key header (constant-time compare, 401).
 *   B. The key comes from CLAUDE_API_KEY; a server without a usable key REFUSES TO START (no open fallback).
 *   C. /ask and /ask-structured are disabled unless CLAUDE_API_ASK_ENABLED is an explicit yes.
 *   D. The server binds the addresses in CLAUDE_API_LISTEN (default loopback + tailnet), never 0.0.0.0
 *      unless the operator writes it down.
 *
 * server.js listens at module level (no export), so these tests spawn the real server as a child process.
 * A fake `claude` executable is placed first on the PATH the server builds from HOME, so "the CLI was
 * run" / "the CLI was NOT run" is observable and no test can ever start a real Claude session.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const HEADER = 'X-Claude-Api-Key';
// Built at runtime: a token-shaped literal in a test file trips the credential scanner.
const KEY = 'test-' + crypto.randomBytes(24).toString('hex');
const ALLOWED = '+15551234567';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(25);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/** Resolves true when a TCP connection to host:port succeeds. */
function tcpOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** True when this machine can bind the given local address (127.0.0.2 is loopback on Linux, not on every OS). */
function canBind(host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

function machineOwns(address) {
  return Object.values(os.networkInterfaces()).flat().some((i) => i && i.address === address);
}

// ── fake voice-app: records every request that reaches it ───────────────────

let voiceApp;

async function startFakeVoiceApp() {
  const fake = { requests: [] };
  fake.server = http.createServer((req, res) => {
    req.resume(); // the body is not needed; drain it so the connection can complete
    req.on('end', () => {
      fake.requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        res.end(JSON.stringify({ success: true, callId: 'call-1', status: 'queued', message: 'Call initiated' }));
      } else {
        res.end(JSON.stringify({ success: true, data: [] }));
      }
    });
  });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${fake.server.address().port}`;
  return fake;
}

// ── fake `claude` CLI + isolated HOME ───────────────────────────────────────

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gen10898-home-'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    '# Fake Claude CLI: records every invocation so a test can prove the CLI was (or was NOT) run.',
    '# Exactly ONE marker line per run: the real prompt is multi-line, so logging "$@" would not count runs.',
    'echo INVOKED >> "$HOME/invocations.log"',
    'env > "$HOME/last-env.txt"',
    'echo \'{"type":"result","result":"fake-claude-answer","session_id":"sess-1"}\'',
    '',
  ].join('\n'), { mode: 0o755 });
  const read = (name) => (fs.existsSync(path.join(home, name)) ? fs.readFileSync(path.join(home, name), 'utf8') : '');
  return {
    home,
    invocations: () => read('invocations.log').split('\n').filter(Boolean),
    lastEnv: () => read('last-env.txt'),
  };
}

// ── server lifecycle ────────────────────────────────────────────────────────

const spawned = [];

/**
 * Spawn the real server from a CLEAN environment (never the developer's shell: a CLAUDE_API_LISTEN or
 * CLAUDE_API_KEY exported on the box must not change what a test proves). `env` entries with value
 * undefined are removed, so a test can leave a variable genuinely unset.
 */
async function startServer(env = {}) {
  const port = await freePort();
  const fakeHome = makeHome();
  const childEnv = Object.assign({
    PATH: process.env.PATH,
    HOME: fakeHome.home,
    NODE_ENV: 'test',
    PORT: String(port),
    CLAUDE_API_KEY: KEY,
    VOICE_APP_URL: voiceApp.url,
    OUTBOUND_LOG_PATH: path.join(fakeHome.home, 'outbound-calls.jsonl'),
    OUTBOUND_ALLOWED_TO: ALLOWED,
    OUTBOUND_DEDUPE_WINDOW_MS: '0',
  }, env);
  for (const name of Object.keys(childEnv)) {
    if (childEnv[name] === undefined) delete childEnv[name];
  }

  const child = spawn(process.execPath, [SERVER], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });

  const srv = {
    child,
    port,
    url: `http://127.0.0.1:${port}`,
    fakeHome,
    output: () => output,
    exited: () => exit,
  };
  spawned.push(srv);
  return srv;
}

async function startListening(env) {
  const srv = await startServer(env);
  await waitFor(
    async () => srv.exited() || (await tcpOpen('127.0.0.1', srv.port)),
    10000,
    'the server to accept connections'
  );
  if (srv.exited()) {
    throw new Error(`server exited during startup (${JSON.stringify(srv.exited())}):\n${srv.output()}`);
  }
  return srv;
}

/** For tests that expect the server to REFUSE to start: it must exit, and it must never have listened. */
async function startExpectingExit(env) {
  const srv = await startServer(env);
  await waitFor(() => srv.exited() !== null, 4000, 'the server to exit (it should refuse to start)');
  return srv;
}

test.before(async () => {
  voiceApp = await startFakeVoiceApp();
});

test.after(async () => {
  for (const srv of spawned) {
    srv.child.kill();
    fs.rmSync(srv.fakeHome.home, { recursive: true, force: true });
  }
  await new Promise((resolve) => voiceApp.server.close(resolve));
});

async function call(srv, method, urlPath, { key = KEY, headers = {}, body, raw } = {}) {
  const sent = Object.assign({}, headers);
  if (key !== null && key !== undefined) sent[HEADER] = key;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    sent['Content-Type'] = sent['Content-Type'] || 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    sent['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${srv.url}${urlPath}`, { method, headers: sent, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON; the test checks text if it matters */ }
  return { status: res.status, text, json };
}

// ── A. authentication on every route ────────────────────────────────────────

let main; // default server: key set, ask disabled, default listen

test('A0: setup - the default server starts with a key configured', async () => {
  main = await startListening();
  assert.equal(main.exited(), null, 'the server must be running');
});

const PROTECTED_ROUTES = [
  ['POST', '/ask', { prompt: 'hello' }],
  ['POST', '/ask-structured', { prompt: 'hello' }],
  ['POST', '/end-session', { callId: 'c-1' }],
  ['POST', '/outbound-call', { to: ALLOWED, message: 'hello' }],
  ['GET', '/outbound-call/call-1'],
  ['GET', '/outbound-calls'],
  ['GET', '/'],
  // Probes seen in the 7-day journal, and routes that do not exist: an unauthenticated caller learns nothing.
  ['GET', '/legacy/review-desk'],
  ['GET', '/calls'],
  ['GET', '/does-not-exist'],
  ['POST', '/does-not-exist', {}],
  ['DELETE', '/ask'],
  ['PUT', '/outbound-call', {}],
  // Near-misses of the one public route.
  ['POST', '/health', {}],
  ['GET', '/health/'],
  ['GET', '/health/extra'],
  ['GET', '/HEALTH'],
];

for (const [method, route, body] of PROTECTED_ROUTES) {
  test(`A1: ${method} ${route} without the key is a 401 and the handler behind it never runs`, async () => {
    const claudeBefore = main.fakeHome.invocations().length;
    const voiceAppBefore = voiceApp.requests.length;

    const res = await call(main, method, route, { key: null, body });

    assert.equal(res.status, 401, `${method} ${route} must be refused without ${HEADER}`);
    assert.equal(res.json && res.json.success, false, 'the refusal is a JSON error, not a page');
    assert.equal(main.fakeHome.invocations().length, claudeBefore, 'the Claude CLI must not be spawned for an unauthenticated request');
    assert.equal(voiceApp.requests.length, voiceAppBefore, 'nothing may be forwarded to the voice-app for an unauthenticated request');
  });
}

test('A2: wrong credentials are all refused - empty, truncated, extended, wrong case, wrong header, query string', async () => {
  const swapped = KEY.slice(0, -1) + (KEY.endsWith('0') ? '1' : '0');
  const attempts = [
    ['empty header value', { key: '' }],
    ['one character wrong', { key: swapped }],
    ['truncated by one', { key: KEY.slice(0, -1) }],
    ['extended by one', { key: KEY + 'x' }],
    ['upper-cased', { key: KEY.toUpperCase() }],
    ['correct key in Authorization: Bearer', { key: null, headers: { Authorization: `Bearer ${KEY}` } }],
    ['correct key in a different header', { key: null, headers: { 'X-Api-Key': KEY } }],
  ];
  for (const [label, options] of attempts) {
    const res = await call(main, 'GET', '/outbound-calls', options);
    assert.equal(res.status, 401, `"${label}" must not authenticate`);
  }
  const inQuery = await call(main, 'GET', `/outbound-calls?api_key=${KEY}&key=${KEY}`, { key: null });
  assert.equal(inQuery.status, 401, 'the key must only be accepted in the header (a URL ends up in logs)');
});

test('A3: the correct key reaches the handler - authenticated routes work, and the header name is case-insensitive', async () => {
  const before = voiceApp.requests.length;

  const list = await call(main, 'GET', '/outbound-calls');
  const info = await call(main, 'GET', '/');
  const lower = await call(main, 'GET', '/outbound-calls', { key: null, headers: { 'x-claude-api-key': KEY } });

  assert.equal(list.status, 200, 'an authenticated GET /outbound-calls must still be proxied');
  assert.equal(info.status, 200);
  assert.equal(lower.status, 200, 'HTTP header names are case-insensitive');
  assert.equal(voiceApp.requests.length - before, 2, 'the two authenticated proxy calls reached the voice-app');
});

test('A4: GET /health is public and unchanged; a wrong key does not break it; HEAD works', async () => {
  const bare = await call(main, 'GET', '/health', { key: null });
  const wrong = await call(main, 'GET', '/health', { key: 'wrong' });
  const head = await call(main, 'HEAD', '/health', { key: null });

  assert.equal(bare.status, 200, 'the health probe must keep working without a key');
  assert.equal(bare.json.status, 'ok');
  assert.equal(bare.json.service, 'claude-api-server');
  assert.equal(wrong.status, 200, 'a bad header on the public route must not turn it into a 401');
  assert.equal(head.status, 200);
  assert.ok(!bare.text.includes(KEY), 'the health body must never contain the key');
});

test('A5: authentication runs BEFORE body parsing - a malformed body without the key is a 401, not a parser error', async () => {
  const res = await call(main, 'POST', '/outbound-call', { key: null, raw: '{this is not json' });

  assert.equal(res.status, 401, 'an unauthenticated caller must not even reach the JSON parser (no stack trace, no parser surface)');
});

test('A6: a denied request is logged with method and path, and neither the presented key nor the real key is ever logged', async () => {
  const presented = 'presented-' + crypto.randomBytes(16).toString('hex');

  await call(main, 'GET', '/legacy/review-desk', { key: presented });
  await waitFor(() => /AUTH DENIED/.test(main.output()), 3000, 'the denial to be logged');

  const out = main.output();
  assert.match(out, /AUTH DENIED[^\n]*GET[^\n]*\/legacy\/review-desk/, 'the log line names the method and path so a probe can be traced');
  assert.ok(!out.includes(presented), 'a presented credential must never be written to the log');
  assert.ok(!out.includes(KEY), 'the real key must never be written to the log');
});

// ── B. the key is mandatory ─────────────────────────────────────────────────

test('B1: no CLAUDE_API_KEY - the server refuses to start, never listens, and says which variable to set', async () => {
  const srv = await startExpectingExit({ CLAUDE_API_KEY: undefined });

  assert.notEqual(srv.exited().code, 0, 'a server that cannot enforce authentication must exit non-zero');
  assert.equal(await tcpOpen('127.0.0.1', srv.port), false, 'there must be NO unauthenticated fallback listener');
  assert.match(srv.output(), /CLAUDE_API_KEY/, 'the operator must be told what to set');
});

test('B2: a blank or whitespace-only key is refused the same way', async () => {
  for (const blank of ['', '   \n']) {
    const srv = await startExpectingExit({ CLAUDE_API_KEY: blank });

    assert.notEqual(srv.exited().code, 0, `key ${JSON.stringify(blank)} must not start the server`);
    assert.equal(await tcpOpen('127.0.0.1', srv.port), false);
  }
});

test('B3: a key shorter than 32 characters is refused', async () => {
  const srv = await startExpectingExit({ CLAUDE_API_KEY: 'k'.repeat(31) });

  assert.notEqual(srv.exited().code, 0, 'a guessable key is no key');
  assert.equal(await tcpOpen('127.0.0.1', srv.port), false);
});

test('B4: a key of exactly 32 characters starts the server', async () => {
  const key32 = 'k'.repeat(32);
  const srv = await startListening({ CLAUDE_API_KEY: key32 });

  const res = await call(srv, 'GET', '/outbound-calls', { key: key32 });

  assert.equal(res.status, 200);
});

test('B5: whitespace around the key in the environment is trimmed (a trailing newline from an env file must not lock everyone out)', async () => {
  const srv = await startListening({ CLAUDE_API_KEY: `  ${KEY}\n` });

  const res = await call(srv, 'GET', '/outbound-calls', { key: KEY });

  assert.equal(res.status, 200, 'the trimmed key is what clients send');
});

test('B6: startup output never contains the key value, but does state that authentication is required', async () => {
  const srv = await startListening();

  assert.ok(!srv.output().includes(KEY), 'the key must never be written to the startup log');
  assert.match(srv.output(), /auth/i, 'the startup log states the authentication posture so an operator can see it');
});

// ── C. /ask is opt-in ───────────────────────────────────────────────────────

test('C1: by default an AUTHENTICATED POST /ask is a 403 and the Claude CLI is never spawned', async () => {
  const srv = await startListening();

  const res = await call(srv, 'POST', '/ask', { body: { prompt: 'what is on disk' } });

  assert.equal(res.status, 403, 'a valid key alone must not unlock the CLI-spawning endpoint');
  assert.equal(res.json.success, false);
  assert.deepEqual(srv.fakeHome.invocations(), [], '`claude --dangerously-skip-permissions` must not run while /ask is disabled');
});

test('C2: by default an authenticated POST /ask-structured is a 403 and the CLI is never spawned', async () => {
  const srv = await startListening();

  const res = await call(srv, 'POST', '/ask-structured', { body: { prompt: 'x', schema: {} } });

  assert.equal(res.status, 403);
  assert.deepEqual(srv.fakeHome.invocations(), []);
});

test('C3: every value other than an explicit yes keeps /ask disabled (a typo fails closed)', async () => {
  for (const value of ['0', 'false', 'no', 'off', '', 'enabled', 'tru', '2']) {
    const srv = await startListening({ CLAUDE_API_ASK_ENABLED: value });

    const res = await call(srv, 'POST', '/ask', { body: { prompt: 'x' } });

    assert.equal(res.status, 403, `CLAUDE_API_ASK_ENABLED=${JSON.stringify(value)} must NOT enable /ask`);
    assert.deepEqual(srv.fakeHome.invocations(), [], `no CLI run for ${JSON.stringify(value)}`);
  }
});

test('C4: CLAUDE_API_ASK_ENABLED=1 plus the key enables /ask - the CLI runs once and its answer is returned', async () => {
  const srv = await startListening({ CLAUDE_API_ASK_ENABLED: '1' });

  const res = await call(srv, 'POST', '/ask', { body: { prompt: 'hello', callId: 'call-ask-1' } });

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.response, 'fake-claude-answer');
  assert.equal(srv.fakeHome.invocations().length, 1, 'the CLI is spawned exactly once for one enabled request');
});

test('C5: CLAUDE_API_ASK_ENABLED=1 enables /ask-structured too', async () => {
  const srv = await startListening({ CLAUDE_API_ASK_ENABLED: '1' });

  const res = await call(srv, 'POST', '/ask-structured', { body: { prompt: 'x', schema: {}, maxRetries: 0 } });

  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403, 'an enabled server must let an authenticated caller reach the structured endpoint');
  assert.equal(srv.fakeHome.invocations().length, 1, 'the CLI was reached');
});

test('C6: enabled is not open - without the key /ask is still a 401 and the CLI is never spawned', async () => {
  const srv = await startListening({ CLAUDE_API_ASK_ENABLED: '1' });

  const res = await call(srv, 'POST', '/ask', { key: null, body: { prompt: 'run something' } });

  assert.equal(res.status, 401);
  assert.deepEqual(srv.fakeHome.invocations(), [], 'enabling /ask must never weaken authentication');
});

test('C7: /end-session needs the key but is NOT gated by the ask switch (the voice-app calls it when a call ends)', async () => {
  const srv = await startListening();

  const withKey = await call(srv, 'POST', '/end-session', { body: { callId: 'c-9' } });
  const without = await call(srv, 'POST', '/end-session', { key: null, body: { callId: 'c-9' } });

  assert.equal(withKey.status, 200);
  assert.equal(without.status, 401);
});

test('C8: the shared secret is NOT passed to the Claude CLI child (a model with shell access must not be able to read it)', async () => {
  const srv = await startListening({ CLAUDE_API_ASK_ENABLED: '1' });

  await call(srv, 'POST', '/ask', { body: { prompt: 'hello' } });

  const childEnv = srv.fakeHome.lastEnv();
  assert.notEqual(childEnv, '', 'the fake CLI recorded its environment');
  assert.ok(!/^CLAUDE_API_KEY=/m.test(childEnv), 'CLAUDE_API_KEY must be scrubbed from the child environment');
  assert.ok(!childEnv.includes(KEY), 'the key value must not appear anywhere in the child environment');
});

// ── D. listen addresses ─────────────────────────────────────────────────────

test('D1: by default the server binds loopback only - not the wildcard (127.0.0.2 is refused)', async (t) => {
  if (!(await canBind('127.0.0.2'))) return t.skip('127.0.0.2 is not a loopback alias on this OS');
  const srv = await startListening();

  assert.equal(await tcpOpen('127.0.0.1', srv.port), true, 'loopback must work: ralph-supervisor and the watchdog use it');
  assert.equal(await tcpOpen('127.0.0.2', srv.port), false, 'a wildcard bind would accept 127.0.0.2; the default must not');
});

test('D2: CLAUDE_API_LISTEN binds exactly the listed addresses', async (t) => {
  if (!(await canBind('127.0.0.2')) || !(await canBind('127.0.0.3'))) return t.skip('loopback aliases unavailable');
  const srv = await startListening({ CLAUDE_API_LISTEN: '127.0.0.1, 127.0.0.2' });

  assert.equal(await tcpOpen('127.0.0.1', srv.port), true);
  assert.equal(await tcpOpen('127.0.0.2', srv.port), true, 'the second listed address must be served');
  assert.equal(await tcpOpen('127.0.0.3', srv.port), false, 'an address that is not listed must not be served');
});

test('D3: an explicit 0.0.0.0 is honoured but announced with a WARNING (the operator chose it, loudly)', async (t) => {
  if (!(await canBind('127.0.0.2'))) return t.skip('127.0.0.2 is not a loopback alias on this OS');
  const srv = await startListening({ CLAUDE_API_LISTEN: '0.0.0.0' });

  assert.equal(await tcpOpen('127.0.0.2', srv.port), true, 'a wildcard bind answers on every local address');
  assert.match(srv.output(), /WARNING[^\n]*wildcard/i, 'a wildcard bind must be flagged in the startup log');
});

test('D4: an invalid CLAUDE_API_LISTEN entry stops the server - and the valid sibling is NOT left listening', async () => {
  const srv = await startExpectingExit({ CLAUDE_API_LISTEN: '127.0.0.1,not-an-ip' });

  assert.notEqual(srv.exited().code, 0);
  assert.equal(await tcpOpen('127.0.0.1', srv.port), false, 'all-or-nothing: no half-configured listener');
  assert.match(srv.output(), /CLAUDE_API_LISTEN/);
});

test('D5: an address this host cannot bind stops the server and tears down the listeners it already opened', async (t) => {
  if (machineOwns('192.0.2.1')) return t.skip('this host actually owns the TEST-NET address');
  const srv = await startExpectingExit({ CLAUDE_API_LISTEN: '127.0.0.1,192.0.2.1' });

  assert.notEqual(srv.exited().code, 0, 'a service that cannot bind an address it was told to serve must say so, not run half-deaf');
  assert.equal(await tcpOpen('127.0.0.1', srv.port), false, 'the loopback listener must not outlive the failed startup');
});

test('D6: the startup log states the address:port pairs actually bound', async () => {
  const srv = await startListening();

  assert.match(srv.output(), new RegExp(`127\\.0\\.0\\.1:${srv.port}`), 'an operator must be able to read the bind from the log');
});
