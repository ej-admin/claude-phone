/**
 * HOME-10759 / ADV-12713: hardening of the HOME-972 outbound-call proxy, per the desk's
 * "Option A-minimal" ruling on the two-voice read-only review of PR #1.
 *
 * What the review found, and which test group pins it:
 *   A. POST /outbound-call took ANY well-formed E.164 `to`, with no authentication, on
 *      0.0.0.0:3333 -- anyone on the LAN could make this host dial any number. It must
 *      accept only numbers on OUTBOUND_ALLOWED_TO (fail closed when unset), 403 + audit line.
 *   B. GET /outbound-calls and GET /outbound-call/:id forwarded the Pi's own status, so a
 *      Pi 404 made THIS server answer 404 -- indistinguishable from "this server has no such
 *      route", which is exactly the fault that took the phone-escalation monitors red. Every
 *      non-2xx from the Pi, and every network error, must be a 502.
 *   C. A 2xx whose body is null / not JSON / not an object threw a TypeError inside an
 *      async Express 4 handler (an unhandled rejection that can kill the process).
 *   D. An ambiguous POST outcome (the request left, the answer did not come back intact)
 *      was a retry-inviting 502, so a caller retried and the phone rang twice. Ambiguous
 *      outcomes are 504 "status unknown"; identical calls within the window are de-duplicated.
 *
 * server.js listens at module level (no export), so these tests spawn the real server as a
 * child process against a fake voice-app that records exactly what it receives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');

const ALLOWED = '+15551234567';
const ALLOWED_2 = '+15550001111';
const OTHER = '+15559876543'; // well-formed E.164, NOT on the allowlist

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake voice-app. `onPost` / `onGet` decide the answer; every POST that reaches it is
 * recorded in `received` BEFORE the handler runs, so "the call was placed" is observable
 * even when the handler then misbehaves.
 */
async function startFakeVoiceApp() {
  const fake = {
    received: [],
    getPaths: [],
    onPost: (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, callId: 'call-1', status: 'queued', message: 'Call initiated' }));
    },
    onGet: (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: [] }));
    }
  };
  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/outbound-call') {
        fake.received.push(JSON.parse(raw));
        fake.onPost(req, res);
      } else {
        fake.getPaths.push(req.url);
        fake.onGet(req, res);
      }
    });
  });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${fake.server.address().port}`;
  fake.reset = () => {
    fake.received.length = 0;
    fake.getPaths.length = 0;
  };
  return fake;
}

function reply(res, status, body, contentType = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Spawn the real proxy. `env` entries with value undefined are REMOVED from the child
 * environment, so a test can prove the fail-closed default by leaving OUTBOUND_ALLOWED_TO unset
 * even if the developer's shell exports it.
 */
async function startProxy(voiceAppUrl, env = {}) {
  const port = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home10759-proxy-'));
  const logPath = path.join(logDir, 'outbound-calls.jsonl');
  const childEnv = Object.assign({}, process.env, {
    PORT: String(port),
    VOICE_APP_URL: voiceAppUrl,
    OUTBOUND_LOG_PATH: logPath
  }, env);
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) delete childEnv[key];
  }
  const child = spawn(process.execPath, [SERVER], { env: childEnv, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const deadline = Date.now() + 10000;
  for (;;) {
    const up = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (up) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('proxy never started listening');
    }
    await sleep(50);
  }
  return {
    child,
    logPath,
    url: `http://127.0.0.1:${port}`,
    hasExited: () => exited,
    auditEntries: () => (fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [])
  };
}

async function post(proxy, body) {
  const res = await fetch(`${proxy.url}/outbound-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* body is checked by the test if it matters */ }
  return { status: res.status, body: json, text };
}

async function get(proxy, urlPath) {
  const res = await fetch(`${proxy.url}${urlPath}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, body: json, text };
}

let voiceApp;
let proxy; // default: ALLOWED + ALLOWED_2 on the list, dedupe OFF (groups A-C isolate one behaviour)
const extraProxies = [];

async function spawnProxy(env) {
  const p = await startProxy(voiceApp.url, env);
  extraProxies.push(p);
  return p;
}

const DEFAULT_PROXY_ENV = {
  OUTBOUND_ALLOWED_TO: ` ${ALLOWED} , ${ALLOWED_2} `,
  OUTBOUND_DEDUPE_WINDOW_MS: '0',
  OUTBOUND_PI_TIMEOUT_MS: '1500'
};

test.before(async () => {
  voiceApp = await startFakeVoiceApp();
  proxy = await startProxy(voiceApp.url, DEFAULT_PROXY_ENV);
});

test.after(async () => {
  proxy.child.kill();
  for (const p of extraProxies) p.child.kill();
  await new Promise((resolve) => voiceApp.server.close(resolve));
});

test.beforeEach(async () => {
  // A proxy that crashed in an earlier test must not turn every later test into ECONNREFUSED
  // noise: each test is judged on its own behaviour.
  if (proxy.hasExited()) {
    proxy = await startProxy(voiceApp.url, DEFAULT_PROXY_ENV);
  }
  voiceApp.reset();
  voiceApp.onPost = (req, res) => reply(res, 200, { success: true, callId: 'call-1', status: 'queued', message: 'Call initiated' });
  voiceApp.onGet = (req, res) => reply(res, 200, { success: true, data: [] });
});

// ── A. owner allowlist ───────────────────────────────────────────────────────

test('A1: a number on OUTBOUND_ALLOWED_TO is dialed', async () => {
  const res = await post(proxy, { to: ALLOWED, message: 'hello' });

  assert.equal(res.status, 200);
  assert.equal(voiceApp.received.length, 1, 'an allow-listed number must reach the voice-app');
});

test('A2: the allowlist is a comma list; surrounding whitespace is ignored, every entry is honoured', async () => {
  const res = await post(proxy, { to: ALLOWED_2, message: 'hello' });

  assert.equal(res.status, 200, 'the second entry of the list must be accepted');
  assert.equal(voiceApp.received.length, 1);
});

test('A3: a well-formed E.164 number NOT on the list is a 403, never reaches the voice-app, and leaves an audit line', async () => {
  const res = await post(proxy, { to: OTHER, message: 'pay up', triggeredBy: 'someone-on-the-lan' });

  assert.equal(res.status, 403, 'an arbitrary number must be refused');
  assert.equal(res.body.success, false);
  assert.equal(voiceApp.received.length, 0, 'no call may be placed to a number outside the allowlist');
  const refused = proxy.auditEntries().filter((e) => e.to === OTHER);
  assert.equal(refused.length, 1, 'the refusal must leave exactly one audit line');
  assert.equal(refused[0].blocked, 'to_not_in_allowlist');
  assert.equal(refused[0].triggered_by, 'someone-on-the-lan');
  assert.equal(refused[0].pi_status, null, 'the voice-app was never contacted');
});

test('A4: matching is exact: a prefix or an extension of an allowed number is refused', async () => {
  const prefix = await post(proxy, { to: '+1555123456', message: 'x' });
  const extended = await post(proxy, { to: `${ALLOWED}9`, message: 'x' });

  assert.equal(prefix.status, 403);
  assert.equal(extended.status, 403);
  assert.equal(voiceApp.received.length, 0);
});

test('A5: FAIL CLOSED: with OUTBOUND_ALLOWED_TO unset, every number is refused', async () => {
  const closed = await spawnProxy({ OUTBOUND_ALLOWED_TO: undefined, OUTBOUND_DEDUPE_WINDOW_MS: '0' });

  const res = await post(closed, { to: ALLOWED, message: 'hello' });

  assert.equal(res.status, 403, 'an unconfigured allowlist must not mean "allow everything"');
  assert.equal(voiceApp.received.length, 0);
});

test('A6: FAIL CLOSED: a blank OUTBOUND_ALLOWED_TO is the same as unset', async () => {
  const closed = await spawnProxy({ OUTBOUND_ALLOWED_TO: ' , ,', OUTBOUND_DEDUPE_WINDOW_MS: '0' });

  const res = await post(closed, { to: ALLOWED, message: 'hello' });

  assert.equal(res.status, 403);
  assert.equal(voiceApp.received.length, 0);
});

test('A7: a malformed number is still a 400 (the format check comes first)', async () => {
  const res = await post(proxy, { to: 'not-a-number', message: 'x' });

  assert.equal(res.status, 400);
  assert.equal(voiceApp.received.length, 0);
});

// ── B. GET proxies never relay a Pi non-2xx; they are 502 ───────────────────

test('B1: GET /outbound-calls: a Pi 404 is a 502, never a 404 from this server', async () => {
  voiceApp.onGet = (req, res) => reply(res, 404, { success: false, error: 'not_found' });

  const res = await get(proxy, '/outbound-calls');

  assert.equal(res.status, 502, 'a 404 here is indistinguishable from "this server has no /outbound-calls route"');
  assert.equal(res.body.success, false);
});

test('B2: GET /outbound-calls: a Pi 500 is a 502', async () => {
  voiceApp.onGet = (req, res) => reply(res, 500, { success: false, error: 'boom' });

  const res = await get(proxy, '/outbound-calls');

  assert.equal(res.status, 502);
});

test('B3: GET /outbound-calls: a Pi 200 is passed through unchanged', async () => {
  const payload = { success: true, data: [{ callId: 'c1', state: 'RINGING' }] };
  voiceApp.onGet = (req, res) => reply(res, 200, payload);

  const res = await get(proxy, '/outbound-calls');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, payload);
});

test('B4: GET /outbound-calls: a 2xx with a null / non-object body is a 502', async () => {
  voiceApp.onGet = (req, res) => reply(res, 200, 'null');
  const asNull = await get(proxy, '/outbound-calls');
  voiceApp.onGet = (req, res) => reply(res, 200, 'not json at all', 'text/plain');
  const asText = await get(proxy, '/outbound-calls');

  assert.equal(asNull.status, 502);
  assert.equal(asText.status, 502);
});

test('B5: GET /outbound-calls: voice-app unreachable is a 502', async () => {
  const deadPort = await freePort();
  const orphan = await startProxy(`http://127.0.0.1:${deadPort}`, { OUTBOUND_ALLOWED_TO: ALLOWED });
  extraProxies.push(orphan);

  const res = await get(orphan, '/outbound-calls');

  assert.equal(res.status, 502);
});

test('B6: GET /outbound-call/:id: a Pi 404 is a 502; a Pi 200 is passed through unchanged', async () => {
  voiceApp.onGet = (req, res) => reply(res, 404, { success: false, error: 'not_found' });
  const missing = await get(proxy, '/outbound-call/call-9');
  const record = { success: true, data: { callId: 'call-1', state: 'PLAYING', ack: { method: 'dtmf', digit: '1' } } };
  voiceApp.onGet = (req, res) => reply(res, 200, record);
  const found = await get(proxy, '/outbound-call/call-1');

  assert.equal(missing.status, 502);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, record);
});

// ── C. POST: an unintelligible voice-app answer must not crash the proxy ─────

test('C1: POST: a 2xx with a null body is a 504 "status unknown", and the process survives', async () => {
  voiceApp.onPost = (req, res) => reply(res, 200, 'null');

  const res = await post(proxy, { to: ALLOWED, message: 'hello' });

  assert.equal(res.status, 504, 'the call may have been queued; the caller must not be invited to retry');
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /status unknown/i);
  const health = await get(proxy, '/health');
  assert.equal(health.status, 200, 'a null body used to throw inside an async handler and take the process down');
  assert.equal(proxy.hasExited(), false);
});

test('C2: POST: a 2xx with a non-JSON body is a 504 "status unknown"', async () => {
  voiceApp.onPost = (req, res) => reply(res, 200, '<html>ok</html>', 'text/html');

  const res = await post(proxy, { to: ALLOWED, message: 'hello' });

  assert.equal(res.status, 504);
  assert.match(res.body.error, /status unknown/i);
});

test('C3: POST: a 2xx with a JSON primitive / array body is a 504 "status unknown"', async () => {
  voiceApp.onPost = (req, res) => reply(res, 200, '"queued"');
  const asString = await post(proxy, { to: ALLOWED, message: 'hello' });
  voiceApp.onPost = (req, res) => reply(res, 200, '[1,2]');
  const asArray = await post(proxy, { to: ALLOWED, message: 'hello' });

  assert.equal(asString.status, 504);
  assert.equal(asArray.status, 504);
});

test('C4: POST: ANY voice-app response whose body is not a JSON object is a 504 "status unknown" (a 5xx/4xx we cannot read does not prove no call was queued)', async () => {
  voiceApp.onPost = (req, res) => reply(res, 503, 'upstream unavailable', 'text/plain');
  const fiveHundred = await post(proxy, { to: ALLOWED, message: 'hello' });
  voiceApp.onPost = (req, res) => reply(res, 404, '<html>nope</html>', 'text/html');
  const fourHundred = await post(proxy, { to: ALLOWED, message: 'hello' });
  voiceApp.onPost = (req, res) => reply(res, 500, 'null');
  const nullBody = await post(proxy, { to: ALLOWED, message: 'hello' });

  for (const res of [fiveHundred, fourHundred, nullBody]) {
    assert.equal(res.status, 504, 'a 502 here is retry-inviting and the call may already be queued');
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /status unknown/i);
  }
});

test('C5: POST: voice-app unreachable (connection refused: nothing was sent) is a 502', async () => {
  const deadPort = await freePort();
  const orphan = await startProxy(`http://127.0.0.1:${deadPort}`, { OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '0' });
  extraProxies.push(orphan);

  const res = await post(orphan, { to: ALLOWED, message: 'hello' });

  assert.equal(res.status, 502, 'a request that never left is definitively not a call; retrying is safe');
});

test('C6: POST: the request reached the voice-app but the connection died before an answer is a 504 "status unknown"', async () => {
  voiceApp.onPost = (req) => req.socket.destroy();

  const res = await post(proxy, { to: ALLOWED, message: 'hello' });

  assert.equal(voiceApp.received.length, 1, 'precondition: the request really was delivered');
  assert.equal(res.status, 504, 'a 502 here invites a retry that rings the phone twice');
  assert.match(res.body.error, /status unknown/i);
});

test('C7: POST: the voice-app never answers (timeout after send) is a 504 "status unknown"', async () => {
  voiceApp.onPost = () => { /* hang */ };

  const res = await post(proxy, { to: ALLOWED, message: 'hello' });

  assert.equal(voiceApp.received.length, 1);
  assert.equal(res.status, 504);
  assert.match(res.body.error, /status unknown/i);
});

test('C8: POST: a voice-app 4xx with a JSON error is still passed through (existing behaviour)', async () => {
  voiceApp.onPost = (req, res) => reply(res, 400, { success: false, error: 'bad callerId' });

  const res = await post(proxy, { to: ALLOWED, message: 'hello' });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { success: false, error: 'bad callerId' });
});

// ── D. duplicate-call guard ──────────────────────────────────────────────────

test('D1: an identical call inside the window is NOT dialed again; it returns the first call result as 202', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '120000' });

  const first = await post(dedupe, { to: ALLOWED, message: 'Disk is full', mode: 'tts' });
  const second = await post(dedupe, { to: ALLOWED, message: 'Disk is full', mode: 'tts' });

  assert.equal(voiceApp.received.length, 1, 'the phone must ring once');
  assert.equal(first.status, 200);
  assert.equal(second.status, 202);
  assert.equal(second.body.success, true);
  assert.equal(second.body.callId, first.body.callId, 'the duplicate gets the FIRST call\'s id');
  assert.equal(second.body.deduplicated, true);
});

test('D2: tts and announce are the same mode for dedupe (the key uses the normalised mode)', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '120000' });

  await post(dedupe, { to: ALLOWED, message: 'same', mode: 'tts' });
  const second = await post(dedupe, { to: ALLOWED, message: 'same', mode: 'announce' });

  assert.equal(voiceApp.received.length, 1);
  assert.equal(second.status, 202);
});

test('D3: two identical calls in flight at the same moment dial once', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '120000' });
  voiceApp.onPost = (req, res) => setTimeout(
    () => reply(res, 200, { success: true, callId: 'call-slow', status: 'queued' }), 300);

  const [a, b] = await Promise.all([
    post(dedupe, { to: ALLOWED, message: 'race' }),
    post(dedupe, { to: ALLOWED, message: 'race' })
  ]);

  assert.equal(voiceApp.received.length, 1, 'the second request must wait for / reuse the first, not dial');
  assert.deepEqual([a.status, b.status].sort(), [200, 202]);
  assert.equal(a.body.callId, 'call-slow');
  assert.equal(b.body.callId, 'call-slow');
});

test('D4: a different message, a different number or a different mode is a different call', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: `${ALLOWED},${ALLOWED_2}`, OUTBOUND_DEDUPE_WINDOW_MS: '120000' });

  await post(dedupe, { to: ALLOWED, message: 'one' });
  await post(dedupe, { to: ALLOWED, message: 'two' });
  await post(dedupe, { to: ALLOWED_2, message: 'one' });
  await post(dedupe, { to: ALLOWED, message: 'one', mode: 'interactive' });

  assert.equal(voiceApp.received.length, 4);
});

test('D5: a definite failure is not remembered: the retry dials', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '120000' });
  voiceApp.onPost = (req, res) => reply(res, 400, { success: false, error: 'bad callerId' });
  const rejected = await post(dedupe, { to: ALLOWED, message: 'retry me' });
  voiceApp.onPost = (req, res) => reply(res, 200, { success: true, callId: 'call-2', status: 'queued' });

  const retried = await post(dedupe, { to: ALLOWED, message: 'retry me' });

  assert.equal(rejected.status, 400);
  assert.equal(retried.status, 200, 'the first attempt never became a call, so the retry must be allowed');
  assert.equal(voiceApp.received.length, 2);
});

test('D6: an AMBIGUOUS outcome is remembered: the immediate retry does not dial a second time', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '120000' });
  voiceApp.onPost = (req) => req.socket.destroy();

  const first = await post(dedupe, { to: ALLOWED, message: 'maybe rang' });
  voiceApp.onPost = (req, res) => reply(res, 200, { success: true, callId: 'call-3', status: 'queued' });
  const retry = await post(dedupe, { to: ALLOWED, message: 'maybe rang' });

  assert.equal(first.status, 504);
  assert.equal(retry.status, 504, 'the first call may be ringing right now; the retry must report "status unknown", not dial');
  assert.equal(voiceApp.received.length, 1);
});

test('D7: the window expires: after OUTBOUND_DEDUPE_WINDOW_MS the same call dials again', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '200' });

  await post(dedupe, { to: ALLOWED, message: 'later' });
  await sleep(350);
  const again = await post(dedupe, { to: ALLOWED, message: 'later' });

  assert.equal(again.status, 200);
  assert.equal(voiceApp.received.length, 2);
});

test('D8: OUTBOUND_DEDUPE_WINDOW_MS=0 disables the guard', async () => {
  await post(proxy, { to: ALLOWED, message: 'twice' });
  await post(proxy, { to: ALLOWED, message: 'twice' });

  assert.equal(voiceApp.received.length, 2);
});

test('D9: the default window is on: with OUTBOUND_DEDUPE_WINDOW_MS unset an identical call is still de-duplicated', async () => {
  const dflt = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: undefined });

  await post(dflt, { to: ALLOWED, message: 'default window' });
  const second = await post(dflt, { to: ALLOWED, message: 'default window' });

  assert.equal(voiceApp.received.length, 1);
  assert.equal(second.status, 202);
});

test('D10: an unreadable non-2xx answer is remembered like any ambiguous outcome: the immediate retry does not dial again', async () => {
  const dedupe = await spawnProxy({ OUTBOUND_ALLOWED_TO: ALLOWED, OUTBOUND_DEDUPE_WINDOW_MS: '120000' });
  voiceApp.onPost = (req, res) => reply(res, 503, 'upstream unavailable', 'text/plain');
  const first = await post(dedupe, { to: ALLOWED, message: 'maybe queued' });
  voiceApp.onPost = (req, res) => reply(res, 200, { success: true, callId: 'call-4', status: 'queued' });

  const retry = await post(dedupe, { to: ALLOWED, message: 'maybe queued' });

  assert.equal(first.status, 504);
  assert.equal(retry.status, 504);
  assert.equal(voiceApp.received.length, 1);
});

test('D11: a full table never evicts a live entry: the oldest call is still de-duplicated, and a NEW distinct call is refused (503, nothing sent)', async () => {
  const dedupe = await spawnProxy({
    OUTBOUND_ALLOWED_TO: ALLOWED,
    OUTBOUND_DEDUPE_WINDOW_MS: '120000',
    OUTBOUND_DEDUPE_MAX_ENTRIES: '3'
  });
  voiceApp.onPost = (req, res) => reply(res, 200, { success: true, callId: `call-${voiceApp.received.length}`, status: 'queued' });

  for (const m of ['m1', 'm2', 'm3']) {
    assert.equal((await post(dedupe, { to: ALLOWED, message: m })).status, 200);
  }
  const overflow = await post(dedupe, { to: ALLOWED, message: 'm4' });
  const oldestAgain = await post(dedupe, { to: ALLOWED, message: 'm1' });

  assert.equal(overflow.status, 503, 'a full table must refuse a new distinct call rather than forget an old one');
  assert.equal(overflow.body.success, false);
  assert.equal(oldestAgain.status, 202, 'm1 must still be de-duplicated: evicting it would let a retry ring the phone twice');
  assert.equal(voiceApp.received.length, 3, 'neither the overflow call nor the repeat of m1 may reach the voice-app');
});

test('D12: once entries expire the table frees up and a new call dials again', async () => {
  const dedupe = await spawnProxy({
    OUTBOUND_ALLOWED_TO: ALLOWED,
    OUTBOUND_DEDUPE_WINDOW_MS: '250',
    OUTBOUND_DEDUPE_MAX_ENTRIES: '1'
  });

  assert.equal((await post(dedupe, { to: ALLOWED, message: 'first' })).status, 200);
  assert.equal((await post(dedupe, { to: ALLOWED, message: 'second' })).status, 503);
  await sleep(400);
  const after = await post(dedupe, { to: ALLOWED, message: 'second' });

  assert.equal(after.status, 200, 'the cap is a bound on LIVE entries, not a permanent lock-out');
  assert.equal(voiceApp.received.length, 2);
});

test('D13: an IN-FLIGHT call is never pruned, even when it has been running longer than the window', async () => {
  const dedupe = await spawnProxy({
    OUTBOUND_ALLOWED_TO: ALLOWED,
    OUTBOUND_DEDUPE_WINDOW_MS: '200',
    OUTBOUND_PI_TIMEOUT_MS: '5000'
  });
  voiceApp.onPost = (req, res) => setTimeout(
    () => reply(res, 200, { success: true, callId: 'call-slow', status: 'queued' }), 900);

  const slow = post(dedupe, { to: ALLOWED, message: 'slow one' });
  await sleep(450); // older than the 200ms window, but still in flight
  const duplicate = await post(dedupe, { to: ALLOWED, message: 'slow one' });
  const original = await slow;

  assert.equal(voiceApp.received.length, 1, 'the duplicate arrived mid-flight and must wait for the original, not dial');
  assert.equal(original.status, 200);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.callId, 'call-slow');
});
