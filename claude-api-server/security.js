/**
 * claude-api-server security primitives (GEN-10898, security triage 22893).
 *
 * WHY this exists: server.js used to listen on 0.0.0.0:3333 with NO authentication, and POST /ask runs
 * `claude --dangerously-skip-permissions`. Anything that could reach the port could run code as the
 * service user. Three controls, each a small pure function so the decision is unit-testable:
 *
 *   1. A shared secret (X-Claude-Api-Key) on every route except GET /health, compared in constant time.
 *      No key configured = the server refuses to start; there is deliberately NO unauthenticated mode.
 *   2. /ask and /ask-structured are opt-in (CLAUDE_API_ASK_ENABLED): a leaked key must not by itself
 *      hand out a root-of-the-user shell, and nothing in production calls them today.
 *   3. The listen addresses are explicit (CLAUDE_API_LISTEN). The default is loopback plus any Tailscale
 *      address on a local interface, never the wildcard. A wildcard needs the operator to write it down.
 *
 * Nothing in this file logs, and no function here ever puts a key value into an error message.
 */

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const os = require('os');

const API_KEY_HEADER = 'X-Claude-Api-Key';
const MIN_KEY_LENGTH = 32;
const DEFAULT_LOOPBACK = '127.0.0.1';

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
        `Set it to a random secret of at least ${MIN_KEY_LENGTH} characters, loaded from an owner-only (mode 0600) env file.`,
    };
  }
  if (key.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      error: `CLAUDE_API_KEY is shorter than ${MIN_KEY_LENGTH} characters; a guessable key is no key. Generate a random one.`,
    };
  }
  return { ok: true, key };
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
 * The ONLY unauthenticated route: GET/HEAD /health, spelled exactly. This is deliberately stricter than
 * Express routing (which is case-insensitive and ignores a trailing slash): every variation is a 401, so
 * no path can be routed to a handler while being treated as public.
 */
function isPublicRoute(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && req.path === '/health';
}

/**
 * Express middleware: 401 unless the request carries the right X-Claude-Api-Key (or is the public route).
 * Mount it BEFORE the body parser so an unauthenticated caller never reaches the JSON parser, and before
 * every route so a route that does not exist is also a 401 (an unauthenticated probe learns nothing).
 *
 * @param {{key: string, onDenied?: (info: {method: string, path: string, remoteAddress?: string}) => void}} options
 */
function createAuthMiddleware({ key, onDenied } = {}) {
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) {
    throw new Error(`createAuthMiddleware: a key of at least ${MIN_KEY_LENGTH} characters is required`);
  }
  return function requireApiKey(req, res, next) {
    if (isPublicRoute(req)) return next();
    if (keysMatch(req.get(API_KEY_HEADER), key)) return next();
    if (typeof onDenied === 'function') {
      try {
        // The presented credential is deliberately NOT part of this record.
        onDenied({ method: req.method, path: req.path, remoteAddress: req.socket && req.socket.remoteAddress });
      } catch {
        // Logging must never turn a denial into a 500, and must never let the request through.
      }
    }
    return res.status(401).json({ success: false, error: 'unauthorized' });
  };
}

/** Opt-in flag: only an explicit yes enables. Unset, 0, false and every typo stay OFF (fail closed). */
function parseEnabledFlag(raw) {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Express middleware for the CLI-spawning endpoints. Mounted AFTER authentication, so only an
 * authenticated caller is ever told the endpoint exists and how to enable it.
 */
function createAskGate({ enabled }) {
  return function askGate(req, res, next) {
    if (enabled) return next();
    return res.status(403).json({
      success: false,
      error:
        'This endpoint is disabled on this server. Set CLAUDE_API_ASK_ENABLED=1 and restart to enable /ask and ' +
        '/ask-structured (they run the Claude CLI with --dangerously-skip-permissions).',
    });
  };
}

/** True for an IPv4 address in 100.64.0.0/10, the CGNAT block Tailscale assigns. */
function isTailnetAddress(ip) {
  if (typeof ip !== 'string' || !net.isIPv4(ip)) return false;
  const [first, second] = ip.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

const IFACE_PREFIX = 'iface:';

function isIPv4Entry(entry) {
  return Boolean(entry) && (entry.family === 'IPv4' || entry.family === 4);
}

/**
 * The CURRENT IPv4 addresses of a named interface. This exists because some hosts hand an interface an
 * address that changes across restarts (for example WSL2 in NAT mode, whose port forward is refreshed to
 * follow it): a literal in CLAUDE_API_LISTEN goes stale and the server then fails to bind and crash-loops.
 * A missing interface or one without an IPv4 address throws and names what does exist.
 */
function addressesOfInterface(name, interfaces) {
  if (name === '') {
    throw new Error(`CLAUDE_API_LISTEN entry "${IFACE_PREFIX}" has no interface name (use e.g. ${IFACE_PREFIX}eth0)`);
  }
  const entries = interfaces && interfaces[name];
  if (!entries) {
    const available = Object.keys(interfaces || {}).sort().join(', ') || '(none)';
    throw new Error(`CLAUDE_API_LISTEN entry "${IFACE_PREFIX}${name}": no interface named "${name}" on this host (interfaces: ${available})`);
  }
  const v4 = entries.filter(isIPv4Entry).map((entry) => entry.address);
  if (v4.length === 0) {
    throw new Error(`CLAUDE_API_LISTEN entry "${IFACE_PREFIX}${name}": interface "${name}" has no IPv4 address`);
  }
  return v4;
}

function isWildcard(address) {
  if (address === '0.0.0.0') return true;
  // '::', '::0', '0:0:0:0:0:0:0:0' ... any IPv6 literal made only of zeros and colons.
  return net.isIPv6(address) && address.replace(/[0:]/g, '') === '';
}

/**
 * Decide which addresses to bind.
 *
 *   CLAUDE_API_LISTEN unset/blank -> 127.0.0.1 plus any Tailscale IPv4 address found on a local interface.
 *   CLAUDE_API_LISTEN=a,b,c       -> exactly those entries: IP literals, or iface:<name> for that interface's
 *                                    current IPv4 addresses (host names and ports are rejected).
 *
 * A malformed entry THROWS rather than being dropped: a silently dropped address leaves some consumer
 * unable to connect with nothing in the log to say why. A wildcard is honoured only when written
 * explicitly, and always returns a warning.
 *
 * NOTE: a host whose Tailscale interface is not visible to this process (for example WSL2 in NAT mode,
 * where Tailscale runs on the Windows side) gets loopback only by default; list the extra addresses
 * explicitly in CLAUDE_API_LISTEN (prefer iface:<name> for an address that can change).
 *
 * @returns {{addresses: string[], warnings: string[]}}
 */
function resolveListenAddresses(env, interfaces = os.networkInterfaces()) {
  const raw = env && typeof env.CLAUDE_API_LISTEN === 'string' ? env.CLAUDE_API_LISTEN.trim() : '';
  const warnings = [];

  if (raw === '') {
    const addresses = [DEFAULT_LOOPBACK];
    for (const entries of Object.values(interfaces || {})) {
      for (const entry of entries || []) {
        if (isIPv4Entry(entry) && !entry.internal && isTailnetAddress(entry.address) && !addresses.includes(entry.address)) {
          addresses.push(entry.address);
        }
      }
    }
    return { addresses, warnings };
  }

  const addresses = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    if (entry.startsWith(IFACE_PREFIX)) {
      for (const address of addressesOfInterface(entry.slice(IFACE_PREFIX.length).trim(), interfaces)) {
        if (!addresses.includes(address)) addresses.push(address);
      }
      continue;
    }
    if (!net.isIP(entry)) {
      throw new Error(
        `CLAUDE_API_LISTEN entry "${entry}" is not an IP address literal ` +
          '(use e.g. 127.0.0.1, ::1 or iface:eth0; host names and ports are not accepted)'
      );
    }
    if (!addresses.includes(entry)) addresses.push(entry);
  }
  if (addresses.length === 0) {
    throw new Error('CLAUDE_API_LISTEN is set but lists no addresses; unset it for the default or list at least one IP');
  }

  const wildcards = addresses.filter(isWildcard);
  if (wildcards.length > 0) {
    warnings.push(
      `WARNING: CLAUDE_API_LISTEN includes a wildcard address (${wildcards.join(', ')}): the server is reachable on ` +
        'EVERY interface and the API key is its only protection. Restrict reachability at the network layer too.'
    );
  }
  return { addresses, warnings };
}

function formatHostPort(address, port) {
  return net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * Listen on every address, all-or-nothing. If ANY address cannot be bound the promise rejects and the
 * listeners already opened are closed: a service that is up on some of the addresses it was told to serve
 * looks healthy while some consumers get connection refused.
 *
 * @returns {Promise<http.Server[]>}
 */
function listenOnAll(app, addresses, port) {
  return new Promise((resolve, reject) => {
    const servers = [];
    let pending = addresses.length;
    let failed = false;

    const fail = (address, err) => {
      if (failed) return;
      failed = true;
      for (const server of servers) {
        try { server.close(); } catch { /* already not listening */ }
      }
      const wrapped = new Error(`cannot listen on ${formatHostPort(address, port)}: ${err.message}`);
      wrapped.cause = err;
      reject(wrapped);
    };

    for (const address of addresses) {
      const server = http.createServer(app);
      servers.push(server);
      server.on('error', (err) => fail(address, err));
      server.listen(port, address, () => {
        if (failed) {
          try { server.close(); } catch { /* ignore */ }
          return;
        }
        pending -= 1;
        if (pending === 0) resolve(servers);
      });
    }
  });
}

module.exports = {
  API_KEY_HEADER,
  MIN_KEY_LENGTH,
  loadApiKey,
  keysMatch,
  isPublicRoute,
  createAuthMiddleware,
  parseEnabledFlag,
  createAskGate,
  isTailnetAddress,
  resolveListenAddresses,
  formatHostPort,
  listenOnAll,
};
