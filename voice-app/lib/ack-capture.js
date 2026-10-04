/**
 * Human-acknowledgement capture for outbound escalation calls (HOME-10660).
 *
 * WHY: an answered call proves nothing about WHO answered -- an answering machine
 * also picks up (ADV-6833: 310 escalations were labelled delivered, none reached
 * Jeff's phone). The homelab telegram-drainer therefore only counts a phone
 * escalation as delivered when the call record carries a human acknowledgement:
 *
 *   ack: { method: 'dtmf', digit: '1', at: <ISO timestamp> }   a person pressed 1
 *   ack: null                                                    listened, heard none
 *   (no `ack` key)                                               cannot report one
 *
 * (consumer: scripts/telegram-drainer/lib/phone-escalation.js humanAcknowledgement,
 * ej-admin/homelab-automation). This module makes the voice-app able to produce
 * that record: it adds "Press 1 to acknowledge" to the spoken message, listens
 * for DTMF 1 on the call's media endpoint, and records the first one.
 *
 * Opt-in per call, never global: only calls that ask (requireAck:true) or whose
 * triggeredBy is on the escalation allow-list get the prompt, so ordinary announce
 * calls are unchanged.
 */

const logger = require('./logger');

const ACK_DIGIT = '1';
const ACK_PROMPT = 'Press 1 to acknowledge.';
const ACK_CONFIRMATION = 'Acknowledged. Thank you. Goodbye.';

// The drainer sends exactly this triggeredBy (scripts/telegram-drainer/lib/phone-escalation.js
// buildCallPayload) and nothing else that marks a call as an escalation, so it is the
// default opt-in. Override with OUTBOUND_ACK_TRIGGERS (comma-separated; empty = none).
const DEFAULT_ACK_TRIGGERS = ['telegram-drainer-escalation'];

const DEFAULT_ACK_TIMEOUT_MS = 10000;
const MIN_ACK_TIMEOUT_MS = 1000;
const MAX_ACK_TIMEOUT_MS = 60000;

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED']);

function getAckTriggers(env) {
  const raw = env.OUTBOUND_ACK_TRIGGERS;
  if (raw === undefined) return DEFAULT_ACK_TRIGGERS;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Should this call ask the listener to press 1?
 * An explicit boolean requireAck always wins; otherwise the call opts in when its
 * triggeredBy is on the allow-list.
 *
 * @param {Object} body - POST /api/outbound-call body (only requireAck/triggeredBy are read)
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
function shouldRequireAck(body, env = process.env) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.requireAck === 'boolean') return body.requireAck;
  if (typeof body.triggeredBy !== 'string') return false;
  return getAckTriggers(env).includes(body.triggeredBy.trim());
}

/**
 * How long to keep listening after the prompt. Clamped: zero would turn "listened"
 * into "never listened", and an unbounded wait would hold the line open.
 */
function getAckTimeoutMs(env = process.env) {
  const parsed = Number(env.OUTBOUND_ACK_TIMEOUT_MS);
  if (env.OUTBOUND_ACK_TIMEOUT_MS === undefined || env.OUTBOUND_ACK_TIMEOUT_MS === '' || !Number.isFinite(parsed)) {
    return DEFAULT_ACK_TIMEOUT_MS;
  }
  return Math.min(MAX_ACK_TIMEOUT_MS, Math.max(MIN_ACK_TIMEOUT_MS, parsed));
}

/**
 * The spoken script: the message, a sentence break, then the prompt. One string so
 * it is ONE TTS utterance in ONE voice.
 */
function buildAckMessage(message) {
  const text = String(message).trim();
  const terminated = /[.!?…]$/.test(text);
  return `${text}${terminated ? '' : '.'} ${ACK_PROMPT}`;
}

/**
 * Listen for DTMF 1 on a media endpoint (drachtio-fsmrf Endpoint: emits
 * `dtmf` with { dtmf, duration, source }).
 *
 * Attach BEFORE playing the message: pressing 1 while the message is still being
 * spoken is a real acknowledgement and must not be lost.
 *
 * @param {EventEmitter} endpoint
 * @param {Object} options
 * @param {Function} [options.onAck] - called synchronously with the ack the moment it happens,
 *   so the call record can report it before the call ends
 * @param {Function} [options.now] - clock, injectable for tests
 * @returns {{ stop: Function, wait: Function }}
 */
function listenForAck(endpoint, options) {
  const opts = options || {};
  const now = opts.now || (() => new Date());
  let ack = null;
  let resolveAcked;
  const acked = new Promise((resolve) => { resolveAcked = resolve; });

  function handler(evt) {
    const digit = evt && (evt.dtmf !== undefined ? evt.dtmf : evt.digit);
    if (String(digit) !== ACK_DIGIT || ack) {
      return;
    }
    ack = { method: 'dtmf', digit: ACK_DIGIT, at: now().toISOString() };
    if (typeof opts.onAck === 'function') {
      // This runs inside the media server's event dispatch: an exception here
      // would escape into the SIP/media stack. Log it loudly instead.
      try {
        opts.onAck(ack);
      } catch (err) {
        logger.error('Ack callback failed', { error: err.message });
      }
    }
    resolveAcked(ack);
  }

  endpoint.on('dtmf', handler);

  return {
    stop() {
      endpoint.off('dtmf', handler);
    },

    /**
     * Resolve with the ack (immediately, if one already arrived), or null when the
     * window closes or `abort` settles first (the call ended).
     */
    wait(timeoutMs, abort) {
      if (ack) return Promise.resolve(ack);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        const finish = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        acked.then(finish);
        if (abort) abort.then(() => finish(ack));
      });
    }
  };
}

/**
 * Play the message with the Press-1 prompt, listen for the acknowledgement,
 * confirm it to the listener, and return it (null if nobody pressed 1).
 *
 * The ack is written to the session the instant it is heard (not after this
 * function returns), so GET /api/call/:id reports it while the call is still up.
 * Nothing that happens after that -- a failed confirmation, a hang-up, a media
 * error -- may undo it.
 *
 * @param {Object} params
 * @param {Object} params.endpoint - media endpoint
 * @param {Object} params.session - OutboundSession (requireAck:true)
 * @param {string} params.message - the escalation text
 * @param {string|null} params.voiceId - device voice
 * @param {Function} params.playMessage - (endpoint, text, { voiceId }) => Promise; injected
 * @param {number} [params.timeoutMs] - listen window after the prompt
 * @param {Function} [params.now] - clock, injectable for tests
 * @returns {Promise<Object|null>} the ack, or null
 */
async function announceWithAck({ endpoint, session, message, voiceId, playMessage, timeoutMs, now }) {
  const windowMs = timeoutMs !== undefined ? timeoutMs : getAckTimeoutMs();

  const callEnded = new Promise((resolve) => {
    if (TERMINAL_STATES.has(session.state)) {
      resolve();
      return;
    }
    session.on('stateChange', function onState(change) {
      if (TERMINAL_STATES.has(change.to)) {
        session.off('stateChange', onState);
        resolve();
      }
    });
  });

  const listener = listenForAck(endpoint, {
    now,
    onAck: (ack) => {
      session.recordAck(ack);
      // They pressed 1: stop talking over them. Cosmetic -- never allowed to fail the call.
      (async () => {
        await endpoint.api('uuid_break', endpoint.uuid);
      })().catch((err) => logger.warn('Could not interrupt playback after ack', { callId: session.callId, error: err.message }));
    }
  });

  const callIsLive = () => !TERMINAL_STATES.has(session.state);

  try {
    try {
      await playMessage(endpoint, buildAckMessage(message), { voiceId });
    } catch (err) {
      // A playback error is a real failure UNLESS the call was already acknowledged or
      // already over (the listener hung up mid-message) -- then it is just the call ending.
      if (!session.ack && callIsLive()) {
        throw err;
      }
      logger.info('Playback ended early (call acknowledged or already over)', {
        callId: session.callId,
        error: err.message
      });
    }

    if (!session.ack && callIsLive()) {
      await listener.wait(windowMs, callEnded);
    }

    if (session.ack && callIsLive()) {
      try {
        await playMessage(endpoint, ACK_CONFIRMATION, { voiceId });
      } catch (err) {
        logger.warn('Ack confirmation playback failed (ack is kept)', { callId: session.callId, error: err.message });
      }
    }

    return session.ack;
  } finally {
    listener.stop();
  }
}

module.exports = {
  shouldRequireAck,
  getAckTimeoutMs,
  buildAckMessage,
  listenForAck,
  announceWithAck,
  ACK_PROMPT,
  ACK_CONFIRMATION
};
