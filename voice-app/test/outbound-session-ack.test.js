/**
 * HOME-10660: OutboundSession must expose the human-acknowledgement on getInfo()
 * (the body of GET /api/call/:callId -> `data`), in the exact shape the
 * homelab telegram-drainer consumes.
 *
 * CONSUMER CONTRACT FIXTURE (below): `unwrapCallRecord`, `normalizeCallState`,
 * `humanAcknowledgement` and `isDeliveryConfirmed` are copied VERBATIM from
 * scripts/telegram-drainer/lib/phone-escalation.js in ej-admin/homelab-automation
 * (PR #1405, HOME-5406 / HOME-10651 rework 2). They are a copy because the two
 * repos cannot import each other; if the drainer's predicate changes, this copy
 * must be updated in the same change. The tests run THIS repo's real
 * OutboundSession.getInfo() through that predicate -- that is the point.
 *
 * Contract:
 *   ack: { method:'dtmf', digit:'1', at:<ISO> }  a person pressed 1
 *   ack: null                                      listened, heard no acknowledgement
 *   (no `ack` key)                                 cannot report an acknowledgement
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { OutboundSession } = require('../lib/outbound-session');

// ---- BEGIN verbatim copy of the drainer's consumer predicate ---------------
function unwrapCallRecord(result) {
  if (!result) return null;
  return (result.data && typeof result.data === 'object') ? result.data : result;
}

function normalizeCallState(state) {
  return typeof state === 'string' ? state.trim().toUpperCase() : state;
}

function humanAcknowledgement(record) {
  if (!record || typeof record !== 'object') return { supported: false, acknowledged: false, ack: null };
  const supported = Object.prototype.hasOwnProperty.call(record, 'ack');
  const a = record.ack;
  const acknowledged = !!(supported && a && typeof a === 'object'
    && a.method === 'dtmf' && String(a.digit) === '1'
    && typeof a.at === 'string' && a.at.trim());
  return { supported, acknowledged, ack: acknowledged ? { method: a.method, digit: String(a.digit), at: a.at } : null };
}

function isDeliveryConfirmed(callRecord) {
  return !!(
    callRecord
    && callRecord.answeredAt
    && normalizeCallState(callRecord.state) !== 'FAILED'
    && humanAcknowledgement(callRecord).acknowledged
  );
}
// ---- END verbatim copy ------------------------------------------------------

function makeSession(options = {}) {
  return new OutboundSession(null, Object.assign({ to: '+15551234567', message: 'disk is full', mode: 'announce' }, options));
}

/** What GET /api/call/:id returns, as the drainer sees it after the proxy chain. */
function asHttpBody(session) {
  return { success: true, data: session.getInfo() };
}

test('a call that did NOT request an ack reports ackRequested:false and has no `ack` key (contract: cannot report)', () => {
  const info = makeSession().getInfo();

  assert.equal(info.ackRequested, false, 'diagnostic flag must say the ack was not requested');
  assert.equal(Object.prototype.hasOwnProperty.call(info, 'ack'), false, 'absent ack key = "cannot report", the honest answer for a call that never listened');
});

test('a call that requested an ack exposes ack:null from the moment it is created (key present, nothing pressed yet)', () => {
  const session = makeSession({ requireAck: true });
  const info = session.getInfo();

  assert.equal(info.ackRequested, true, 'diagnostic flag must say the ack was requested');
  assert.equal(Object.prototype.hasOwnProperty.call(info, 'ack'), true, 'key must exist from QUEUED on, or a drainer poll that expires mid-call would misread it as "unsupported"');
  assert.equal(info.ack, null, 'ack:null = listened, heard none (yet)');
});

test('recordAck publishes {method, digit, at} on getInfo()', () => {
  const session = makeSession({ requireAck: true });

  const recorded = session.recordAck({ method: 'dtmf', digit: '1', at: '2026-10-04T19:00:00.000Z' });

  assert.equal(recorded, true, 'the first ack must be accepted');
  assert.deepEqual(session.getInfo().ack, { method: 'dtmf', digit: '1', at: '2026-10-04T19:00:00.000Z' });
});

test('recordAck keeps the FIRST acknowledgement (a later one cannot move the timestamp)', () => {
  const session = makeSession({ requireAck: true });
  session.recordAck({ method: 'dtmf', digit: '1', at: '2026-10-04T19:00:00.000Z' });

  const second = session.recordAck({ method: 'dtmf', digit: '1', at: '2026-10-04T19:05:00.000Z' });

  assert.equal(second, false, 'a repeat must be rejected');
  assert.equal(session.getInfo().ack.at, '2026-10-04T19:00:00.000Z', 'the original ack time must stand');
});

test('recordAck is refused on a call that never asked for an ack (it never listened, so it cannot have heard one)', () => {
  const session = makeSession();

  const recorded = session.recordAck({ method: 'dtmf', digit: '1', at: '2026-10-04T19:00:00.000Z' });

  assert.equal(recorded, false, 'an ack nobody solicited is not evidence');
  assert.equal(Object.prototype.hasOwnProperty.call(session.getInfo(), 'ack'), false, 'and must not appear in the record');
});

// ---- the drainer's own predicate, over this repo's real output --------------

test('CONTRACT: an answered call acknowledged with DTMF 1 is confirmed delivery by the drainer predicate', () => {
  const session = makeSession({ requireAck: true });
  session.setEndpoint({});
  session.transition('PLAYING');
  session.recordAck({ method: 'dtmf', digit: '1', at: new Date().toISOString() });

  const record = unwrapCallRecord(asHttpBody(session));

  assert.equal(isDeliveryConfirmed(record), true, 'answeredAt + non-FAILED + dtmf 1 ack must be accepted as human-confirmed');
  assert.equal(humanAcknowledgement(record).acknowledged, true, 'the predicate must parse our ack shape');
});

test('CONTRACT: ack is conclusive while the call is still PLAYING (the drainer does not wait for hang-up)', () => {
  const session = makeSession({ requireAck: true });
  session.setEndpoint({});
  session.transition('PLAYING');
  session.recordAck({ method: 'dtmf', digit: '1', at: new Date().toISOString() });

  assert.equal(normalizeCallState(session.getInfo().state), 'PLAYING', 'precondition: not yet terminal');
  assert.equal(isDeliveryConfirmed(session.getInfo()), true, 'the ack alone must confirm; waiting for COMPLETED would add latency for nothing');
});

test('CONTRACT: an answered call nobody acknowledged is supported:true, acknowledged:false (answered_no_human_ack, retryable)', () => {
  const session = makeSession({ requireAck: true });
  session.setEndpoint({});
  session.transition('COMPLETED', 'ack_timeout');

  const ack = humanAcknowledgement(session.getInfo());

  assert.equal(ack.supported, true, 'the voice-app listened, so it must declare support (else the drainer parks it terminal)');
  assert.equal(ack.acknowledged, false, 'nothing was pressed');
  assert.equal(isDeliveryConfirmed(session.getInfo()), false, 'a voicemail pickup must never read as delivered');
});

test('CONTRACT: a call that never asked for an ack is reported as unsupported to the drainer', () => {
  const session = makeSession();
  session.setEndpoint({});
  session.transition('COMPLETED', 'announce_complete');

  assert.equal(humanAcknowledgement(session.getInfo()).supported, false, 'absent key must read as "cannot report"');
});

test('CONTRACT: a FAILED call is never confirmed, even if an ack is somehow on the record', () => {
  const session = makeSession({ requireAck: true });
  session.setEndpoint({});
  session.recordAck({ method: 'dtmf', digit: '1', at: new Date().toISOString() });
  session.transition('FAILED', 'error');

  assert.equal(isDeliveryConfirmed(session.getInfo()), false, 'FAILED must always win over an ack');
});

// ---- recordTurn / conversation stats (was dead code: defined, never called) --

test('recordTurn feeds the conversation stats that getInfo() exposes in conversation mode', () => {
  const session = makeSession({ mode: 'conversation' });

  session.recordTurn('is the disk ok', 'it is at ninety percent');
  const info = session.getInfo();

  assert.equal(info.turnCount, 1, 'turnCount must reflect the recorded turn');
  assert.equal(info.conversationHistory[0].user, 'is the disk ok', 'user text must be kept');
  assert.equal(info.conversationHistory[0].assistant, 'it is at ninety percent', 'assistant text must be kept');
});
