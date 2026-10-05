/**
 * Claude HTTP API Server
 *
 * HTTP server that wraps Claude Code CLI with session management
 * Runs on the API server to handle voice interface queries
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   POST /ask - Send a prompt to Claude (with optional callId for session)
 *   POST /end-session - Clean up session for a call
 *   GET /health - Health check
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  buildQueryContext,
  buildStructuredPrompt,
  tryParseJsonFromText,
  validateRequiredFields,
  buildRepairPrompt,
} = require('./structured');

const app = express();
const PORT = process.env.PORT || 3333;

/**
 * Build the full environment that Claude Code expects
 * This mimics what happens when you run `claude` in a terminal
 * with your zsh profile fully loaded.
 */
function buildClaudeEnvironment() {
  const HOME = process.env.HOME || '/Users/networkchuck';
  const PAI_DIR = path.join(HOME, '.claude');

  // Load ~/.claude/.env (all API keys)
  const envPath = path.join(PAI_DIR, '.env');
  const paiEnv = {};
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          paiEnv[key] = valueParts.join('=');
        }
      }
    }
  }

  // Build PATH like zsh profile does
  const fullPath = [
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/python@3.12/bin',
    '/opt/homebrew/opt/libpq/bin',
    path.join(HOME, '.bun/bin'),
    path.join(HOME, '.local/bin'),
    path.join(HOME, '.pyenv/bin'),
    path.join(HOME, '.pyenv/shims'),
    path.join(HOME, 'go/bin'),
    '/usr/local/go/bin',
    path.join(HOME, 'bin'),
    path.join(HOME, '.lmstudio/bin'),
    path.join(HOME, '.opencode/bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].join(':');

  const env = {
    ...process.env,
    ...paiEnv,
    PATH: fullPath,
    HOME,
    PAI_DIR,
    PAI_HOME: HOME,
    DA: 'Morpheus',
    DA_COLOR: 'purple',
    GOROOT: '/usr/local/go',
    GOPATH: path.join(HOME, 'go'),
    PYENV_ROOT: path.join(HOME, '.pyenv'),
    BUN_INSTALL: path.join(HOME, '.bun'),
    // NOTE: Do NOT set CLAUDECODE or CLAUDE_CODE_ENTRYPOINT here
    // Setting these causes "cannot be launched inside another Claude Code session" errors
  };

  // Remove these if inherited from parent process
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // CRITICAL: Remove ANTHROPIC_API_KEY so Claude CLI uses subscription auth
  // If ANTHROPIC_API_KEY is set (even to placeholder), CLI tries API auth instead
  delete env.ANTHROPIC_API_KEY;

  return env;
}

// Pre-build the environment once at startup
const claudeEnv = buildClaudeEnvironment();
console.log('[STARTUP] Loaded environment with', Object.keys(claudeEnv).length, 'variables');
console.log('[STARTUP] PATH includes:', claudeEnv.PATH.split(':').slice(0, 5).join(', '), '...');

// Log which API keys are available (without showing values)
const apiKeys = Object.keys(claudeEnv).filter(k =>
  k.includes('API_KEY') || k.includes('TOKEN') || k.includes('SECRET') || k === 'PAI_DIR'
);
console.log('[STARTUP] API keys loaded:', apiKeys.join(', '));

// Session storage: callId -> claudeSessionId
const sessions = new Map();

// Model selection - Sonnet for balanced speed/quality
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

function parseClaudeStdout(stdout) {
  // Claude Code CLI may output JSONL; when it does, extract the `result` message.
  // Otherwise, fall back to raw stdout.
  let response = '';
  let sessionId = null;

  try {
    const lines = String(stdout || '').trim().split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'result' && parsed.result) {
          response = parsed.result;
          sessionId = parsed.session_id;
        }
      } catch {
        // Not JSONL; ignore.
      }
    }

    if (!response) response = String(stdout || '').trim();
  } catch {
    response = String(stdout || '').trim();
  }

  return { response, sessionId };
}

function runClaudeOnce({ fullPrompt, callId, timestamp }) {
  const startTime = Date.now();

  const args = [
    '--dangerously-skip-permissions',
    '-p', fullPrompt,
    '--model', CLAUDE_MODEL
  ];

  if (callId) {
    if (sessions.has(callId)) {
      args.push('--resume', callId);
      console.log(`[${timestamp}] Resuming session: ${callId}`);
    } else {
      args.push('--session-id', callId);
      sessions.set(callId, true);
      console.log(`[${timestamp}] Starting new session: ${callId}`);
    }
  }

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: claudeEnv
    });

    let stdout = '';
    let stderr = '';

    claude.stdin.end();
    claude.stdout.on('data', (data) => { stdout += data.toString(); });
    claude.stderr.on('data', (data) => { stderr += data.toString(); });

    claude.on('error', (error) => {
      reject(error);
    });

    claude.on('close', (code) => {
      const duration_ms = Date.now() - startTime;
      resolve({ code, stdout, stderr, duration_ms });
    });
  });
}

/**
 * Voice Context - Prepended to all voice queries
 *
 * This tells Claude how to handle voice-specific patterns:
 * - Output VOICE_RESPONSE for TTS (conversational, 40 words max)
 * - Output COMPLETED for status logging (12 words max)
 * - For Slack delivery requests: do the work, send to Slack, then acknowledge
 */
const VOICE_CONTEXT = `[VOICE CALL CONTEXT]
This query comes via voice call. You MUST include BOTH of these lines in your response:

🗣️ VOICE_RESPONSE: [Your conversational answer in 40 words or less. This is what gets spoken aloud via TTS. Be natural and helpful, like talking to a friend.]

🎯 COMPLETED: [Status summary in 12 words or less. This is for logging only.]

IMPORTANT: The VOICE_RESPONSE line is what the caller HEARS. Make it conversational and complete - don't just say "Done" or "Task completed". Actually answer their question or confirm what you did in a natural way.

SLACK DELIVERY: When the caller requests delivery to Slack (phrases like "send to Slack", "post to #channel", "message me when done"):
1. Do the requested work (research, generate content, analyze, etc.)
2. Send results to the specified Slack channel using the Slack skill
3. Include a VOICE_RESPONSE like: "Done! I sent the weather info to the 508 channel."

The caller may hang up while you're working (they'll hear hold music). That's fine - complete the work and send to Slack. They'll see it there.

Example query: "What's the weather in Royce City?"
Example response:
🗣️ VOICE_RESPONSE: It's 65 degrees and partly cloudy in Royce City right now. Great weather for being outside!
🎯 COMPLETED: Weather lookup for Royce City done.
[END VOICE CONTEXT]

`;

// Middleware
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

/**
 * POST /ask
 *
 * Request body:
 *   {
 *     "prompt": "What Docker containers are running?",
 *     "callId": "optional-call-uuid",
 *     "devicePrompt": "optional device-specific prompt"
 *   }
 *
 * Response:
 *   { "success": true, "response": "...", "duration_ms": 1234, "sessionId": "..." }
 *
 * Session Management:
 *   - If callId is provided and we have a stored session, uses --resume
 *   - First query for a callId captures the session_id for future turns
 *   - This maintains conversation context across multiple turns in a phone call
 *
 * Device Prompts:
 *   - If devicePrompt is provided, it's prepended before VOICE_CONTEXT
 *   - This allows each device (NAS, Proxmox, etc.) to have its own identity and skills
 */
app.post('/ask', async (req, res) => {
  const { prompt, callId, devicePrompt } = req.body;
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: 'Missing prompt in request body'
    });
  }

  // Check if we have an existing session for this call
  const existingSession = callId ? sessions.get(callId) : null;

  console.log(`[${timestamp}] QUERY: "${prompt.substring(0, 100)}..."`);
  console.log(`[${timestamp}] MODEL: ${CLAUDE_MODEL}`);
  console.log(`[${timestamp}] SESSION: callId=${callId || 'none'}, existing=${existingSession || 'none'}`);
  console.log(`[${timestamp}] DEVICE PROMPT: ${devicePrompt ? 'Yes (' + devicePrompt.substring(0, 30) + '...)' : 'No'}`);

  try {
    /**
     * Prompt layering order:
     * 1. Device prompt (if provided) - identity and available skills
     * 2. VOICE_CONTEXT - general voice call instructions
     * 3. User's prompt - what they actually said
     */
    let fullPrompt = '';

    if (devicePrompt) {
      fullPrompt += `[DEVICE IDENTITY]\n${devicePrompt}\n[END DEVICE IDENTITY]\n\n`;
    }

    fullPrompt += VOICE_CONTEXT;
    fullPrompt += prompt;

    const { code, stdout, stderr, duration_ms } = await runClaudeOnce({ fullPrompt, callId, timestamp });

    if (code !== 0) {
      console.error(`[${new Date().toISOString()}] ERROR: Claude CLI exited with code ${code}`);
      console.error(`STDERR: ${stderr}`);
      console.error(`STDOUT: ${stdout.substring(0, 500)}`);
      const errorMsg = stderr || stdout || `Exit code ${code}`;
      return res.json({ success: false, error: `Claude CLI failed: ${errorMsg}`, duration_ms });
    }

    const { response, sessionId } = parseClaudeStdout(stdout);

    if (sessionId && callId) {
      sessions.set(callId, sessionId);
      console.log(`[${new Date().toISOString()}] SESSION STORED: ${callId} -> ${sessionId}`);
    }

    console.log(`[${new Date().toISOString()}] RESPONSE (${duration_ms}ms): "${response.substring(0, 100)}..."`);

    res.json({ success: true, response, sessionId, duration_ms });

  } catch (error) {
    const duration_ms = Date.now() - startTime;
    console.error(`[${timestamp}] ERROR:`, error.message);

    res.json({
      success: false,
      error: error.message,
      duration_ms
    });
  }
});

/**
 * POST /ask-structured
 *
 * Like /ask, but returns machine-validated JSON for n8n automations.
 *
 * Request body:
 *   {
 *     "prompt": "Check Ceph health",
 *     "callId": "optional-call-uuid",
 *     "devicePrompt": "optional device-specific prompt",
 *     "schema": {
 *        "queryType": "ceph_health",
 *        "requiredFields": ["cluster_status","ssd_usage_percent","recommendation"],
 *        "fieldGuidance": { "cluster_status": "Ceph overall health, e.g. HEALTH_OK/HEALTH_WARN/HEALTH_ERR" },
 *        "allowExtraFields": true,
 *        "example": { "cluster_status": "HEALTH_WARN", "ssd_usage_percent": 88, "recommendation": "alert" }
 *     },
 *     "includeVoiceContext": false,
 *     "maxRetries": 1
 *   }
 *
 * Response (success):
 *   { "success": true, "data": {...}, "raw_response": "...", "duration_ms": 1234 }
 */
app.post('/ask-structured', async (req, res) => {
  const {
    prompt,
    callId,
    devicePrompt,
    schema = {},
    includeVoiceContext = false,
    maxRetries = 1,
  } = req.body || {};

  const timestamp = new Date().toISOString();

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt in request body' });
  }

  const queryContext = buildQueryContext({
    queryType: schema.queryType,
    requiredFields: schema.requiredFields,
    fieldGuidance: schema.fieldGuidance,
    allowExtraFields: schema.allowExtraFields !== false,
    example: schema.example,
  });

  let fullPrompt = buildStructuredPrompt({
    devicePrompt,
    queryContext: (includeVoiceContext ? VOICE_CONTEXT : '') + queryContext,
    userPrompt: prompt,
  });

  console.log(`[${timestamp}] STRUCTURED QUERY: "${String(prompt).substring(0, 100)}..."`);
  console.log(`[${timestamp}] MODEL: ${CLAUDE_MODEL}`);
  console.log(`[${timestamp}] SESSION: callId=${callId || 'none'}, existing=${callId ? (sessions.has(callId) ? 'yes' : 'no') : 'none'}`);

  try {
    let lastRaw = '';
    let lastError = 'Unknown error';
    let totalDuration = 0;
    const retries = Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 0;
    let attemptsMade = 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      attemptsMade = attempt + 1;
      const { code, stdout, stderr, duration_ms } = await runClaudeOnce({ fullPrompt, callId, timestamp });
      totalDuration += duration_ms;

      if (code !== 0) {
        lastError = `Claude CLI failed: ${stderr}`;
        lastRaw = String(stdout || '').trim();
        return res.status(502).json({
          success: false,
          error: lastError,
          raw_response: lastRaw,
          duration_ms: totalDuration,
          attempts: attemptsMade,
        });
      }

      const { response, sessionId } = parseClaudeStdout(stdout);
      lastRaw = response;

      if (sessionId && callId) sessions.set(callId, sessionId);

      const parsed = tryParseJsonFromText(response);
      if (!parsed.ok) {
        lastError = parsed.error || 'Failed to parse JSON';
      } else {
        const validation = validateRequiredFields(parsed.data, schema.requiredFields);
        if (validation.ok) {
          return res.json({
            success: true,
            data: parsed.data,
            json_text: parsed.jsonText,
            raw_response: response,
            duration_ms: totalDuration,
            attempts: attemptsMade,
          });
        }
        lastError = validation.error || 'Validation failed';
      }

      if (attempt >= retries) break;

      // Retry once with a repair prompt that forces "JSON only" formatting.
      const repairPrompt = buildRepairPrompt({
        queryType: schema.queryType,
        requiredFields: schema.requiredFields,
        fieldGuidance: schema.fieldGuidance,
        allowExtraFields: schema.allowExtraFields !== false,
        originalUserPrompt: prompt,
        invalidAssistantOutput: lastRaw,
        example: schema.example,
      });

      fullPrompt = buildStructuredPrompt({
        devicePrompt,
        queryContext: includeVoiceContext ? VOICE_CONTEXT : '',
        userPrompt: repairPrompt,
      });
    }

    return res.status(422).json({
      success: false,
      error: lastError,
      raw_response: lastRaw,
      duration_ms: totalDuration,
      attempts: attemptsMade,
    });
  } catch (error) {
    console.error(`[${timestamp}] ERROR:`, error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /end-session
 *
 * Clean up session when a call ends
 *
 * Request body:
 *   { "callId": "call-uuid" }
 */
app.post('/end-session', (req, res) => {
  const { callId } = req.body;
  const timestamp = new Date().toISOString();

  if (callId && sessions.has(callId)) {
    sessions.delete(callId);
    console.log(`[${timestamp}] SESSION ENDED: ${callId}`);
  }

  res.json({ success: true });
});

// ============================================
// HOME-972: OUTBOUND CALL PROXY
// ============================================
//
// Capability: Ralph (and other agents) can trigger an outbound call to Jeff
// via the Pi voice-app. This endpoint proxies POST /outbound-call requests
// from x1pro consumers to the Pi voice-app at ai-phone:3000/api/outbound-call.
//
// WHY a proxy: consumers (mcp-telephony-server, ralph-supervisor, n8n)
// shouldn't need to know the Pi's network address or its API contract. They
// hit a stable x1pro endpoint and we forward.
//
// AUDIT TRAIL: every call attempt is logged to stdout AND appended to
// logs/outbound-calls.jsonl (mounted volume) so we have a persistent record
// of every outbound call. Required by Ralph escalation rules.
//
// Pi API contract (per voice-app/README-OUTBOUND.md):
//   POST http://ai-phone:3000/api/outbound-call
//   { to, message, mode: 'announce'|'conversation', device, callerId,
//     timeoutSeconds, webhookUrl }
//
// HARDENING (HOME-10759 / ADV-12713, desk "Option A-minimal" ruling on the two-voice review of
// the original proxy). This server listens on 0.0.0.0:3333 with no authentication, so:
//   1. OWNER ALLOWLIST. POST /outbound-call dials only numbers listed in OUTBOUND_ALLOWED_TO
//      (comma-separated E.164, exact match). Unset or blank = FAIL CLOSED: every call is refused.
//      A refused call is a 403 plus an audit line; it never reaches the voice-app.
//   2. GET proxies never relay a voice-app non-2xx. A Pi 404 would otherwise make THIS server
//      answer 404, indistinguishable from "this server has no such route" -- the fault that took
//      the phone-escalation monitors red. Every non-2xx and every network error is a 502.
//   3. A voice-app answer that is null / not JSON / not an object never throws (an unhandled
//      rejection in an async Express 4 handler can kill the process).
//   4. DUPLICATE-CALL GUARD. An ambiguous outcome (the request left, the answer did not come back
//      intact) is a 504 "status unknown", never a retry-inviting 502, and an identical call
//      (same to + message + normalised mode) inside OUTBOUND_DEDUPE_WINDOW_MS is not dialed again.
//
// Environment:
//   VOICE_APP_URL               Pi voice-app base URL            (default http://ai-phone:3000)
//   OUTBOUND_LOG_PATH           audit log (JSONL)                (default ./logs/outbound-calls.jsonl)
//   OUTBOUND_ALLOWED_TO         comma-separated E.164 allowlist  (default empty = refuse all calls)
//   OUTBOUND_DEDUPE_WINDOW_MS   duplicate-call window, 0 = off   (default 120000)
//   OUTBOUND_DEDUPE_MAX_ENTRIES live duplicate-guard entries     (default 500; full = 503, never evicts)
//   OUTBOUND_PI_TIMEOUT_MS      POST timeout to the voice-app    (default 15000)

/* global AbortSignal */
const VOICE_APP_URL = process.env.VOICE_APP_URL || 'http://ai-phone:3000';
const OUTBOUND_LOG_PATH =
  process.env.OUTBOUND_LOG_PATH ||
  path.join(__dirname, 'logs', 'outbound-calls.jsonl');

function envNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const OUTBOUND_PI_TIMEOUT_MS = envNonNegativeInt('OUTBOUND_PI_TIMEOUT_MS', 15000) || 15000;
const OUTBOUND_GET_TIMEOUT_MS = 10000;
const OUTBOUND_DEDUPE_WINDOW_MS = envNonNegativeInt('OUTBOUND_DEDUPE_WINDOW_MS', 120000);
// Bound on LIVE (unexpired or in-flight) entries. A full table REFUSES a new distinct call (503,
// nothing sent); it never evicts a live entry, because forgetting a call re-opens the duplicate window.
const OUTBOUND_DEDUPE_MAX_ENTRIES = envNonNegativeInt('OUTBOUND_DEDUPE_MAX_ENTRIES', 500) || 500;

// The allowlist is read once at startup: changing it is a deliberate restart, not a runtime
// request. Entries that are not well-formed E.164 can never match a validated `to`, so they are
// dropped (and counted in the startup warning below) rather than silently kept.
const OUTBOUND_ALLOWED_TO_RAW = String(process.env.OUTBOUND_ALLOWED_TO || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
// (isValidE164 is a function declaration below, so it is hoisted and safe to call here.)
const OUTBOUND_ALLOWED_TO = new Set(OUTBOUND_ALLOWED_TO_RAW.filter(isValidE164));

// Mode aliasing: HOME-972 task spec uses 'tts' / 'interactive', Pi voice-app
// uses 'announce' / 'conversation'. Accept both for ergonomics.
function normalizeMode(mode) {
  if (!mode) return 'announce';
  const m = String(mode).toLowerCase();
  if (m === 'tts' || m === 'announce') return 'announce';
  if (m === 'interactive' || m === 'conversation') return 'conversation';
  // Unknown mode: return null so caller emits a 400
  return null;
}

// E.164 validation: + followed by 8-15 digits. Strict enough to catch typos
// without being so strict it rejects valid international numbers.
function isValidE164(s) {
  return typeof s === 'string' && /^\+[1-9]\d{7,14}$/.test(s);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function appendOutboundLog(entry) {
  try {
    if (!fs.existsSync(path.dirname(OUTBOUND_LOG_PATH))) {
      fs.mkdirSync(path.dirname(OUTBOUND_LOG_PATH), { recursive: true });
    }
    fs.appendFileSync(OUTBOUND_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[outbound-call] audit log write failed: ${err.message}`);
  }
}

// Codes that prove the request never left this host (nothing was sent, so nothing can be ringing).
// ECONNRESET, aborts, timeouts and anything unrecognised are deliberately NOT here: after the
// request has been written, "I do not know" must be reported as "I do not know".
const NOT_SENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_INVALID_URL',
]);

function collectErrorCodes(err, out = [], depth = 0) {
  if (!err || depth > 4) return out;
  if (err.code) out.push(err.code);
  if (Array.isArray(err.errors)) err.errors.forEach((e) => collectErrorCodes(e, out, depth + 1));
  if (err.cause) collectErrorCodes(err.cause, out, depth + 1);
  return out;
}

function failedBeforeSend(err) {
  const codes = collectErrorCodes(err);
  return codes.length > 0 && codes.every((c) => NOT_SENT_ERROR_CODES.has(c));
}

// Duplicate-call guard. Key = sha256(to | message | normalised mode); value = the in-flight or
// finished OUTCOME of the first attempt. Only outcomes that may have placed a call are kept
// (success and "status unknown"): a definite failure never became a call, so the retry must dial.
// An entry is only ever removed by EXPIRY of a SETTLED entry or by a definite failure; it is never
// evicted to make room (see OUTBOUND_DEDUPE_MAX_ENTRIES) and never pruned while still in flight.
// The window is measured from the moment the first attempt SETTLED, not from when it started, so a
// slow call (up to OUTBOUND_PI_TIMEOUT_MS) cannot eat the protection it is supposed to provide.
const recentOutbound = new Map();

function dedupeKey(to, message, mode) {
  return crypto.createHash('sha256').update(`${to}\n${message}\n${mode}`).digest('hex');
}

function pruneRecentOutbound(now) {
  for (const [key, entry] of recentOutbound) {
    if (entry.settled && now - entry.settledAt > OUTBOUND_DEDUPE_WINDOW_MS) recentOutbound.delete(key);
  }
}

// Seconds until the first live entry expires (>= 1), for a Retry-After hint on a full table.
function secondsUntilRoom(now) {
  let soonest = OUTBOUND_DEDUPE_WINDOW_MS;
  for (const entry of recentOutbound.values()) {
    if (entry.settled) soonest = Math.min(soonest, Math.max(0, OUTBOUND_DEDUPE_WINDOW_MS - (now - entry.settledAt)));
  }
  return Math.max(1, Math.ceil(soonest / 1000));
}

/**
 * Send one call to the voice-app and classify the result. NEVER rejects: every path returns
 * { status, body, remember, piStatus, piCallId, piError, outcome } so the handler cannot throw.
 *
 *   queued          200  the voice-app accepted the call            remember (a call exists)
 *   rejected        4xx/5xx the voice-app gave a STRUCTURED non-acceptance  do not remember (no call)
 *   not_sent        502  the request never left this host           do not remember (no call)
 *   status_unknown  504  the request may have been delivered but we  remember (it may be ringing)
 *                        do not know the result (timeout, reset, or ANY answer we cannot read)
 */
async function dialVoiceApp(piPayload) {
  let piResponse;
  try {
    piResponse = await fetch(`${VOICE_APP_URL}/api/outbound-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(piPayload),
      // Default 15s: the Pi just enqueues; the call itself takes longer to ring.
      signal: AbortSignal.timeout(OUTBOUND_PI_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err.message || String(err);
    if (failedBeforeSend(err)) {
      return {
        status: 502,
        body: { success: false, error: `voice-app proxy failed: ${msg}` },
        remember: false, piStatus: null, piCallId: null, piError: msg, outcome: 'not_sent',
      };
    }
    return {
      status: 504,
      body: {
        success: false,
        error: `status unknown: the request may have reached the voice-app but no answer came back (${msg}); ` +
          'do not retry blindly, check GET /outbound-calls',
      },
      remember: true, piStatus: null, piCallId: null, piError: msg, outcome: 'status_unknown',
    };
  }

  let piResult = null;
  let parseError = null;
  try {
    piResult = await piResponse.json();
  } catch (err) {
    parseError = err.message || String(err);
  }

  if (parseError !== null || !isPlainObject(piResult)) {
    // The response arrived, so the request reached the voice-app; an answer we cannot read does not
    // prove no call was queued. That holds for a 2xx AND for a 4xx/5xx (a crash after enqueue, a
    // gateway error page): report "status unknown" and let the duplicate guard remember it. A
    // retry-inviting 502 here is how a phone rings twice.
    const why = parseError !== null ? `unparseable body (${parseError})` : 'body is not a JSON object';
    return {
      status: 504,
      body: {
        success: false,
        error: `status unknown: voice-app answered HTTP ${piResponse.status} but the ${why}; ` +
          'do not retry blindly, check GET /outbound-calls',
      },
      remember: true, piStatus: piResponse.status, piCallId: null, piError: why, outcome: 'status_unknown',
    };
  }

  if (!piResponse.ok || !piResult.success) {
    // The voice-app gave a structured answer that is not an acceptance: relay it as before.
    return {
      status: piResponse.status,
      body: piResult,
      remember: false, piStatus: piResponse.status, piCallId: piResult.callId || null,
      piError: piResult.error || 'unknown', outcome: 'rejected',
    };
  }

  return {
    status: 200,
    body: {
      success: true,
      callId: piResult.callId,
      status: piResult.status,
      message: piResult.message || 'Call initiated',
    },
    remember: true, piStatus: piResponse.status, piCallId: piResult.callId || null, piError: null, outcome: 'queued',
  };
}

/**
 * POST /outbound-call
 *
 * Trigger an outbound call to a phone number. Proxies to Pi voice-app.
 *
 * Request body:
 *   {
 *     "to": "+19033002001",        // E.164, required, must be on OUTBOUND_ALLOWED_TO (else 403)
 *     "message": "...",             // text to speak, required, max 1000 chars
 *     "mode": "tts"|"interactive"   // optional, default 'tts' (announce)
 *                                    // also accepts 'announce'|'conversation'
 *     "device": "Morpheus",         // optional device/voice
 *     "callerId": "+15551234567",   // optional caller ID
 *     "timeoutSeconds": 30,         // optional ring timeout
 *     "webhookUrl": "...",          // optional status webhook
 *     "triggeredBy": "ralph"        // optional string (400 if not a string; null = absent): who
 *                                   // triggered (audit; also forwarded to the voice-app, where an
 *                                   // allow-listed value implies requireAck)
 *     "requireAck": true|false      // optional: ask the listener to press 1 (HOME-10660)
 *   }
 *
 * Response:
 *   200 { success: true, callId, status, message }       call queued
 *   202 { success: true, callId, ..., deduplicated: true } identical call inside the window; not dialed again
 *   400 / 403 { success: false, error }                   malformed / destination not permitted
 *   502 { success: false, error }                         nothing was sent; safe to retry
 *   504 { success: false, error: 'status unknown ...' }   the call MAY be ringing; do not retry blindly
 */
app.post('/outbound-call', async (req, res) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const {
    to,
    message,
    mode,
    device,
    callerId,
    timeoutSeconds,
    webhookUrl,
    triggeredBy,
    requireAck,
  } = req.body || {};

  // ── Input validation ──────────────────────────────────────────────────
  if (!isValidE164(to)) {
    return res
      .status(400)
      .json({ success: false, error: 'Invalid phone number — must be E.164 format (+15551234567)' });
  }

  // ── Owner allowlist (before any other check: a refused number learns nothing) ──────────
  if (!OUTBOUND_ALLOWED_TO.has(to)) {
    const by = typeof triggeredBy === 'string' ? triggeredBy.slice(0, 80) : null;
    console.warn(
      `[${timestamp}] OUTBOUND CALL BLOCKED → ${to} not in OUTBOUND_ALLOWED_TO triggered_by=${by || 'unknown'}`
    );
    appendOutboundLog({
      timestamp,
      direction: 'outbound',
      to,
      blocked: 'to_not_in_allowlist',
      triggered_by: by,
      pi_status: null,
      pi_call_id: null,
      pi_error: null,
      duration_ms: Date.now() - startTime,
    });
    return res
      .status(403)
      .json({ success: false, error: 'Destination not permitted' });
  }

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, error: 'message is required (string)' });
  }
  if (message.length > 1000) {
    return res
      .status(400)
      .json({ success: false, error: `message too long (${message.length} > 1000 chars)` });
  }
  const normalizedMode = normalizeMode(mode);
  if (mode != null && normalizedMode === null) {
    return res
      .status(400)
      .json({ success: false, error: `Invalid mode: ${mode} (use tts|interactive)` });
  }

  // HOME-10660: requireAck is an explicit opt-in to the voice-app's "Press 1 to
  // acknowledge" prompt. A non-boolean must be rejected, not dropped: a caller that
  // asked for an acknowledgement would otherwise silently get a call without one.
  if (requireAck !== undefined && typeof requireAck !== 'boolean') {
    return res
      .status(400)
      .json({ success: false, error: 'requireAck must be a boolean' });
  }
  // HOME-10759 (desk ruling on the #5 review): triggeredBy is the escalation marker the
  // voice-app keys its "press 1" prompt on. A non-string value used to be silently dropped,
  // placing the call WITHOUT the marker; reject it for the same reason requireAck is rejected.
  // null is treated as absent (a caller serialising an unset field as null meant nothing).
  if (triggeredBy !== undefined && triggeredBy !== null && typeof triggeredBy !== 'string') {
    return res
      .status(400)
      .json({ success: false, error: 'triggeredBy must be a string' });
  }

  // ── Build Pi request ──────────────────────────────────────────────────
  const piPayload = {
    to,
    message,
    mode: normalizedMode,
  };
  if (device) piPayload.device = device;
  if (callerId) piPayload.callerId = callerId;
  if (typeof timeoutSeconds === 'number') piPayload.timeoutSeconds = timeoutSeconds;
  if (webhookUrl) piPayload.webhookUrl = webhookUrl;
  // HOME-10660: the voice-app asks the listener to press 1 only for calls that opt in
  // (requireAck:true, or a triggeredBy on its OUTBOUND_ACK_TRIGGERS allow-list, default
  // telegram-drainer-escalation). triggeredBy used to be logged here and dropped, so the
  // voice-app could not tell an escalation from any other call. false is forwarded too:
  // it is a decision that overrides an allow-listed triggeredBy.
  // Every string is forwarded (even ''): validation above accepts every string, so a silent drop
  // here would reintroduce the very bug the 400 closes. null/undefined are absent and not sent.
  if (typeof triggeredBy === 'string') piPayload.triggeredBy = triggeredBy;
  if (typeof requireAck === 'boolean') piPayload.requireAck = requireAck;

  // ── Duplicate-call guard ──────────────────────────────────────────────
  const key = OUTBOUND_DEDUPE_WINDOW_MS > 0 ? dedupeKey(to, message, normalizedMode) : null;
  if (key !== null) {
    pruneRecentOutbound(startTime);
    const prior = recentOutbound.get(key);
    if (!prior && recentOutbound.size >= OUTBOUND_DEDUPE_MAX_ENTRIES) {
      // Never evict a live entry to make room: refuse this NEW distinct call. Nothing was sent, so
      // it is safe to retry once an entry expires.
      const retryAfter = secondsUntilRoom(startTime);
      console.warn(`[${timestamp}] OUTBOUND CALL REFUSED → ${to} duplicate-guard table full (${recentOutbound.size} live)`);
      appendOutboundLog({
        timestamp,
        direction: 'outbound',
        to,
        blocked: 'dedupe_table_full',
        triggered_by: typeof triggeredBy === 'string' ? triggeredBy.slice(0, 80) : null,
        pi_status: null,
        pi_call_id: null,
        pi_error: null,
        duration_ms: Date.now() - startTime,
      });
      res.set('Retry-After', String(retryAfter));
      return res.status(503).json({
        success: false,
        error: 'Too many recent distinct outbound calls; nothing was sent',
        retry_after_s: retryAfter,
      });
    }
    if (prior) {
      const first = await prior.outcome;
      const durationMs = Date.now() - startTime;
      console.warn(
        `[${timestamp}] OUTBOUND CALL DUPLICATE → ${to} not dialed again; first attempt outcome=${first.outcome}`
      );
      appendOutboundLog({
        timestamp,
        direction: 'outbound',
        to,
        mode: normalizedMode,
        message_preview: message.slice(0, 80),
        triggered_by: typeof triggeredBy === 'string' ? triggeredBy.slice(0, 80) : null,
        deduplicated: true,
        first_outcome: first.outcome,
        pi_status: null,
        pi_call_id: first.piCallId,
        pi_error: null,
        duration_ms: durationMs,
      });
      if (first.status === 200) {
        return res.status(202).json({
          success: true,
          callId: first.body.callId,
          status: first.body.status,
          message: 'Duplicate of a call placed moments ago; not dialed again',
          deduplicated: true,
          duration_ms: durationMs,
        });
      }
      return res.status(first.status).json(Object.assign({}, first.body, { deduplicated: true }));
    }
  }

  console.log(
    `[${timestamp}] OUTBOUND CALL → ${to} mode=${normalizedMode} ` +
      `triggered_by=${triggeredBy || 'unknown'} (msg: ${message.slice(0, 60)}…)`
  );

  // ── Proxy to Pi ───────────────────────────────────────────────────────
  const outcomePromise = dialVoiceApp(piPayload);
  const entry = key !== null ? { at: startTime, settled: false, settledAt: null, outcome: outcomePromise } : null;
  if (entry) recentOutbound.set(key, entry);
  const result = await outcomePromise;
  if (entry) {
    entry.settled = true;
    entry.settledAt = Date.now();
    if (!result.remember && recentOutbound.get(key) === entry) recentOutbound.delete(key);
  }

  const durationMs = Date.now() - startTime;
  appendOutboundLog({
    timestamp,
    direction: 'outbound',
    to,
    mode: normalizedMode,
    message_preview: message.slice(0, 80),
    triggered_by: triggeredBy || null,
    pi_status: result.piStatus,
    pi_call_id: result.piCallId,
    pi_error: result.piError,
    outcome: result.outcome,
    duration_ms: durationMs,
  });

  if (result.outcome === 'queued') {
    console.log(
      `[${timestamp}] OUTBOUND CALL QUEUED → ${to} callId=${result.piCallId} (${durationMs}ms)`
    );
    return res.status(200).json(Object.assign({}, result.body, { duration_ms: durationMs }));
  }
  console.error(
    `[${timestamp}] OUTBOUND CALL ${result.outcome.toUpperCase()} → ${to}: ${result.piError} (${durationMs}ms)`
  );
  return res.status(result.status).json(result.body);
});

/**
 * Proxy a GET to the Pi voice-app. 2xx with a JSON object is relayed unchanged; EVERYTHING else
 * (any non-2xx including 404, a network error, a null / non-object / non-JSON body) is a 502, so
 * a 404 from this server can only ever mean "this server has no such route". A relayed 2xx is always
 * answered 200 (a Pi 201/203/206 is not passed through): the contract is 200 or 502, nothing else.
 */
async function proxyVoiceAppGet(res, piPath) {
  try {
    const r = await fetch(`${VOICE_APP_URL}${piPath}`, {
      signal: AbortSignal.timeout(OUTBOUND_GET_TIMEOUT_MS),
    });
    if (!r.ok) {
      if (r.body) r.body.cancel().catch(() => {});
      return res.status(502).json({
        success: false,
        error: `voice-app proxy failed: voice-app answered HTTP ${r.status}`,
        voice_app_status: r.status,
      });
    }
    const result = await r.json();
    if (!isPlainObject(result)) {
      return res
        .status(502)
        .json({ success: false, error: 'voice-app proxy failed: voice-app body is not a JSON object' });
    }
    // Always 200: the contract is "200 or 502, never anything else", so a Pi 201/203/206 is not relayed as such.
    return res.status(200).json(result);
  } catch (err) {
    return res.status(502).json({ success: false, error: `voice-app proxy failed: ${err.message || String(err)}` });
  }
}

/**
 * GET /outbound-call/:callId
 * Proxy to Pi for call status lookup.
 */
app.get('/outbound-call/:callId', (req, res) =>
  proxyVoiceAppGet(res, `/api/call/${encodeURIComponent(req.params.callId)}`)
);

/**
 * GET /outbound-calls
 * Proxy to Pi for active call list.
 */
app.get('/outbound-calls', (req, res) => proxyVoiceAppGet(res, '/api/calls'));

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'claude-api-server',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /
 * Info endpoint
 */
app.get('/', (req, res) => {
  res.json({
    service: 'Claude HTTP API Server',
    version: '1.0.0',
    endpoints: {
      'POST /ask': 'Send a prompt to Claude',
      'POST /ask-structured': 'Send a prompt and return validated JSON (n8n)',
      'POST /outbound-call': 'Trigger outbound call via Pi voice-app (HOME-972)',
      'GET /outbound-call/:callId': 'Get outbound call status',
      'GET /outbound-calls': 'List active outbound calls',
      'GET /health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(64));
  console.log('Claude HTTP API Server');
  console.log('='.repeat(64));
  console.log(`\nListening on: http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  // HOME-10759: log the COUNT only, never the numbers.
  console.log(`Outbound-call allowlist: ${OUTBOUND_ALLOWED_TO.size} number(s); duplicate window ${OUTBOUND_DEDUPE_WINDOW_MS}ms`);
  if (OUTBOUND_ALLOWED_TO.size === 0) {
    console.warn('WARNING: OUTBOUND_ALLOWED_TO is unset/blank -> POST /outbound-call refuses EVERY call (fail closed)');
  }
  if (OUTBOUND_ALLOWED_TO_RAW.length !== OUTBOUND_ALLOWED_TO.size) {
    console.warn(`WARNING: ${OUTBOUND_ALLOWED_TO_RAW.length - OUTBOUND_ALLOWED_TO.size} OUTBOUND_ALLOWED_TO entr(ies) are not well-formed E.164 and were ignored`);
  }
  console.log('\nReady to receive Claude queries from voice interface.\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});
