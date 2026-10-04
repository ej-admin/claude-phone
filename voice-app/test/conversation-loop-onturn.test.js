/**
 * HOME-10660 (item 4): OutboundSession.recordTurn() was defined but never called,
 * so conversationHistory/turnCount on GET /api/call/:id were always empty. The
 * conversation loop now reports each COMPLETED turn through an optional `onTurn`
 * callback, which the outbound route wires to session.recordTurn().
 *
 * The loop is driven with fakes for every dependency (endpoint, audio fork, Whisper,
 * Claude, TTS) -- no network, no media server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runConversationLoop } = require('../lib/conversation-loop');

// The loop's extractVoiceLine() prefers a "VOICE_RESPONSE:" line. U+FE0F is the
// emoji variation selector the production regex expects after the speaking-head glyph.
const voiceResponse = (text) => `\u{1F5E3}️ VOICE_RESPONSE: ${text}`;

function makeHarness({ transcripts, claudeReply }) {
  const endpoint = new EventEmitter();
  endpoint.uuid = 'fs-endpoint-1';
  endpoint.play = async () => {};
  endpoint.api = async () => ({});
  endpoint.forkAudioStart = async () => {};
  endpoint.forkAudioStop = async () => {};

  const dialog = new EventEmitter();

  const forkSession = {
    setCaptureEnabled() {},
    forceFinalize() {},
    waitForUtterance: async () => ({ audio: Buffer.alloc(8), reason: 'silence' })
  };

  let transcribeCalls = 0;
  const options = {
    audioForkServer: { expectSession: () => Promise.resolve(forkSession) },
    whisperClient: { transcribe: async () => transcripts[transcribeCalls++] },
    claudeBridge: { query: async () => claudeReply, endSession: async () => {} },
    ttsService: { generateSpeech: async () => 'http://127.0.0.1/audio/fake.mp3' },
    wsPort: 3001,
    skipGreeting: true,
    maxTurns: 5
  };

  return { endpoint, dialog, options, transcribeCount: () => transcribeCalls };
}

test('onTurn is called once per COMPLETED turn with (what the person said, what was spoken back)', async () => {
  const harness = makeHarness({
    transcripts: ['is the disk ok', 'goodbye'],
    claudeReply: voiceResponse('it is at ninety percent')
  });
  const turns = [];

  await runConversationLoop(harness.endpoint, harness.dialog, 'call-1', Object.assign({}, harness.options, {
    onTurn: (userText, assistantText) => turns.push([userText, assistantText])
  }));

  assert.deepEqual(
    turns,
    [['is the disk ok', 'it is at ninety percent']],
    'exactly one turn recorded: the goodbye turn gets no assistant reply, so it is not a completed turn'
  );
});

test('a throwing onTurn cannot kill the call (bookkeeping must never break a live conversation)', async () => {
  const harness = makeHarness({
    transcripts: ['is the disk ok', 'goodbye'],
    claudeReply: voiceResponse('it is at ninety percent')
  });

  await runConversationLoop(harness.endpoint, harness.dialog, 'call-2', Object.assign({}, harness.options, {
    onTurn: () => { throw new Error('history store exploded'); }
  }));

  assert.equal(harness.transcribeCount(), 2, 'the loop must carry on to the next turn (the goodbye) after onTurn threw');
});

test('onTurn is optional: the loop runs unchanged without it', async () => {
  const harness = makeHarness({
    transcripts: ['is the disk ok', 'goodbye'],
    claudeReply: voiceResponse('it is at ninety percent')
  });

  await runConversationLoop(harness.endpoint, harness.dialog, 'call-3', harness.options);

  assert.equal(harness.transcribeCount(), 2, 'both turns must run with no onTurn supplied (inbound calls pass none)');
});
