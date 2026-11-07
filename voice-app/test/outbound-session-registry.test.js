/**
 * GEN-12926: the session registry must be keyed by the session's REAL callId.
 *
 * The one production call site (POST /api/outbound-call) always constructs
 * `new OutboundSession(null, {...})` so a UUID is generated. The constructor used to register the session under
 * the raw constructor PARAMETER (null) instead of `this.callId`, so every session was stored under the key `null`
 * and `getSession(realCallId)` / `GET /api/call/:callId` could never find it: an answered call read as not_found.
 *
 * Why this matters for the acknowledgement work: a person pressing 1 is recorded on the session and read back through
 * GET /api/call/:callId. With the registry keyed by null that read never succeeds, so an ack that WAS captured is
 * invisible to the caller and the escalation can never record "acknowledged".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { OutboundSession, getSession, getAllSessions } = require('../lib/outbound-session');

function make(callId, options = {}) {
  return new OutboundSession(callId, Object.assign({ to: '+15551234567', message: 'x', mode: 'announce' }, options));
}

test('a session built with a null callId (the production call site) is found under its generated callId', () => {
  const session = make(null);

  assert.ok(session.callId, 'a UUID was generated');
  assert.equal(getSession(session.callId), session, 'getSession(generated id) returns the very same session');
  assert.equal(getSession(null), undefined, 'and nothing is registered under the null key');

  session.cleanup && session.cleanup();
});

test('a session built with an explicit callId is found under that id', () => {
  const session = make('explicit-call-id-1');

  assert.equal(session.callId, 'explicit-call-id-1');
  assert.equal(getSession('explicit-call-id-1'), session);

  session.cleanup && session.cleanup();
});

test('two null-callId sessions do not overwrite each other (the null key used to hold only the latest)', () => {
  const first = make(null);
  const second = make(null);

  assert.notEqual(first.callId, second.callId);
  assert.equal(getSession(first.callId), first, 'the first session is still reachable after a second was created');
  assert.equal(getSession(second.callId), second);
  const ids = getAllSessions().map((s) => s.callId);
  assert.ok(ids.includes(first.callId) && ids.includes(second.callId), 'both are listed');

  first.cleanup && first.cleanup();
  second.cleanup && second.cleanup();
});

test('an acknowledgement recorded on the session is readable through the registry lookup GET /api/call/:id uses', () => {
  const session = make(null, { requireAck: true });
  assert.equal(session.recordAck({ method: 'dtmf', digit: '1', at: '2026-01-01T00:00:00.000Z' }), true, 'the ack was recorded');

  const found = getSession(session.callId);
  assert.ok(found, 'the call is findable by its id');
  const info = found.getInfo();
  assert.equal(info.ack && info.ack.method, 'dtmf', 'the captured ack comes back out');
  assert.equal(info.ack && String(info.ack.digit), '1');

  session.cleanup && session.cleanup();
});
