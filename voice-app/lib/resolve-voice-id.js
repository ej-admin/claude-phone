/**
 * HOME-5431: voiceId sentinel resolution
 *
 * Sentinel values mean "no device-specific voice was configured -- use the
 * account default." Callers pass these interchangeably depending on the code
 * path (outbound-routes.js passes explicit `null` when no `device` param is
 * given; outbound-handler.js's log line displays the friendlier 'default'
 * label for that same null, but the null itself keeps flowing downstream).
 *
 * A JS default *parameter* (`function f(voiceId = X)`) only fires when the
 * argument is `undefined` -- so an explicit `null` slipped through untouched
 * all the way to the ElevenLabs TTS URL as the literal string "null",
 * producing a 404 voice_not_found on every call that didn't specify a
 * per-device voice (including the escalation/confirming-call path).
 */

const VOICE_ID_SENTINELS = new Set([null, undefined, '', 'default', 'null']);

/**
 * Resolve a possibly-unset/sentinel voiceId to a real ElevenLabs voice id.
 * Prefers an explicit configured default (ELEVENLABS_VOICE_ID env var) over
 * any hardcoded id. Throws rather than ever handing ElevenLabs a sentinel --
 * a silent null substitution is what produced HOME-5431.
 *
 * @param {string|null|undefined} voiceId - caller-supplied voice id, if any
 * @param {{ELEVENLABS_VOICE_ID?: string}} [env] - injectable for tests; defaults to process.env
 * @returns {string} a real ElevenLabs voice id
 */
function resolveVoiceId(voiceId, env) {
  env = env || process.env;

  if (!VOICE_ID_SENTINELS.has(voiceId)) {
    return voiceId;
  }

  const configuredDefault = env.ELEVENLABS_VOICE_ID;
  if (configuredDefault && configuredDefault.trim()) {
    return configuredDefault.trim();
  }

  throw new Error(
    'No ElevenLabs voice configured (HOME-5431): caller supplied no device-specific ' +
    'voiceId and ELEVENLABS_VOICE_ID is not set in the environment. Refusing to call ' +
    'ElevenLabs with an unresolved voice id.'
  );
}

module.exports = { resolveVoiceId, VOICE_ID_SENTINELS };
