/**
 * HOME-10660: the /outbound-call proxy must forward `triggeredBy` and `requireAck`
 * to the voice-app, and must hand the voice-app's call record (including `ack`)
 * back unchanged.
 *
 * WHY: the voice-app asks a call's listener to "Press 1 to acknowledge" only for
 * calls that opt in (requireAck:true, or triggeredBy on its escalation allow-list).
 * The homelab drainer sends triggeredBy:'telegram-drainer-escalation' and nothing
 * else that marks a call as an escalation -- but this proxy used to LOG triggeredBy
 * and drop it, so the voice-app could never tell an escalation from any other call.
 *
 * server.js listens at module level (no export), so these tests spawn the real
 * server as a child process against a fake voice-app that records what it receives.
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

const ACKED_CALL_RECORD = {
  success: true,
  data: {
    callId: 'call-1',
    to: '+15551234567',
    state: 'PLAYING',
    mode: 'announce',
    answeredAt: '2026-10-04T19:00:03.000Z',
    ackRequested: true,
    ack: { method: 'dtmf', digit: '1', at: '2026-10-04T19:00:09.000Z' }
  }
};

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

async function startFakeVoiceApp() {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/outbound-call') {
        received.push(JSON.parse(raw));
        res.end(JSON.stringify({ success: true, callId: 'call-1', status: 'queued', message: 'Call initiated' }));
      } else if (req.method === 'GET' && req.url === '/api/call/call-1') {
        res.end(JSON.stringify(ACKED_CALL_RECORD));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'not_found' }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, received, url: `http://127.0.0.1:${server.address().port}` };
}

async function startProxy(voiceAppUrl) {
  const port = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home10660-proxy-'));
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      VOICE_APP_URL: voiceAppUrl,
      OUTBOUND_LOG_PATH: path.join(logDir, 'outbound-calls.jsonl'),
      // HOME-10759: the proxy only dials allow-listed numbers (fail closed), and de-duplicates
      // identical calls. These tests post the same number/payload repeatedly to observe the
      // forwarded fields, so the allowlist admits it and the duplicate window is off.
      OUTBOUND_ALLOWED_TO: '+15551234567',
      OUTBOUND_DEDUPE_WINDOW_MS: '0'
    }),
    stdio: 'ignore'
  });

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
    await new Promise((resolve) => setTimeout(resolve, 50));
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

async function postCall(body) {
  const res = await fetch(`${proxy.url}/outbound-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// Mirrors scripts/telegram-drainer/lib/phone-escalation.js buildCallPayload, as relayed by
// the telephony server's call_user tool.
const DRAINER_PAYLOAD = {
  to: '+15551234567',
  message: 'Disk is full',
  mode: 'tts',
  triggeredBy: 'telegram-drainer-escalation'
};

test('forwards the drainer triggeredBy to the voice-app (so it can tell an escalation from any other call)', async () => {
  voiceApp.received.length = 0;

  const res = await postCall(DRAINER_PAYLOAD);

  assert.equal(res.status, 200, 'the call must be accepted');
  assert.equal(voiceApp.received.length, 1, 'exactly one request must reach the voice-app');
  assert.equal(voiceApp.received[0].triggeredBy, 'telegram-drainer-escalation', 'triggeredBy was previously logged and dropped; it must now be forwarded');
  assert.equal(voiceApp.received[0].mode, 'announce', 'existing behaviour: tts is normalised to announce');
});

test('forwards an explicit requireAck:true', async () => {
  voiceApp.received.length = 0;

  await postCall({ to: '+15551234567', message: 'x', requireAck: true });

  assert.equal(voiceApp.received[0].requireAck, true, 'an explicit opt-in must reach the voice-app');
});

test('forwards an explicit requireAck:false (it must be able to override an allow-listed triggeredBy)', async () => {
  voiceApp.received.length = 0;

  await postCall(Object.assign({}, DRAINER_PAYLOAD, { requireAck: false }));

  assert.equal(voiceApp.received[0].requireAck, false, 'false is a decision, not an absence; dropping it would silently re-enable the prompt');
});

test('a call with neither field sends neither (existing callers see no change)', async () => {
  voiceApp.received.length = 0;

  await postCall({ to: '+15551234567', message: 'Dinner is ready' });

  assert.equal('requireAck' in voiceApp.received[0], false, 'no requireAck key invented');
  assert.equal('triggeredBy' in voiceApp.received[0], false, 'no triggeredBy key invented');
});

test('a non-string triggeredBy is ignored rather than rejected (it was always tolerated)', async () => {
  voiceApp.received.length = 0;

  const res = await postCall({ to: '+15551234567', message: 'x', triggeredBy: { who: 'someone' } });

  assert.equal(res.status, 200, 'must not start rejecting callers that sent an odd triggeredBy before');
  assert.equal('triggeredBy' in voiceApp.received[0], false, 'a non-string must not be forwarded');
});

test('a non-boolean requireAck is a 400 and never reaches the voice-app (do not silently drop an opt-in)', async () => {
  voiceApp.received.length = 0;

  const res = await postCall({ to: '+15551234567', message: 'x', requireAck: 'yes' });

  assert.equal(res.status, 400, 'a caller that asked for an ack must be told its request is malformed');
  assert.match(res.body.error, /requireAck/, 'the error must name the field');
  assert.equal(voiceApp.received.length, 0, 'no call may be placed on a malformed request');
});

test('GET /outbound-call/:id returns the voice-app record, including ack, unchanged', async () => {
  const res = await fetch(`${proxy.url}/outbound-call/call-1`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, ACKED_CALL_RECORD, 'the drainer reads ack off this record; the proxy must not reshape or drop it');
});
