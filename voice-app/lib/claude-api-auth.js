/**
 * Authentication header for calls to claude-api-server (GEN-10898, security triage 22893).
 *
 * claude-api-server requires X-Claude-Api-Key on every route except GET /health. The secret comes from the
 * CLAUDE_API_KEY environment variable (the Pi's .env), is trimmed so a trailing newline from an env file
 * cannot change it, and is read at call time so a restart is the only thing needed to pick up a new value.
 *
 * With no key configured this returns NO header rather than throwing: callers are deployed before the
 * server starts enforcing, and an extra header is harmless to the old server. Once the server enforces,
 * a missing key shows up as the server's 401, which is the signal to set CLAUDE_API_KEY.
 */

const API_KEY_HEADER = 'X-Claude-Api-Key';

function authHeaders(env = process.env) {
  const key = typeof env.CLAUDE_API_KEY === 'string' ? env.CLAUDE_API_KEY.trim() : '';
  return key === '' ? {} : { [API_KEY_HEADER]: key };
}

module.exports = { API_KEY_HEADER, authHeaders };
