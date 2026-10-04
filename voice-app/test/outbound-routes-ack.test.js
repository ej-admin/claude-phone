/**
 * HOME-10660: HTTP-level coverage of the acknowledgement flow through the REAL
 * outbound-routes router (POST /api/outbound-call -> GET /api/call/:id), driven
 * over a real socket. Only the SIP/media layer is stubbed (outbound-handler:
 * initiateOutboundCall/playMessage/hangupCall, and the conversation loop) -- the
 * routing, validation, session state machine and getInfo() are all production code.
 *
 * What this cannot prove: that real RFC2833 DTMF from a real handset reaches a real
 * FreeSWITCH endpoint as a `dtmf` event. That needs the live canary with Jeff's OK.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const express = require('express');

// --- stub the media layer BEFORE the router requires it ----------------------
const stub = { handler: null, conversationLoop: null };

function installStub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
installStub('../lib/outbound-handler', {
  initiateOutboundCall: (...args) => stub.handler.initiateOutboundCall(...args),
  playMessage: (...args) => stub.handler.playMessage(...args),
  hangupCall: (...args) => stub.handler.hangupCall(...args)
});
installStub('../lib/conversation-loop', {
  runConversationLoop: (...args) => stub.conversationLoop(...args)
});

const { router, setupRoutes } = require('../lib/outbound-routes');

let server;
let baseUrl;

test.before(async () => {
  setupRoutes({
    srf: {},
    mediaServer: {},
    audioForkServer: {},
    whisperClient: {},
    claudeBridge: {},
    ttsService: {}
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// --- helpers -----------------------------------------------------------------

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * A scripted call. `blockFirstPlay` makes the first playback hang until the
 * endpoint is told to uuid_break (a barge-in) -- mirrors a human pressing 1
 * while the message is still being spoken.
 */
function makeScenario({ blockFirstPlay = false } = {}) {
  const endpoint = new EventEmitter();
  endpoint.uuid = 'fs-endpoint-1';
  // OutboundSession.setDialog() tears the endpoint down on a remote hang-up.
  endpoint.destroy = async () => {};
  const dialog = new EventEmitter();
  dialog.destroyed = false;
  dialog.destroy = async () => { dialog.destroyed = true; };

  const played = [];
  const firstPlayStarted = deferred();
  let releaseFirstPlay = null;
  const state = { hungUp: false };

  endpoint.api = async (command) => {
    if (command === 'uuid_break' && releaseFirstPlay) releaseFirstPlay();
    return {};
  };

  return {
    endpoint,
    dialog,
    played,
    state,
    firstPlayStarted: firstPlayStarted.promise,
    initiateOutboundCall: async () => ({ dialog, endpoint }),
    playMessage: async (_endpoint, text) => {
      played.push(text);
      if (played.length === 1) {
        firstPlayStarted.resolve();
        if (blockFirstPlay) await new Promise((resolve) => { releaseFirstPlay = resolve; });
      }
    },
    hangupCall: async () => { state.hungUp = true; }
  };
}

async function postCall(body) {
  const res = await fetch(`${baseUrl}/api/outbound-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function getCall(callId) {
  const res = await fetch(`${baseUrl}/api/call/${callId}`);
  return { status: res.status, body: await res.json() };
}

async function waitForState(callId, wanted, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await getCall(callId)).body.data;
    if (last && wanted.includes(last.state)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`call ${callId} never reached ${wanted.join('|')}; last record: ${JSON.stringify(last)}`);
}

const ESCALATION = { to: '+15551234567', message: 'Disk is full', mode: 'announce', triggeredBy: 'telegram-drainer-escalation' };

// --- the acknowledgement flow -------------------------------------------------

test('escalation call: says Press 1, reports ack:null while waiting, then ack {dtmf,1,ISO} once 1 is pressed', async () => {
  const scenario = makeScenario({ blockFirstPlay: true });
  stub.handler = scenario;

  const created = await postCall(ESCALATION);
  assert.equal(created.status, 200, 'the call must be accepted');
  const callId = created.body.callId;

  await scenario.firstPlayStarted;
  assert.equal(scenario.played[0], 'Disk is full. Press 1 to acknowledge.', 'the escalation script must ask the listener to press 1');

  const waiting = (await getCall(callId)).body.data;
  assert.equal(waiting.state, 'PLAYING', 'precondition: mid-call');
  assert.equal(Object.prototype.hasOwnProperty.call(waiting, 'ack'), true, 'ack key must be present while waiting');
  assert.equal(waiting.ack, null, 'nothing pressed yet');
  assert.equal(waiting.ackRequested, true, 'diagnostic flag set');

  scenario.endpoint.emit('dtmf', { dtmf: '1', duration: '2000', source: 'RTP' });

  const acked = (await getCall(callId)).body.data;
  assert.equal(acked.ack.method, 'dtmf', 'ack method');
  assert.equal(acked.ack.digit, '1', 'ack digit');
  assert.ok(!Number.isNaN(Date.parse(acked.ack.at)) && /T.*Z$/.test(acked.ack.at), 'ack.at must be an ISO-8601 UTC timestamp');
  assert.equal(acked.answeredAt !== null, true, 'the call must report answeredAt alongside the ack');

  const done = await waitForState(callId, ['COMPLETED', 'FAILED']);
  assert.equal(done.state, 'COMPLETED', 'an acknowledged call must finish COMPLETED, not FAILED');
  assert.equal(done.reason, 'acknowledged', 'the reason must say why it ended');
  assert.equal(done.ack.digit, '1', 'the ack must survive to the terminal record');
  assert.equal(scenario.played.length, 2, 'message+prompt then a confirmation');
  assert.equal(scenario.state.hungUp, true, 'the call must be hung up after the confirmation');
});

test('escalation call nobody answers with a keypress: COMPLETED/ack_timeout with ack:null (listened, heard none)', async () => {
  process.env.OUTBOUND_ACK_TIMEOUT_MS = '1000';
  try {
    const scenario = makeScenario();
    stub.handler = scenario;

    const created = await postCall(ESCALATION);
    const done = await waitForState(created.body.callId, ['COMPLETED', 'FAILED'], 8000);

    assert.equal(done.state, 'COMPLETED', 'an unacknowledged call still completes normally');
    assert.equal(done.reason, 'ack_timeout', 'the reason must say nothing was pressed');
    assert.equal(Object.prototype.hasOwnProperty.call(done, 'ack'), true, 'key stays present: "listened and heard nothing", not "unsupported"');
    assert.equal(done.ack, null, 'no acknowledgement');
    assert.equal(scenario.played.length, 1, 'no confirmation for an unacknowledged call');
  } finally {
    delete process.env.OUTBOUND_ACK_TIMEOUT_MS;
  }
});

test('an ordinary announce call (no triggeredBy, no requireAck) is unchanged: no prompt, no ack key', async () => {
  const scenario = makeScenario();
  stub.handler = scenario;

  const created = await postCall({ to: '+15551234567', message: 'Dinner is ready', mode: 'announce' });
  const done = await waitForState(created.body.callId, ['COMPLETED', 'FAILED']);

  assert.equal(scenario.played[0], 'Dinner is ready', 'the message must be spoken verbatim, with no Press-1 prompt');
  assert.equal(done.state, 'COMPLETED', 'completes as before');
  assert.equal(done.reason, 'announce_complete', 'same reason as before this change');
  assert.equal(Object.prototype.hasOwnProperty.call(done, 'ack'), false, 'a call that never listened must not claim to');
  assert.equal(done.ackRequested, false, 'diagnostic flag');
  assert.equal(scenario.played.length, 1, 'one playback only');
});

test('explicit requireAck:true opts a call in without any triggeredBy', async () => {
  const scenario = makeScenario({ blockFirstPlay: true });
  stub.handler = scenario;

  const created = await postCall({ to: '+15551234567', message: 'Check the garage', mode: 'announce', requireAck: true });
  await scenario.firstPlayStarted;

  assert.equal(scenario.played[0], 'Check the garage. Press 1 to acknowledge.', 'requireAck:true must add the prompt');
  scenario.endpoint.emit('dtmf', { dtmf: '1' });
  const done = await waitForState(created.body.callId, ['COMPLETED', 'FAILED']);
  assert.equal(done.ack.digit, '1', 'and capture the ack');
});

test('a hang-up without pressing 1 is COMPLETED/remote_hangup, not FAILED, and carries ack:null', async () => {
  const scenario = makeScenario({ blockFirstPlay: true });
  stub.handler = scenario;

  const created = await postCall(ESCALATION);
  await scenario.firstPlayStarted;
  scenario.dialog.emit('destroy');
  scenario.endpoint.api('uuid_break');
  const done = await waitForState(created.body.callId, ['COMPLETED', 'FAILED']);

  assert.equal(done.state, 'COMPLETED', 'the listener hanging up is not a system failure');
  assert.equal(done.ack, null, 'and it is not an acknowledgement');
});

// --- request validation ---------------------------------------------------------

test('requireAck must be a boolean', async () => {
  const res = await postCall({ to: '+15551234567', message: 'x', requireAck: 'yes' });

  assert.equal(res.status, 400, 'a string requireAck is a malformed request');
  assert.equal(res.body.error, 'validation_failed');
});

test('triggeredBy must be a string', async () => {
  const res = await postCall({ to: '+15551234567', message: 'x', triggeredBy: { who: 'me' } });

  assert.equal(res.status, 400, 'a non-string triggeredBy is a malformed request');
  assert.equal(res.body.error, 'validation_failed');
});

test('requireAck:true is rejected for conversation mode (the loop owns DTMF there)', async () => {
  const res = await postCall({ to: '+15551234567', message: 'x', mode: 'conversation', requireAck: true });

  assert.equal(res.status, 400, 'ack capture is announce-mode only; say so instead of silently ignoring it');
  assert.match(res.body.message, /announce/i, 'the error must say why');
});

test('an allow-listed triggeredBy in conversation mode does NOT request an ack (no prompt, no ack key)', async () => {
  let loopArgs = null;
  stub.handler = makeScenario();
  stub.conversationLoop = async (...args) => { loopArgs = args; };

  const created = await postCall(Object.assign({}, ESCALATION, { mode: 'conversation' }));
  const done = await waitForState(created.body.callId, ['COMPLETED', 'FAILED']);

  assert.equal(Object.prototype.hasOwnProperty.call(done, 'ack'), false, 'conversation calls never claim ack support');
  assert.ok(loopArgs, 'the conversation loop must have run');
});

// --- recordTurn wiring (was dead code) --------------------------------------------

test('conversation mode feeds each completed turn into the session via the loop onTurn callback', async () => {
  let onTurn = null;
  stub.handler = makeScenario();
  stub.conversationLoop = async (_endpoint, _dialog, _callId, options) => {
    onTurn = options.onTurn;
    options.onTurn('is the disk ok', 'it is at ninety percent');
  };

  const created = await postCall({ to: '+15551234567', message: 'Disk alert', mode: 'conversation' });
  const done = await waitForState(created.body.callId, ['COMPLETED', 'FAILED']);

  assert.equal(typeof onTurn, 'function', 'the route must hand the loop an onTurn callback');
  assert.equal(done.turnCount, 1, 'the turn must be counted on the session');
  assert.equal(done.conversationHistory[0].user, 'is the disk ok', 'user text recorded');
  assert.equal(done.conversationHistory[0].assistant, 'it is at ninety percent', 'assistant text recorded');
});
