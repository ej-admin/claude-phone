/**
 * HOME-10660: human-acknowledgement (DTMF '1') capture for escalation calls.
 *
 * WHY THIS EXISTS: the homelab telegram-drainer only treats a phone escalation
 * as delivered when the call record carries `ack: { method:'dtmf', digit:'1',
 * at:<ISO> }` -- an answering machine also "answers", so answeredAt alone proves
 * nothing (ADV-6833). This suite pins the voice-app side of that contract.
 *
 * The module is exercised against fake endpoints (an EventEmitter that emits the
 * same `dtmf` events drachtio-fsmrf's Endpoint emits) -- no SIP, no FreeSWITCH,
 * no ElevenLabs. Whether real RFC2833 digits reach the endpoint is NOT provable
 * here; that is what the live canary (bin/phone-escalation-canary.js --live) is for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const ackCapture = require('../lib/ack-capture');
const { OutboundSession } = require('../lib/outbound-session');

const {
  shouldRequireAck,
  getAckTimeoutMs,
  buildAckMessage,
  listenForAck,
  announceWithAck,
  ACK_PROMPT,
  ACK_CONFIRMATION
} = ackCapture;

const FIXED_NOW = new Date('2026-10-04T19:00:00.000Z');
const fixedNow = () => FIXED_NOW;

function makeEndpoint() {
  const endpoint = new EventEmitter();
  endpoint.uuid = 'fs-endpoint-uuid';
  endpoint.apiCalls = [];
  endpoint.api = async (command, args) => {
    endpoint.apiCalls.push([command, args]);
    return {};
  };
  return endpoint;
}

function makeAckSession() {
  return new OutboundSession(null, {
    to: '+15551234567',
    message: 'disk is full',
    mode: 'announce',
    requireAck: true
  });
}

/** Resolves on the next macrotask so queued microtasks (awaits) settle first. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// shouldRequireAck: which calls get the "Press 1" prompt
// ---------------------------------------------------------------------------

test('shouldRequireAck: explicit requireAck=true opts in even for an unknown triggeredBy', () => {
  assert.equal(
    shouldRequireAck({ requireAck: true, triggeredBy: 'someone-else' }, {}),
    true,
    'an explicit requireAck:true must win regardless of who triggered the call'
  );
});

test('shouldRequireAck: explicit requireAck=false overrides an allow-listed triggeredBy', () => {
  assert.equal(
    shouldRequireAck({ requireAck: false, triggeredBy: 'telegram-drainer-escalation' }, {}),
    false,
    'a caller that says requireAck:false must never get the prompt, even from an escalation trigger'
  );
});

test('shouldRequireAck: the drainer escalation trigger opts in by default (no drainer change needed)', () => {
  assert.equal(
    shouldRequireAck({ triggeredBy: 'telegram-drainer-escalation' }, {}),
    true,
    'the drainer sends only triggeredBy:telegram-drainer-escalation; that alone must request an ack'
  );
});

test('shouldRequireAck: an unrelated or absent triggeredBy does not opt in', () => {
  assert.equal(shouldRequireAck({ triggeredBy: 'mcp-telephony' }, {}), false, 'unlisted trigger must not get the prompt');
  assert.equal(shouldRequireAck({}, {}), false, 'no requireAck and no triggeredBy must not get the prompt');
  assert.equal(shouldRequireAck(undefined, {}), false, 'a missing body must not throw or opt in');
});

test('shouldRequireAck: OUTBOUND_ACK_TRIGGERS replaces the default list (comma-separated, trimmed)', () => {
  const env = { OUTBOUND_ACK_TRIGGERS: ' ralph-page , watchdog-phone-chain ' };
  assert.equal(shouldRequireAck({ triggeredBy: 'watchdog-phone-chain' }, env), true, 'a configured trigger must opt in');
  assert.equal(
    shouldRequireAck({ triggeredBy: 'telegram-drainer-escalation' }, env),
    false,
    'configuring the list replaces the default rather than extending it'
  );
});

test('shouldRequireAck: an empty OUTBOUND_ACK_TRIGGERS disables trigger-based opt-in', () => {
  assert.equal(
    shouldRequireAck({ triggeredBy: 'telegram-drainer-escalation' }, { OUTBOUND_ACK_TRIGGERS: '' }),
    false,
    'an operator who sets the list to empty is turning trigger-based acks off'
  );
});

// ---------------------------------------------------------------------------
// buildAckMessage / getAckTimeoutMs
// ---------------------------------------------------------------------------

test('buildAckMessage appends the Press-1 prompt after a sentence terminator', () => {
  assert.equal(buildAckMessage('Disk is full.'), `Disk is full. ${ACK_PROMPT}`);
  assert.equal(buildAckMessage('Disk is full!'), `Disk is full! ${ACK_PROMPT}`);
});

test('buildAckMessage adds a full stop when the message has none, so the TTS pauses before the prompt', () => {
  assert.equal(buildAckMessage('  Disk is full  '), `Disk is full. ${ACK_PROMPT}`);
});

test('the prompt tells the listener to press 1 to acknowledge (the words the task specifies)', () => {
  assert.match(ACK_PROMPT, /press 1 to acknowledge/i, 'the spoken prompt must name the digit and the action');
});

test('getAckTimeoutMs defaults to 10 seconds', () => {
  assert.equal(getAckTimeoutMs({}), 10000);
});

test('getAckTimeoutMs honours OUTBOUND_ACK_TIMEOUT_MS and clamps it to a sane range', () => {
  assert.equal(getAckTimeoutMs({ OUTBOUND_ACK_TIMEOUT_MS: '15000' }), 15000, 'a valid value must be used');
  assert.equal(getAckTimeoutMs({ OUTBOUND_ACK_TIMEOUT_MS: '10' }), 1000, 'below the floor must clamp up, not wait zero');
  assert.equal(getAckTimeoutMs({ OUTBOUND_ACK_TIMEOUT_MS: '999999' }), 60000, 'above the ceiling must clamp down');
  assert.equal(getAckTimeoutMs({ OUTBOUND_ACK_TIMEOUT_MS: 'soon' }), 10000, 'garbage must fall back to the default');
});

// ---------------------------------------------------------------------------
// listenForAck: the DTMF listener
// ---------------------------------------------------------------------------

test('listenForAck records exactly {method, digit, at} when the listener presses 1', () => {
  const endpoint = makeEndpoint();
  const acks = [];
  listenForAck(endpoint, { onAck: (ack) => acks.push(ack), now: fixedNow });

  endpoint.emit('dtmf', { dtmf: '1', duration: '2000', source: 'RTP' });

  assert.deepEqual(
    acks,
    [{ method: 'dtmf', digit: '1', at: '2026-10-04T19:00:00.000Z' }],
    'the ack must be exactly the shape the drainer contract (humanAcknowledgement) accepts'
  );
});

test('listenForAck ignores every digit except 1', () => {
  const endpoint = makeEndpoint();
  const acks = [];
  listenForAck(endpoint, { onAck: (ack) => acks.push(ack), now: fixedNow });

  for (const digit of ['0', '2', '9', '*', '#']) {
    endpoint.emit('dtmf', { dtmf: digit });
  }

  assert.equal(acks.length, 0, 'only the digit 1 acknowledges; a stray keypress must not count as a human ack');
});

test('listenForAck accepts the digit alias used by conversation-loop (evt.digit)', () => {
  const endpoint = makeEndpoint();
  const acks = [];
  listenForAck(endpoint, { onAck: (ack) => acks.push(ack), now: fixedNow });

  endpoint.emit('dtmf', { digit: '1' });

  assert.equal(acks.length, 1, 'both event shapes already used in this codebase must be understood');
});

test('listenForAck reports a repeated 1 only once (first ack wins)', () => {
  const endpoint = makeEndpoint();
  const acks = [];
  listenForAck(endpoint, { onAck: (ack) => acks.push(ack), now: fixedNow });

  endpoint.emit('dtmf', { dtmf: '1' });
  endpoint.emit('dtmf', { dtmf: '1' });

  assert.equal(acks.length, 1, 'a held or double-tapped key must not overwrite the first acknowledgement timestamp');
});

test('listenForAck.wait resolves null after the timeout when nothing is pressed', async () => {
  const endpoint = makeEndpoint();
  const listener = listenForAck(endpoint, { onAck: () => {}, now: fixedNow });

  const result = await listener.wait(30);

  assert.equal(result, null, 'silence must resolve to null (the contract value for "listened, heard nothing")');
});

test('listenForAck.wait resolves with the ack as soon as 1 is pressed, not at the timeout', async () => {
  const endpoint = makeEndpoint();
  const listener = listenForAck(endpoint, { onAck: () => {}, now: fixedNow });

  const waiting = listener.wait(5000);
  endpoint.emit('dtmf', { dtmf: '1' });
  const started = Date.now();
  const result = await waiting;

  assert.equal(result.digit, '1', 'the pressed digit must come back');
  assert.ok(Date.now() - started < 1000, 'must return promptly on ack rather than waiting out the 5s window');
});

test('listenForAck.wait resolves null early when the abort promise settles (remote hung up)', async () => {
  const endpoint = makeEndpoint();
  const listener = listenForAck(endpoint, { onAck: () => {}, now: fixedNow });
  const started = Date.now();

  const result = await listener.wait(5000, Promise.resolve());

  assert.equal(result, null, 'a hung-up call has no ack');
  assert.ok(Date.now() - started < 1000, 'must not sit out the window on a dead call');
});

test('listenForAck.wait returns an ack that arrived BEFORE wait() was called (barge-in during the message)', async () => {
  const endpoint = makeEndpoint();
  const listener = listenForAck(endpoint, { onAck: () => {}, now: fixedNow });

  endpoint.emit('dtmf', { dtmf: '1' });
  const result = await listener.wait(5000);

  assert.equal(result.digit, '1', 'pressing 1 mid-message is a real acknowledgement and must not be lost');
});

test('listenForAck.stop removes the endpoint listener (no leak across calls)', () => {
  const endpoint = makeEndpoint();
  const listener = listenForAck(endpoint, { onAck: () => {}, now: fixedNow });
  assert.equal(endpoint.listenerCount('dtmf'), 1, 'precondition: listener attached');

  listener.stop();

  assert.equal(endpoint.listenerCount('dtmf'), 0, 'stop() must detach the dtmf handler');
});

// ---------------------------------------------------------------------------
// announceWithAck: the whole announce -> prompt -> listen -> confirm flow
// ---------------------------------------------------------------------------

function makePlayer(hooks = {}) {
  const played = [];
  const playMessage = async (endpoint, text, options) => {
    played.push({ text, voiceId: options && options.voiceId });
    if (hooks.onPlay) await hooks.onPlay(text, played.length);
  };
  return { played, playMessage };
}

test('announceWithAck plays the message and the Press-1 prompt as ONE TTS utterance, with the device voice', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const { played, playMessage } = makePlayer();

  await announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: 'voice-123', playMessage, timeoutMs: 20, now: fixedNow });

  assert.equal(played[0].text, `Disk is full. ${ACK_PROMPT}`, 'one TTS call, message then prompt');
  assert.equal(played[0].voiceId, 'voice-123', 'the device voice must be used for the prompt too');
});

test('announceWithAck: pressing 1 during the message records the ack, interrupts playback and plays a confirmation', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const { played, playMessage } = makePlayer({
    onPlay: async (text, n) => {
      if (n === 1) {
        endpoint.emit('dtmf', { dtmf: '1' });
        await tick();
      }
    }
  });

  const started = Date.now();
  const ack = await announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 5000, now: fixedNow });

  assert.deepEqual(ack, { method: 'dtmf', digit: '1', at: '2026-10-04T19:00:00.000Z' }, 'the ack must be returned');
  assert.deepEqual(session.ack, ack, 'the ack must already be on the session so GET /api/call/:id reports it');
  assert.ok(
    endpoint.apiCalls.some(([cmd, args]) => cmd === 'uuid_break' && args === endpoint.uuid),
    'a barge-in must interrupt the rest of the message via uuid_break'
  );
  assert.equal(played[1] && played[1].text, ACK_CONFIRMATION, 'the human must hear that the ack registered');
  assert.ok(Date.now() - started < 1000, 'must not wait out the 5s window once acknowledged');
});

test('announceWithAck: pressing 1 after the prompt (during the listen window) records the ack', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const { played, playMessage } = makePlayer();

  const flow = announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 5000, now: fixedNow });
  await tick();
  await tick();
  endpoint.emit('dtmf', { dtmf: '1' });
  const ack = await flow;

  assert.equal(ack && ack.digit, '1', 'an ack during the listen window must be captured');
  assert.equal(session.ack && session.ack.method, 'dtmf', 'and recorded on the session');
  assert.equal(played.length, 2, 'message+prompt, then the confirmation');
});

test('announceWithAck: nobody presses 1 -> returns null, session.ack stays null, no confirmation is played', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const { played, playMessage } = makePlayer();

  const ack = await announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 30, now: fixedNow });

  assert.equal(ack, null, 'no keypress means no acknowledgement (voicemail / ignored call)');
  assert.equal(session.ack, null, 'the session must keep ack:null, the contract value for "listened, heard none"');
  assert.equal(played.length, 1, 'no confirmation for a call nobody acknowledged');
});

test('announceWithAck: the remote hanging up during the listen window ends the wait early with null', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const { playMessage } = makePlayer();

  const started = Date.now();
  const flow = announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 5000, now: fixedNow });
  await tick();
  await tick();
  session.transition('COMPLETED', 'remote_hangup');
  const ack = await flow;

  assert.equal(ack, null, 'a hung-up, unacknowledged call has no ack');
  assert.ok(Date.now() - started < 1000, 'must not keep listening on a dead call');
});

test('announceWithAck: a playback failure BEFORE any ack propagates (a real failure, not an ack)', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const playMessage = async () => { throw new Error('tts exploded'); };

  await assert.rejects(
    () => announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 30, now: fixedNow }),
    /tts exploded/,
    'an un-acked playback failure must surface so the call is marked FAILED, never silently swallowed'
  );
  assert.equal(endpoint.listenerCount('dtmf'), 0, 'the dtmf listener must be detached even on failure');
});

test('announceWithAck: the remote hanging up mid-message (playback throws, call already ended) is not a playback failure', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const playMessage = async () => {
    session.transition('COMPLETED', 'remote_hangup');
    throw new Error('endpoint destroyed');
  };

  const ack = await announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 30, now: fixedNow });

  assert.equal(ack, null, 'hung up without pressing 1 = no ack');
  assert.equal(session.state, 'COMPLETED', 'a hang-up must stay COMPLETED, not be relabelled as an error');
});

test('announceWithAck: a playback error AFTER the ack does not lose the ack (human pressed 1 then hung up)', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const playMessage = async () => {
    endpoint.emit('dtmf', { dtmf: '1' });
    throw new Error('endpoint destroyed');
  };

  const ack = await announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 30, now: fixedNow });

  assert.equal(ack && ack.digit, '1', 'the acknowledgement already happened; a later media error must not erase it');
  assert.equal(session.ack && session.ack.digit, '1', 'and it must stay on the session');
});

test('announceWithAck: a failing confirmation playback does not lose the ack', async () => {
  const endpoint = makeEndpoint();
  const session = makeAckSession();
  const { playMessage } = makePlayer({
    onPlay: async (text, n) => {
      if (n === 1) {
        endpoint.emit('dtmf', { dtmf: '1' });
        await tick();
      }
      if (n === 2) throw new Error('confirmation tts failed');
    }
  });

  const ack = await announceWithAck({ endpoint, session, message: 'Disk is full.', voiceId: null, playMessage, timeoutMs: 30, now: fixedNow });

  assert.equal(ack && ack.digit, '1', 'the confirmation is a courtesy; its failure must never undo the ack');
});

test('announceWithAck detaches the dtmf listener on every path (no leak across calls)', async () => {
  const noPress = makeEndpoint();
  await announceWithAck({ endpoint: noPress, session: makeAckSession(), message: 'x.', voiceId: null, playMessage: makePlayer().playMessage, timeoutMs: 20, now: fixedNow });
  assert.equal(noPress.listenerCount('dtmf'), 0, 'no-press path');

  const pressed = makeEndpoint();
  await announceWithAck({
    endpoint: pressed,
    session: makeAckSession(),
    message: 'x.',
    voiceId: null,
    playMessage: makePlayer({ onPlay: async (t, n) => { if (n === 1) { pressed.emit('dtmf', { dtmf: '1' }); await tick(); } } }).playMessage,
    timeoutMs: 20,
    now: fixedNow
  });
  assert.equal(pressed.listenerCount('dtmf'), 0, 'ack path');
});
