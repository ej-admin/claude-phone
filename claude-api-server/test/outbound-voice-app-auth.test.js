/**
 * HOME-11645: the voice-app on the Pi now requires X-Claude-Api-Key on every route but GET/HEAD /health.
 * claude-api-server is its production caller (POST /outbound-call dials through it, and the GET proxies
 * list and look up calls), so it must authenticate to the voice-app or the phone-escalation path breaks
 * the moment the Pi starts enforcing.
 *
 * The key is the SAME shared CLAUDE_API_KEY this server already requires of its own callers: one secret
 * per fleet, placed once, and the Pi holds it already as the client of claude-api-server (GEN-10898).
 *
 * Rollout contract (why this is tested as "always sent" and not as "sent when the Pi asks"): a request
 * header is harmless to a voice-app that does not look at it, so this side ships FIRST, then the Pi is
 * switched to enforce. The reverse order would be an outage.
 *
 * server.js listens at module level, so these tests spawn the real server against a fake voice-app that
 * records the headers it receives.
 *
 * Run with: node --test test/outbound-voice-app-auth.test.js
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
// Built at runtime: a token-shaped literal in a test file trips the credential scanner.
const API_KEY = 'proxy-voice-' + crypto.randomBytes(24).toString('hex');
const ALLOWED = '+15555550100';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** A fake voice-app that answers success and records method, url and the key header of every request. */
async function startFakeVoiceApp() {
  const fake = { requests: [] };
  fake.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      fake.requests.push({ method: req.method, url: req.url, key: req.headers['x-claude-api-key'], body: raw });
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

async function startProxy(voiceAppUrl) {
  const port = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home11645-proxy-'));
  const childEnv = Object.assign({}, process.env, {
    PORT: String(port),
    CLAUDE_API_KEY: API_KEY,
    VOICE_APP_URL: voiceAppUrl,
    OUTBOUND_LOG_PATH: path.join(logDir, 'outbound-calls.jsonl'),
    OUTBOUND_ALLOWED_TO: ALLOWED,
    OUTBOUND_DEDUPE_WINDOW_MS: '0',
    OUTBOUND_PI_TIMEOUT_MS: '3000'
  });
  const child = spawn(process.execPath, [SERVER], { env: childEnv, stdio: 'ignore' });
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
  return { child, url: `http://127.0.0.1:${port}` };
}

let voiceApp;
let proxy;

test.before(async () => {
  voiceApp = await startFakeVoiceApp();
  proxy = await startProxy(voiceApp.url);
});

test.after(async () => {
  proxy.child.kill();
  await new Promise((resolve) => voiceApp.server.close(resolve));
});

test.beforeEach(() => {
  voiceApp.requests.length = 0;
});

async function callProxy(method, urlPath, body) {
  const res = await fetch(`${proxy.url}${urlPath}`, {
    method,
    headers: Object.assign({ 'X-Claude-Api-Key': API_KEY }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  await res.text();
  return res.status;
}

test('POST /outbound-call authenticates to the voice-app with the shared key', async () => {
  const status = await callProxy('POST', '/outbound-call', { to: ALLOWED, message: 'hello', mode: 'announce' });
  assert.equal(status, 200);
  const posts = voiceApp.requests.filter((r) => r.method === 'POST' && r.url === '/api/outbound-call');
  assert.equal(posts.length, 1, 'the call must reach the voice-app exactly once');
  assert.equal(posts[0].key, API_KEY);
});

test('GET /outbound-calls authenticates to the voice-app with the shared key', async () => {
  const status = await callProxy('GET', '/outbound-calls');
  assert.equal(status, 200);
  const gets = voiceApp.requests.filter((r) => r.method === 'GET' && r.url === '/api/calls');
  assert.equal(gets.length, 1);
  assert.equal(gets[0].key, API_KEY);
});

test('GET /outbound-call/:callId authenticates to the voice-app with the shared key', async () => {
  const status = await callProxy('GET', '/outbound-call/abc-123');
  assert.equal(status, 200);
  const gets = voiceApp.requests.filter((r) => r.method === 'GET' && r.url.startsWith('/api/call/'));
  assert.equal(gets.length, 1);
  assert.equal(gets[0].key, API_KEY);
});

test('every request this server makes to the voice-app carries the key (no unauthenticated hop)', async () => {
  await callProxy('POST', '/outbound-call', { to: ALLOWED, message: 'hello again', mode: 'announce' });
  await callProxy('GET', '/outbound-calls');
  await callProxy('GET', '/outbound-call/xyz');
  assert.ok(voiceApp.requests.length >= 3);
  for (const r of voiceApp.requests) {
    assert.equal(r.key, API_KEY, `${r.method} ${r.url}`);
  }
});

test('the key is never put in the request body or URL sent to the voice-app', async () => {
  await callProxy('POST', '/outbound-call', { to: ALLOWED, message: 'body check', mode: 'announce' });
  await callProxy('GET', '/outbound-calls');
  for (const r of voiceApp.requests) {
    assert.ok(!r.url.includes(API_KEY), 'key in URL');
    assert.ok(!r.body.includes(API_KEY), 'key in body');
  }
});

// ---------------------------------------------------------------------------------------------
// A header must not follow a redirect
// ---------------------------------------------------------------------------------------------

test('a voice-app that answers with a redirect does not receive the key a second time at the redirect target', async () => {
  // "other" stands in for any host the voice-app could bounce us to. It records everything it receives.
  const other = { requests: [] };
  other.server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      other.requests.push({ method: req.method, url: req.url, key: req.headers['x-claude-api-key'] });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: [] }));
    });
  });
  await new Promise((resolve) => other.server.listen(0, '127.0.0.1', resolve));
  const otherUrl = `http://127.0.0.1:${other.server.address().port}`;

  const redirector = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // 307 keeps the method and the headers on a follow, which is the dangerous case for a POST.
      res.statusCode = 307;
      res.setHeader('Location', `${otherUrl}${req.url}`);
      res.end();
    });
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const redirectingProxy = await startProxy(`http://127.0.0.1:${redirector.address().port}`);

  try {
    const get = await fetch(`${redirectingProxy.url}/outbound-calls`, { headers: { 'X-Claude-Api-Key': API_KEY } });
    await get.text();
    assert.equal(get.status, 502, 'a redirect from the voice-app is a failed proxy call, not something to follow');

    const post = await fetch(`${redirectingProxy.url}/outbound-call`, {
      method: 'POST',
      headers: { 'X-Claude-Api-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: ALLOWED, message: 'redirect check', mode: 'announce' })
    });
    await post.text();
    assert.ok([502, 504].includes(post.status), `unexpected status ${post.status}`);

    await sleep(100);
    assert.deepEqual(other.requests, [], 'nothing may be sent to the redirect target, so the key cannot leak there');
  } finally {
    redirectingProxy.child.kill();
    await new Promise((resolve) => redirector.close(resolve));
    await new Promise((resolve) => other.server.close(resolve));
  }
});
