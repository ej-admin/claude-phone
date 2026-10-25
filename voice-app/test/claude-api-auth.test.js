/**
 * GEN-10898 (security triage 22893): the voice-app is a caller of claude-api-server, which now requires
 * the X-Claude-Api-Key header on every route except GET /health. These tests drive the REAL claude-bridge
 * and the REAL /query route against a fake API server that records exactly which headers reach it.
 *
 * Rollout contract (why "no key configured" is tested as "no header", not as an error): the callers are
 * deployed BEFORE the server starts enforcing, and an extra header is harmless to the old server. A caller
 * that refused to send without a key would break the phone path during that window.
 *
 * Run with: node --test test/claude-api-auth.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const LIB = path.join(__dirname, '..', 'lib');
// Built at runtime: a token-shaped literal in a test file trips the credential scanner.
const KEY = 'voice-test-' + crypto.randomBytes(24).toString('hex');

/** A fake claude-api-server: records method, url and the key header of every request, answers success. */
async function startFakeClaudeApi() {
  const fake = { requests: [] };
  fake.server = http.createServer((req, res) => {
    req.resume(); // the body is not needed; drain it so the connection can complete
    req.on('end', () => {
      fake.requests.push({ method: req.method, url: req.url, key: req.headers['x-claude-api-key'] });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/ask-structured') {
        res.end(JSON.stringify({ success: true, data: { a: 1 }, raw_response: '{"a":1}' }));
      } else if (req.url === '/ask') {
        res.end(JSON.stringify({ success: true, response: 'ok', sessionId: 'sess-1', duration_ms: 1 }));
      } else {
        res.end(JSON.stringify({ success: true }));
      }
    });
  });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${fake.server.address().port}`;
  return fake;
}

/**
 * claude-bridge and query-routes read CLAUDE_API_URL when they are first loaded, so each test sets the
 * environment, drops the module from the require cache and loads a fresh copy.
 */
function loadFresh(moduleName, env) {
  const saved = {};
  for (const name of Object.keys(env)) {
    saved[name] = process.env[name];
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  const resolved = path.join(LIB, moduleName);
  delete require.cache[require.resolve(resolved)];
  const loaded = require(resolved);
  return {
    loaded,
    restore() {
      for (const name of Object.keys(saved)) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    },
  };
}

test('claude-api-auth.authHeaders: the key is sent as X-Claude-Api-Key, trimmed; unset or blank sends nothing', () => {
  const { authHeaders, API_KEY_HEADER } = require(path.join(LIB, 'claude-api-auth'));

  assert.equal(API_KEY_HEADER, 'X-Claude-Api-Key');
  assert.deepEqual(authHeaders({ CLAUDE_API_KEY: KEY }), { 'X-Claude-Api-Key': KEY });
  assert.deepEqual(authHeaders({ CLAUDE_API_KEY: `  ${KEY}\n` }), { 'X-Claude-Api-Key': KEY }, 'an env file newline must not change the key');
  assert.deepEqual(authHeaders({}), {}, 'no key configured: no header (rollout-safe against a server that does not enforce yet)');
  assert.deepEqual(authHeaders({ CLAUDE_API_KEY: '   ' }), {});
});

test('claude-bridge.query sends the key on POST /ask', async () => {
  const fake = await startFakeClaudeApi();
  const { loaded: bridge, restore } = loadFresh('claude-bridge', { CLAUDE_API_URL: fake.url, CLAUDE_API_KEY: KEY });
  try {
    await bridge.query('hello', { callId: 'call-1' });

    const ask = fake.requests.find((r) => r.url === '/ask');
    assert.ok(ask, 'the bridge must have called /ask');
    assert.equal(ask.key, KEY, 'POST /ask must carry the API key, or the server answers 401 and the caller hears an error');
  } finally {
    restore();
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('claude-bridge.endSession sends the key on POST /end-session', async () => {
  const fake = await startFakeClaudeApi();
  const { loaded: bridge, restore } = loadFresh('claude-bridge', { CLAUDE_API_URL: fake.url, CLAUDE_API_KEY: KEY });
  try {
    await bridge.endSession('call-1');

    const end = fake.requests.find((r) => r.url === '/end-session');
    assert.ok(end, 'the bridge must have called /end-session');
    assert.equal(end.key, KEY, '/end-session is authenticated too (every route except GET /health)');
  } finally {
    restore();
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('claude-bridge without a configured key sends no key header (rollout: callers are deployed before the server enforces)', async () => {
  const fake = await startFakeClaudeApi();
  const { loaded: bridge, restore } = loadFresh('claude-bridge', { CLAUDE_API_URL: fake.url, CLAUDE_API_KEY: undefined });
  try {
    await bridge.query('hello', { callId: 'call-2' });

    const ask = fake.requests.find((r) => r.url === '/ask');
    assert.ok(ask, 'the call must still be made');
    assert.equal(ask.key, undefined, 'no key configured means no header, never the string "undefined"');
  } finally {
    restore();
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('POST /query with format=json sends the key on the upstream POST /ask-structured', async () => {
  const fake = await startFakeClaudeApi();
  const { loaded: queryRoutes, restore } = loadFresh('query-routes', { CLAUDE_API_URL: fake.url, CLAUDE_API_KEY: KEY });
  const app = express();
  app.use(express.json());
  app.use(queryRoutes.router);
  queryRoutes.setupRoutes({ claudeBridge: { query: async () => 'unused for the json path' } });
  const local = http.createServer(app);
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${local.address().port}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'status?', format: 'json', schema: { requiredFields: ['a'] } }),
    });
    await res.text();

    const structured = fake.requests.find((r) => r.url === '/ask-structured');
    assert.ok(structured, 'the json path must call /ask-structured upstream');
    assert.equal(structured.key, KEY, 'the structured query is authenticated like every other route');
  } finally {
    restore();
    await new Promise((resolve) => local.close(resolve));
    await new Promise((resolve) => fake.server.close(resolve));
  }
});
