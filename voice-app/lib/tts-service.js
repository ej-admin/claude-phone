/**
 * ElevenLabs Text-to-Speech Service
 * Generates speech audio files and returns URLs for FreeSWITCH playback
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { resolveVoiceId } = require('./resolve-voice-id');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

const MODEL_ID = 'eleven_turbo_v2'; // Fast, low-latency model

// Audio output directory (set via setAudioDir)
let audioDir = path.join(__dirname, '../audio-temp');

/**
 * Set the audio output directory
 * @param {string} dir - Absolute path to audio directory
 */
function setAudioDir(dir) {
  audioDir = dir;

  // Create directory if it doesn't exist
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    logger.info('Created audio directory', { path: audioDir });
  }
}

/**
 * Generate unique filename for audio file
 * @param {string} text - Text being converted
 * @returns {string} Filename (without path)
 */
function generateFilename(text) {
  // Hash text to create unique identifier
  const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
  const timestamp = Date.now();
  return `tts-${timestamp}-${hash}.mp3`;
}

/**
 * Convert text to speech using ElevenLabs API
 * @param {string} text - Text to convert to speech
 * @param {string} voiceId - ElevenLabs voice ID (optional)
 * @returns {Promise<string>} HTTP URL to audio file
 */
async function generateSpeech(text, voiceId) {
  const startTime = Date.now();

  try {
    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY environment variable not set');
    }

    const resolvedVoiceId = resolveVoiceId(voiceId);

    logger.info('Generating speech with ElevenLabs', {
      textLength: text.length,
      voiceId: resolvedVoiceId,
      model: MODEL_ID
    });

    // Call ElevenLabs API
    const response = await axios({
      method: 'POST',
      url: `${ELEVENLABS_API_URL}/text-to-speech/${resolvedVoiceId}`,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      data: {
        text,
        model_id: MODEL_ID,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      },
      responseType: 'arraybuffer'
    });

    // Generate filename and save audio
    const filename = generateFilename(text);
    const filepath = path.join(audioDir, filename);

    fs.writeFileSync(filepath, response.data);

    const latency = Date.now() - startTime;
    const fileSize = response.data.length;

    logger.info('Speech generation successful', {
      filename,
      fileSize,
      latency,
      textLength: text.length
    });

    // Return HTTP URL (assumes audio-temp is served via HTTP)
    // Format: http://localhost:PORT/audio/filename.mp3
    // The HTTP server setup is handled elsewhere
    const audioUrl = `http://127.0.0.1:3000/audio-files/${filename}`;

    return audioUrl;

  } catch (error) {
    const latency = Date.now() - startTime;

    logger.error('Speech generation failed', {
      error: error.message,
      latency,
      textLength: text?.length,
      responseStatus: error.response?.status,
      responseData: error.response?.data?.toString()
    });

    // Handle specific errors
    if (error.response?.status === 401) {
      throw new Error('ElevenLabs API authentication failed - check API key');
    } else if (error.response?.status === 429) {
      throw new Error('ElevenLabs API rate limit exceeded');
    } else if (error.response?.status === 400) {
      throw new Error('Invalid request to ElevenLabs API');
    }

    throw new Error(`TTS generation failed: ${error.message}`);
  }
}

/**
 * Clean up old audio files (older than specified age)
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 */
function cleanupOldFiles(maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(audioDir);

    let deletedCount = 0;
    files.forEach(file => {
      if (!file.startsWith('tts-') || !file.endsWith('.mp3')) {
        return;
      }

      const filepath = path.join(audioDir, file);
      const stats = fs.statSync(filepath);
      const age = now - stats.mtimeMs;

      if (age > maxAgeMs) {
        fs.unlinkSync(filepath);
        deletedCount++;
      }
    });

    if (deletedCount > 0) {
      logger.info('Cleaned up old audio files', { deletedCount });
    }

  } catch (error) {
    logger.warn('Failed to cleanup old audio files', { error: error.message });
  }
}

/**
 * Get list of available ElevenLabs voices
 * @returns {Promise<Array>} Array of voice objects
 */
async function getAvailableVoices() {
  try {
    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY environment variable not set');
    }

    const response = await axios({
      method: 'GET',
      url: `${ELEVENLABS_API_URL}/voices`,
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });

    return response.data.voices;

  } catch (error) {
    logger.error('Failed to fetch available voices', { error: error.message });
    throw error;
  }
}

// Initialize audio directory
setAudioDir(audioDir);

// Setup periodic cleanup (every 30 minutes)
setInterval(() => {
  cleanupOldFiles();
}, 30 * 60 * 1000);

module.exports = {
  generateSpeech,
  setAudioDir,
  cleanupOldFiles,
  getAvailableVoices
};
