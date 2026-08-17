/**
 * HOME-5431 regression coverage: resolveVoiceId() must never let a sentinel
 * (null/undefined/''/'default'/'null') reach the ElevenLabs API. It must
 * prefer ELEVENLABS_VOICE_ID over any hardcoded id, and throw loudly when
 * neither a real voiceId nor a configured default is available.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// resolve-voice-id.js is a dependency-free pure module (no axios, no fs, no
// timers) deliberately split out of tts-service.js so this suite can test
// the HOME-5431 sentinel-resolution logic without pulling in tts-service's
// module-level side effects (network client, audio-dir creation, the
// 30-minute cleanup setInterval).
const { resolveVoiceId } = require('../lib/resolve-voice-id');

const ORIGINAL_ENV_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

function withEnvVoiceId(value, fn) {
  if (value === undefined) {
    delete process.env.ELEVENLABS_VOICE_ID;
  } else {
    process.env.ELEVENLABS_VOICE_ID = value;
  }
  try {
    return fn(resolveVoiceId);
  } finally {
    if (ORIGINAL_ENV_VOICE_ID === undefined) {
      delete process.env.ELEVENLABS_VOICE_ID;
    } else {
      process.env.ELEVENLABS_VOICE_ID = ORIGINAL_ENV_VOICE_ID;
    }
  }
}

test('resolveVoiceId passes through a real device-specific voice id unchanged', () => {
  withEnvVoiceId('some-configured-default', (resolveVoiceId) => {
    assert.equal(resolveVoiceId('hpp4J3VqNfWAUOO0d1Us'), 'hpp4J3VqNfWAUOO0d1Us');
  });
});

test('resolveVoiceId maps explicit null to the configured env default (the HOME-5431 bug path)', () => {
  withEnvVoiceId('hpp4J3VqNfWAUOO0d1Us', (resolveVoiceId) => {
    assert.equal(resolveVoiceId(null), 'hpp4J3VqNfWAUOO0d1Us');
  });
});

test('resolveVoiceId maps undefined to the configured env default', () => {
  withEnvVoiceId('hpp4J3VqNfWAUOO0d1Us', (resolveVoiceId) => {
    assert.equal(resolveVoiceId(undefined), 'hpp4J3VqNfWAUOO0d1Us');
  });
});

test('resolveVoiceId maps the string "default" sentinel to the configured env default', () => {
  withEnvVoiceId('hpp4J3VqNfWAUOO0d1Us', (resolveVoiceId) => {
    assert.equal(resolveVoiceId('default'), 'hpp4J3VqNfWAUOO0d1Us');
  });
});

test('resolveVoiceId maps the literal string "null" sentinel to the configured env default', () => {
  withEnvVoiceId('hpp4J3VqNfWAUOO0d1Us', (resolveVoiceId) => {
    assert.equal(resolveVoiceId('null'), 'hpp4J3VqNfWAUOO0d1Us');
  });
});

test('resolveVoiceId trims whitespace on the configured env default', () => {
  withEnvVoiceId('  hpp4J3VqNfWAUOO0d1Us  ', (resolveVoiceId) => {
    assert.equal(resolveVoiceId(null), 'hpp4J3VqNfWAUOO0d1Us');
  });
});

test('resolveVoiceId throws loudly when no voice is configured anywhere (never silently forwards null)', () => {
  withEnvVoiceId(undefined, (resolveVoiceId) => {
    assert.throws(() => resolveVoiceId(null), /HOME-5431/);
    assert.throws(() => resolveVoiceId(undefined), /HOME-5431/);
    assert.throws(() => resolveVoiceId('default'), /HOME-5431/);
  });
});

test('resolveVoiceId throws (not silently falls back) when env default is blank/whitespace-only', () => {
  withEnvVoiceId('   ', (resolveVoiceId) => {
    assert.throws(() => resolveVoiceId(null), /HOME-5431/);
  });
});
