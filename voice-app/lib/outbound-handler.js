/**
 * Outbound Call Handler
 * Core logic for initiating outbound SIP calls via drachtio
 * v2: Added voiceId support for device-specific TTS
 *
 * Uses Early Offer pattern:
 * 1. Create FreeSWITCH endpoint first to get local SDP
 * 2. Send INVITE with our SDP
 * 3. On answer, connect the endpoint with remote SDP
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const ttsService = require('./tts-service');

/**
 * Initiate an outbound call
 *
 * @param {Object} srf - drachtio SRF instance
 * @param {Object} mediaServer - FreeSWITCH media server
 * @param {Object} options - Call options
 * @param {string} options.to - Phone number in E.164 format (+15551234567)
 * @param {string} options.message - Message to play when answered
 * @param {string} [options.callerId] - Caller ID (defaults to DEFAULT_CALLER_ID env var)
 * @param {number} [options.timeoutSeconds=30] - Ring timeout in seconds
 * @returns {Promise<Object>} { callId, dialog, endpoint }
 */
async function initiateOutboundCall(srf, mediaServer, options) {
  const {
    to,
    message,
    callerId,
    timeoutSeconds = 30,
    deviceConfig = null
  } = options;

  const callId = uuidv4();
  const startTime = Date.now();

  // Declared above the try block (not just inside it) so the catch handler
  // below can inspect isRinging to tell "the far end never even sent a
  // provisional response" apart from "it rang and nobody picked up" --
  // both currently 408/480 at the SIP layer but very different failures
  // (HOME-5409).
  let isRinging = false;
  let callAnswered = false;

  try {
    logger.info('Initiating outbound call', {
      callId,
      to,
      callerId,
      timeout: timeoutSeconds
    });

    // STEP 1: Create FreeSWITCH endpoint first (Early Offer pattern)
    logger.info('Creating FreeSWITCH endpoint', { callId });
    const endpoint = await mediaServer.createEndpoint();

    // Get local SDP from FreeSWITCH
    const localSdp = endpoint.local.sdp;

    // Format SIP URI for 3CX
    // Remove '+' from E.164 format for SIP URI
    // Internal extensions: dial as-is. External (E.164 with +): add 9 prefix for PSTN
    const isExternal = to.startsWith('+');
    const phoneNumber = isExternal ? '9' + to.replace(/^\+1?/, '') : to;
    // HOME-5409: this deployment runs the "SBC-everywhere" model (see
    // src/features/sbc-simplified-installer/SPEC.md) -- voice-app registers
    // with a LOCAL 3CX SBC (SIP_REGISTRAR), which is the only thing that
    // actually talks to the 3CX cloud PBX / PSTN. Outbound INVITEs must
    // therefore go to that SAME local SBC, not to a separate "trunk" host --
    // there is no separate trunk in this architecture. The previous default
    // ('10.70.7.50') was an unreachable, unowned placeholder IP (part of the
    // same 10.70.7.x template-default family as the old EXTERNAL_IP default
    // below) that nothing in this deployment's network ever routed to --
    // confirmed via SIP_REGISTRAR=127.0.0.1 + `3cxsbc.service` listening on
    // 0.0.0.0:5060 on the Pi (ADV-6833 follow-up investigation). No separate
    // SIP_TRUNK_HOST value has ever been documented or configured anywhere
    // in this repo, so falling back to SIP_REGISTRAR is not a guess -- it is
    // the only address this deployment's SIP signaling has ever used.
    const sipTrunkHost = process.env.SIP_TRUNK_HOST || process.env.SIP_REGISTRAR;
    const externalIp = process.env.EXTERNAL_IP || '10.70.7.81';
    const defaultCallerId = callerId || process.env.DEFAULT_CALLER_ID || '+15551234567';

    if (!sipTrunkHost) {
      // Loud, immediate, and distinct from every SIP-layer failure below --
      // there is nothing to dial. Do NOT let this fall through to a SIP
      // attempt against an empty/undefined host.
      logger.error('No SIP trunk target configured', {
        callId,
        checked: ['SIP_TRUNK_HOST', 'SIP_REGISTRAR']
      });
      throw new Error('sip_trunk_not_configured');
    }

    // SIP Authentication for 3CX extension registration.
    // HOME-5409: these MUST match the names the container actually sets
    // (confirmed live on the Pi's .env: SIP_AUTH_ID + SIP_PASSWORD --
    // same pair documented in .env.example and used by every other
    // SIP-auth consumer in this repo, e.g. voice-app/index.js). The prior
    // names (SIP_AUTH_USERNAME / SIP_AUTH_PASSWORD) matched nothing the
    // container ever set, so authUsername/authPassword below were silently
    // undefined on every default-identity call -- no Authorization header
    // was ever attached to the INVITE.
    const sipAuthUsername = process.env.SIP_AUTH_ID;
    const sipAuthPassword = process.env.SIP_PASSWORD;

    const sipUri = 'sip:' + phoneNumber + '@' + sipTrunkHost;

    logger.info('Dialing SIP URI', {
      callId,
      sipUri,
      from: defaultCallerId,
      hasAuth: !!(sipAuthUsername && sipAuthPassword)
    });

    // STEP 2: Create UAC (outbound call) with Early Offer
    // Use device extension and display name if available, otherwise fall
    // back to SIP_EXTENSION (the "Default extension for outbound calls"
    // per .env.example) -- NOT defaultCallerId. defaultCallerId is an E.164
    // PSTN caller-ID string (e.g. +15551234567), not a registered 3CX
    // extension; using it as the From-URI user part put an unregistered,
    // unauthenticated identity in the From header while auth (once fixed
    // above) authenticates as SIP_EXTENSION -- an identity mismatch most
    // SBCs will reject independent of whether auth itself is correct
    // (HOME-5409).
    const fromExtension = deviceConfig
      ? deviceConfig.extension
      : (process.env.SIP_EXTENSION || defaultCallerId.replace('+', ''));
    const displayName = deviceConfig ? deviceConfig.name : null;
    const fromHeader = displayName
      ? '"' + displayName + '" <sip:' + fromExtension + '@' + sipTrunkHost + '>'
      : '<sip:' + fromExtension + '@' + sipTrunkHost + '>';

    const uacOptions = {
      localSdp: localSdp,
      headers: {
        'From': fromHeader,
        'User-Agent': 'NetworkChuck-VoiceServer/1.0',
        'X-Call-ID': callId
      }
    };

    // Add SIP authentication - prefer device credentials, fall back to env vars
    const authUsername = deviceConfig ? deviceConfig.authId : sipAuthUsername;
    const authPassword = deviceConfig ? deviceConfig.password : sipAuthPassword;

    if (authUsername && authPassword) {
      uacOptions.auth = {
        username: authUsername,
        password: authPassword
      };
      logger.info('SIP authentication enabled', {
        callId,
        username: authUsername,
        device: deviceConfig ? deviceConfig.name : 'default'
      });
    } else {
      // HOME-5409: this is the exact failure ADV-6833's real test call hit --
      // no auth credentials resolved, so the INVITE went out unauthenticated,
      // the SBC never responded, and drachtio's client-side timeout produced
      // a 408 that the catch block below mapped to the bland 'no_answer' --
      // indistinguishable from Jeff genuinely not picking up. Fail loud and
      // BEFORE dialing instead: this is a configuration defect, not a normal
      // call outcome, and must never wear that label again.
      logger.error('No SIP auth credentials resolved -- refusing to dial unauthenticated', {
        callId,
        device: deviceConfig ? deviceConfig.name : 'default (env-based)',
        checkedEnvVars: deviceConfig ? null : ['SIP_AUTH_ID', 'SIP_PASSWORD'],
        checkedDeviceFields: deviceConfig ? ['authId', 'password'] : null
      });
      throw new Error('sip_auth_not_configured');
    }

    // Create the outbound call (returns dialog directly, not { uas, uac })
    const uac = await srf.createUAC(sipUri, uacOptions, {
      cbRequest: function(err, req) {
        // Called when INVITE is sent
        if (err) {
          logger.error('INVITE send failed', { callId, error: err.message });
        } else {
          logger.info('INVITE sent successfully', { callId });
        }
      },
      cbProvisional: function(res) {
        // Called on provisional responses (180 Ringing, 183 Progress, etc.)
        logger.info('Provisional response received', {
          callId,
          status: res.status,
          reason: res.reason
        });

        if (res.status === 180) {
          isRinging = true;
          logger.info('Phone is ringing', { callId, to });
        }
      }
    });

    // STEP 3: Call was answered! Connect endpoint with remote SDP
    callAnswered = true;
    const latency = Date.now() - startTime;

    logger.info('Call answered', {
      callId,
      to,
      latency,
      isRinging
    });

    // Modify endpoint with remote SDP to complete media connection
    await endpoint.modify(uac.remote.sdp);

    logger.info('Media connection established', { callId });

    // Setup call cleanup on remote hangup
    uac.on('destroy', function() {
      logger.info('Remote party hung up', { callId });
      if (endpoint) {
        endpoint.destroy().catch(function(err) {
          logger.warn('Failed to destroy endpoint on hangup', {
            callId,
            error: err.message
          });
        });
      }
    });

    return {
      callId,
      dialog: uac,
      endpoint,
      isRinging,
      latency
    };

  } catch (error) {
    const latency = Date.now() - startTime;

    logger.error('Outbound call failed', {
      callId,
      to,
      error: error.message,
      latency
    });

    // Handle specific SIP error codes
    if (error.status) {
      const status = error.status;
      if (status === 486) {
        throw new Error('busy');
      } else if (status === 480 || status === 408) {
        // HOME-5409: 408/480 is ambiguous by itself -- it covers both "rang
        // and timed out" and "the request never got a response at all"
        // (e.g. dropped by the SBC for a bad/mismatched identity). isRinging
        // is the discriminator: it's only ever set true on a real 180
        // Ringing provisional. If we never saw one, this was never a normal
        // "no answer" -- surface it as a distinct signaling failure so it
        // can't be misread as "Jeff didn't pick up."
        throw new Error(isRinging ? 'no_answer' : 'no_signaling_response');
      } else if (status === 404) {
        throw new Error('not_found');
      } else if (status === 403) {
        throw new Error('forbidden');
      } else if (status === 503) {
        throw new Error('service_unavailable');
      } else if (status === 401 || status === 407) {
        throw new Error('auth_failed');
      }
    }

    throw error;
  }
}

/**
 * Play a TTS message to an active call
 *
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {string} message - Text to convert to speech and play
 * @param {Object} [options] - Playback options
 * @param {string} [options.voiceId] - ElevenLabs voice ID for device-specific voice
 * @returns {Promise<void>}
 */
async function playMessage(endpoint, message, options) {
  options = options || {};
  var voiceId = options.voiceId || null;
  var startTime = Date.now();

  try {
    logger.info('Generating TTS for outbound call', {
      textLength: message.length,
      voiceId: voiceId || 'default'
    });

    // Generate TTS audio file with optional device voice
    var audioUrl = await ttsService.generateSpeech(message, voiceId);

    logger.info('Playing TTS to caller', { audioUrl: audioUrl });

    // Play the audio file via FreeSWITCH
    await endpoint.play(audioUrl);

    var duration = Date.now() - startTime;

    logger.info('TTS playback completed', {
      duration: duration,
      audioUrl: audioUrl
    });

  } catch (error) {
    logger.error('Failed to play message', {
      error: error.message
    });
    throw error;
  }
}

/**
 * Hangup an active outbound call
 *
 * @param {Object} dialog - drachtio dialog (UAC)
 * @param {Object} endpoint - FreeSWITCH endpoint
 * @param {string} callId - Call UUID for logging
 */
async function hangupCall(dialog, endpoint, callId) {
  logger.info('Hanging up outbound call', { callId: callId });

  try {
    // Destroy SIP dialog
    if (dialog && !dialog.destroyed) {
      await dialog.destroy();
      logger.info('Dialog destroyed', { callId: callId });
    }
  } catch (error) {
    logger.warn('Failed to destroy dialog', {
      callId: callId,
      error: error.message
    });
  }

  try {
    // Destroy FreeSWITCH endpoint
    if (endpoint) {
      await endpoint.destroy();
      logger.info('Endpoint destroyed', { callId: callId });
    }
  } catch (error) {
    logger.warn('Failed to destroy endpoint', {
      callId: callId,
      error: error.message
    });
  }
}

module.exports = {
  initiateOutboundCall: initiateOutboundCall,
  playMessage: playMessage,
  hangupCall: hangupCall
};
