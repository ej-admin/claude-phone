/**
 * Outbound Call Session Management
 * State machine and tracking for outbound calls
 *
 * Announce Mode:      QUEUED → DIALING → PLAYING → COMPLETED/FAILED
 * Conversation Mode:  QUEUED → DIALING → PLAYING → CONVERSING → COMPLETED/FAILED
 */

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const logger = require('./logger');

// Active session tracking
const activeSessions = new Map(); // callId -> OutboundSession

/**
 * OutboundSession - State machine for outbound call lifecycle
 */
class OutboundSession extends EventEmitter {
  constructor(callId, options = {}) {
    super();

    // Generate UUID if not provided
    this.callId = callId || randomUUID();
    this.to = options.to;
    this.message = options.message;
    this.mode = options.mode || 'announce'; // 'announce' or 'conversation'
    this.callerId = options.callerId;
    this.webhookUrl = options.webhookUrl;

    // State tracking
    this.state = 'QUEUED';
    this.createdAt = Date.now();
    this.answeredAt = null;
    this.endedAt = null;
    // HOME-5409: last transition reason, surfaced via getInfo() so a FAILED
    // call's reason (e.g. 'sip_auth_not_configured', 'no_signaling_response')
    // is visible to external callers polling GET /call/:callId -- not just
    // buried in server logs. Without this, "loud" only reached the log file.
    this.lastReason = null;

    // Media objects
    this.endpoint = null;
    this.dialog = null;

    // Conversation mode tracking
    this.conversationHistory = [];
    this.turnCount = 0;

    // Register in active sessions.
    // HOME-5409: this MUST be this.callId, not the raw `callId` constructor
    // param -- the sole call site (outbound-routes.js) always passes null
    // here specifically so a UUID gets generated, which meant every session
    // was ALWAYS stored under key `null` and getSession(realCallId) could
    // never find it. GET /call/:callId has returned 'not_found' for every
    // outbound call ever placed via this path, including calls that were
    // fully answered -- confirmed live: "Outbound session created
    // {\"callId\":null,...}" in production logs is this exact bug caught
    // in the act, not a hypothetical.
    activeSessions.set(this.callId, this);

    logger.info('Outbound session created', {
      callId: this.callId,
      to: this.to,
      mode: this.mode,
      state: this.state
    });
  }

  /**
   * Transition to new state with logging and webhook notification
   *
   * @param {string} newState - New state
   * @param {string} [reason] - Optional reason for transition
   */
  transition(newState, reason = '') {
    const oldState = this.state;

    if (oldState === newState) {
      return; // No change
    }

    this.state = newState;
    if (reason) {
      this.lastReason = reason;
    }

    const logData = {
      callId: this.callId,
      transition: `${oldState} -> ${newState}`,
      reason: reason || undefined,
      elapsed: Date.now() - this.createdAt
    };

    logger.info('State transition', logData);

    // Emit event for listeners
    this.emit('stateChange', {
      from: oldState,
      to: newState,
      reason
    });

    // Send webhook on key events
    if (this.webhookUrl) {
      this.sendWebhook(newState, reason).catch(err => {
        logger.warn('Webhook delivery failed', {
          callId: this.callId,
          error: err.message
        });
      });
    }

    // Cleanup on terminal states
    if (newState === 'COMPLETED' || newState === 'FAILED') {
      this.endedAt = Date.now();

      // Keep session for 1 minute for status queries, then remove
      setTimeout(() => {
        activeSessions.delete(this.callId);
        logger.info('Session cleaned up', { callId: this.callId });
      }, 60000);
    }
  }

  /**
   * Send webhook notification
   *
   * @param {string} event - Event type (state name)
   * @param {string} [reason] - Optional reason
   */
  async sendWebhook(event, reason = '') {
    if (!this.webhookUrl) {
      return;
    }

    try {
      const payload = {
        callId: this.callId,
        timestamp: new Date().toISOString(),
        event: event.toLowerCase(),
        to: this.to,
        duration: this.getDuration(),
        reason: reason || undefined
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        logger.warn('Webhook returned non-200', {
          callId: this.callId,
          status: response.status
        });
      } else {
        logger.info('Webhook delivered', {
          callId: this.callId,
          event
        });
      }

    } catch (error) {
      logger.error('Webhook send failed', {
        callId: this.callId,
        error: error.message
      });
    }
  }

  /**
   * Set the FreeSWITCH endpoint
   *
   * @param {Object} endpoint - FreeSWITCH endpoint
   */
  setEndpoint(endpoint) {
    this.endpoint = endpoint;
    this.answeredAt = Date.now();

    logger.info('Endpoint attached', {
      callId: this.callId,
      answerTime: this.answeredAt - this.createdAt
    });
  }

  /**
   * Set the SIP dialog
   *
   * @param {Object} dialog - drachtio dialog (UAC)
   */
  setDialog(dialog) {
    this.dialog = dialog;

    // Listen for remote hangup
    dialog.on('destroy', () => {
      logger.info('Remote hangup detected', { callId: this.callId });
      this.transition('COMPLETED', 'remote_hangup');

      // Cleanup endpoint if still active
      if (this.endpoint) {
        this.endpoint.destroy().catch(err => {
          logger.warn('Failed to destroy endpoint on remote hangup', {
            callId: this.callId,
            error: err.message
          });
        });
      }
    });
  }

  /**
   * Hangup the call
   */
  async hangup() {
    logger.info('Initiating local hangup', { callId: this.callId });

    // Destroy dialog
    if (this.dialog && !this.dialog.destroyed) {
      try {
        await this.dialog.destroy();
      } catch (error) {
        logger.warn('Failed to destroy dialog', {
          callId: this.callId,
          error: error.message
        });
      }
    }

    // Destroy endpoint
    if (this.endpoint) {
      try {
        await this.endpoint.destroy();
      } catch (error) {
        logger.warn('Failed to destroy endpoint', {
          callId: this.callId,
          error: error.message
        });
      }
    }

    this.transition('COMPLETED', 'local_hangup');
  }

  /**
   * Record a conversation turn (for conversation mode)
   *
   * @param {string} userText - What the user said
   * @param {string} assistantText - What Claude responded
   */
  recordTurn(userText, assistantText) {
    this.turnCount++;
    this.conversationHistory.push({
      turn: this.turnCount,
      timestamp: Date.now(),
      user: userText,
      assistant: assistantText
    });

    logger.info('Conversation turn recorded', {
      callId: this.callId,
      turn: this.turnCount
    });
  }

  /**
   * Get call duration in seconds
   *
   * @returns {number|null} Duration in seconds, or null if not answered
   */
  getDuration() {
    if (!this.answeredAt) {
      return null;
    }

    const endTime = this.endedAt || Date.now();
    return Math.round((endTime - this.answeredAt) / 1000);
  }

  /**
   * Get session info for status queries
   *
   * @returns {Object} Session information
   */
  getInfo() {
    const info = {
      callId: this.callId,
      to: this.to,
      state: this.state,
      mode: this.mode,
      createdAt: new Date(this.createdAt).toISOString(),
      answeredAt: this.answeredAt ? new Date(this.answeredAt).toISOString() : null,
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      duration: this.getDuration(),
      reason: this.lastReason
    };

    // Include conversation stats for conversation mode
    if (this.mode === 'conversation') {
      info.turnCount = this.turnCount;
      info.conversationHistory = this.conversationHistory;
    }

    return info;
  }
}

/**
 * Get session by callId
 *
 * @param {string} callId - Call UUID
 * @returns {OutboundSession|undefined}
 */
function getSession(callId) {
  return activeSessions.get(callId);
}

/**
 * Get all active sessions
 *
 * @returns {Array<OutboundSession>}
 */
function getAllSessions() {
  return Array.from(activeSessions.values());
}

/**
 * Get session count
 *
 * @returns {number}
 */
function getSessionCount() {
  return activeSessions.size;
}

module.exports = {
  OutboundSession,
  getSession,
  getAllSessions,
  getSessionCount
};
