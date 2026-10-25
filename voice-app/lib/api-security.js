/**
 * voice-app HTTP API security primitives (HOME-11645).
 *
 * WHY this exists: the voice-app listens on :3000 and, until this change, answered anyone who could open
 * a TCP connection. POST /api/outbound-call dialed whatever `to` the body named (a toll-fraud and
 * harassment surface), GET /api/calls listed in-flight calls, POST /api/query reached the Claude bridge
 * and POST /audio wrote files. Two controls, each a small pure function so the decision is unit-testable
 * without a socket:
 *
 *   1. A shared secret (X-Claude-Api-Key) on every route except GET/HEAD /health, compared in constant
 *      time. It is the same CLAUDE_API_KEY the voice-app already sends to claude-api-server (GEN-10898):
 *      one secret per fleet. No usable key configured = the API is LOCKED (everything but /health is a
 *      401); there is deliberately no unauthenticated mode. The process still boots, because it is also
 *      the SIP endpoint and a missing env var must not take inbound calls down with it.
 *   2. An exact-match destination allowlist for POST /api/outbound-call (OUTBOUND_ALLOWED_TO, the same
 *      name claude-api-server uses). Empty or unset = every call refused.
 *
 * One narrow exemption: FreeSWITCH runs on the same host and fetches generated TTS audio and the beeps
 * over http://127.0.0.1:3000/audio-files/... and /static/..., and it cannot send a header. A read of ONE
 * file name under those two prefixes, from the local host, is allowed without the key. Nothing else is.
 *
 * Nothing in this file logs, and no function here ever puts a key value into an error message.
 */

const crypto = require('crypto');
const net = require('net');

const API_KEY_HEADER = 'X-Claude-Api-Key';
const MIN_KEY_LENGTH = 32;

/**
 * Read the shared secret from the environment.
 * Whitespace is trimmed: an env file with a trailing newline must produce the same key on the server
 * and on every client, or the whole fleet is locked out by an invisible character.
 *
 * @returns {{ok: true, key: string} | {ok: false, error: string}}
 */
function loadApiKey(env) {
  const raw = env && env.CLAUDE_API_KEY;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key === '') {
    return {
      ok: false,
      error:
        'CLAUDE_API_KEY is not set. Every route except GET /health requires it and there is no unauthenticated mode. ' +
        'Set it (the same value the API server uses) to a random secret of at least ' + MIN_KEY_LENGTH +
        ' characters, loaded from an owner-only (mode 0600) env file.'
    };
  }
  if (key.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      error: 'CLAUDE_API_KEY is shorter than ' + MIN_KEY_LENGTH + ' characters; a guessable key is no key. Generate a random one.'
    };
  }
  return { ok: true, key: key };
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time key comparison. Both sides are hashed first so the inputs to timingSafeEqual always have
 * the same length (timingSafeEqual throws on unequal lengths, and a length-dependent early return would
 * leak the key length). Non-string input never matches and never throws.
 */
function keysMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

/**
 * True for an address that can only have come from this host: 127.0.0.0/8, ::1, or an IPv4-mapped
 * 127.x. A LAN, tailnet or docker-bridge peer is never loopback.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  if (address === '::1') return true;
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return net.isIPv4(v4) && v4.startsWith('127.');
}

function isLocalPeer(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

/**
 * The ONLY unauthenticated route: GET/HEAD /health, spelled exactly. This is deliberately stricter than
 * Express routing (which is case-insensitive and ignores a trailing slash): every variation is a 401, so
 * no path can be routed to a handler while being treated as public.
 */
function isPublicRoute(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && req.path === '/health';
}

// One file name: no separators, no leading dot, no percent-escapes. The generated names are
// tts-<ms>-<hash>.mp3 and the static ones are ready-beep.wav, gotit-beep.wav, hold-music.mp3.
const MEDIA_PATH = /^\/(?:audio-files|static)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The narrow exemption for FreeSWITCH's own fetches (see the header comment). It matches the RAW request
 * path, not a decoded one, so `..`, `%2e%2e`, `%2f`, a trailing slash or a second segment all fail the
 * pattern and fall through to the key check.
 *
 * @param {object} req
 * @param {(req: object) => boolean} [isLocalRequest] decides "from this host"; injectable for tests
 */
function isLocalMediaFetch(req, isLocalRequest) {
  const isLocal = typeof isLocalRequest === 'function' ? isLocalRequest : isLocalPeer;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (typeof req.path !== 'string' || !MEDIA_PATH.test(req.path)) return false;
  return isLocal(req) === true;
}

/**
 * Express middleware: 401 unless the request carries the right X-Claude-Api-Key, or is one of the two
 * exemptions above. Mount it BEFORE the body parser so an unauthenticated caller never reaches the JSON
 * parser, and before every route so a route that does not exist is also a 401 (a probe learns nothing).
 *
 * `key` null/undefined = LOCKED: only the exemptions pass. A key that is present but shorter than
 * MIN_KEY_LENGTH is a programming error (loadApiKey filters it) and throws rather than running weak.
 *
 * @param {{key?: string|null, onDenied?: (info: {method: string, path: string, remoteAddress?: string}) => void,
 *          isLocalRequest?: (req: object) => boolean}} options
 */
function createAuthMiddleware(options) {
  const opts = options || {};
  const key = opts.key === undefined ? null : opts.key;
  if (key !== null && (typeof key !== 'string' || key.length < MIN_KEY_LENGTH)) {
    throw new Error('createAuthMiddleware: a key of at least ' + MIN_KEY_LENGTH + ' characters is required (or null for a locked API)');
  }
  const locked = key === null;
  const onDenied = opts.onDenied;
  const isLocalRequest = opts.isLocalRequest;

  return function requireApiKey(req, res, next) {
    if (isPublicRoute(req)) return next();
    if (isLocalMediaFetch(req, isLocalRequest)) return next();
    if (!locked && keysMatch(req.get(API_KEY_HEADER), key)) return next();
    if (typeof onDenied === 'function') {
      try {
        // The presented credential is deliberately NOT part of this record.
        onDenied({ method: req.method, path: req.path, remoteAddress: req.socket && req.socket.remoteAddress });
      } catch (e) {
        // Logging must never turn a denial into a 500, and must never let the request through.
      }
    }
    return res.status(401).json({ success: false, error: 'unauthorized' });
  };
}

// ---------------------------------------------------------------------------------------------
// Destination allowlist
// ---------------------------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{1,14}$/;
const DIAL_STRING = /^\d{1,15}$/;

/**
 * The one definition of "a destination this API will dial": E.164, or a bare digit dial string (an
 * extension, or a 3CX outbound-rule prefix + number). The route validates `to` with this and an
 * allowlist entry must satisfy it too, so an entry can never be something the route would reject.
 */
function isValidDestination(value) {
  return typeof value === 'string' && (E164.test(value) || DIAL_STRING.test(value));
}

/**
 * Parse the allowlist (OUTBOUND_ALLOWED_TO: comma-separated; or an array/Set).
 * Entries are trimmed. An entry that is not a valid destination (a wildcard, a word, a number with
 * spaces) can never match a validated `to`, so it is dropped and REPORTED, never kept.
 * Unset, empty or blank gives an EMPTY set: fail closed, never "allow all".
 *
 * @returns {{allowed: Set<string>, ignored: string[]}}
 */
function parseAllowedDestinations(raw) {
  let entries = [];
  if (Array.isArray(raw)) entries = raw;
  else if (raw instanceof Set) entries = Array.from(raw);
  else if (typeof raw === 'string') entries = raw.split(',');

  const allowed = new Set();
  const ignored = [];
  for (const entry of entries) {
    const trimmed = typeof entry === 'string' ? entry.trim() : '';
    if (trimmed === '') continue;
    if (isValidDestination(trimmed)) allowed.add(trimmed);
    else ignored.push(trimmed);
  }
  return { allowed: allowed, ignored: ignored };
}

/**
 * EXACT string match, no normalisation of any kind. "15555550100" is not "+15555550100": the dial path
 * sends a string without a leading "+" as a raw dial string, so treating the two as equal would let a
 * differently-spelled number past a list that was written with the other spelling in mind.
 */
function isDestinationAllowed(allowed, to) {
  return allowed instanceof Set && typeof to === 'string' && allowed.has(to);
}

module.exports = {
  API_KEY_HEADER,
  MIN_KEY_LENGTH,
  loadApiKey,
  keysMatch,
  isLoopbackAddress,
  isPublicRoute,
  isLocalMediaFetch,
  createAuthMiddleware,
  isValidDestination,
  parseAllowedDestinations,
  isDestinationAllowed
};
