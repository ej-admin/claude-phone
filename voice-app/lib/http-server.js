/**
 * HTTP Server for TTS Audio Delivery
 *
 * Express server that:
 * 1. Serves generated TTS audio files to FreeSWITCH
 * 2. Provides health check endpoint
 * 3. Accepts audio uploads and returns playback URLs
 * 4. Automatically cleans up old temporary files
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const debug = require('debug')('voice-app:http-server');
const crypto = require('crypto');
const logger = require('./logger');
const security = require('./api-security');

// Cleanup interval: every 2 minutes
const CLEANUP_INTERVAL = 120000;
// File max age: 10 minutes
const FILE_MAX_AGE = 600000;

/**
 * Create HTTP Server
 *
 * @param {string} audioDir - Directory to serve audio files from
 * @param {number} port - Port to listen on (default: 3000)
 * @param {Object} [options]
 * @param {Object} [options.env] - environment to read CLAUDE_API_KEY from (default: process.env)
 * @param {Function} [options.isLocalRequest] - "is this request from this host" (default: loopback peer);
 *   injectable so a test can stand in for a remote peer
 * @returns {Object} { app, server, saveAudio, getAudioUrl, close, finalize }
 */
function createHttpServer(audioDir, port = 3000, options = {}) {
  const app = express();

  // HOME-11645: authenticate EVERY route (X-Claude-Api-Key) except GET/HEAD /health and FreeSWITCH's own
  // loopback fetches of generated audio. Mounted first: before the body parser, so an unauthenticated
  // caller never reaches it, and before every route (including ones added later by index.js and routes
  // that do not exist), so there is no path that is routable but unguarded.
  const keyResult = security.loadApiKey(options.env || process.env);
  if (!keyResult.ok) {
    // Locked, not crashed: this process is also the SIP endpoint, and a missing env var must not take
    // inbound calls down. Every API call is a 401 until the key is set, and this line says why.
    logger.error('voice-app HTTP API is LOCKED (every route except /health answers 401): ' + keyResult.error);
  }
  app.use(security.createAuthMiddleware({
    key: keyResult.ok ? keyResult.key : null,
    isLocalRequest: options.isLocalRequest,
    onDenied: function(info) {
      logger.warn('HTTP API request denied (401)', info);
    }
  }));

  // Parse JSON bodies
  app.use(express.json());

  // Parse binary bodies for audio upload
  app.use('/audio', express.raw({ type: 'audio/*', limit: '10mb' }));

  // Serve static audio files
  app.use('/audio-files', express.static(audioDir, {
    setHeaders: (res, filepath) => {
      // Set appropriate content type for audio files
      if (filepath.endsWith('.wav')) {
        res.setHeader('Content-Type', 'audio/wav');
      } else if (filepath.endsWith('.mp3')) {
        res.setHeader('Content-Type', 'audio/mpeg');
      }
    }
  }));

  // Serve STATIC audio files (beeps, hold music) - NOT subject to cleanup
  app.use('/static', express.static(path.join(__dirname, '..', 'static'), {
    setHeaders: (res, filepath) => {
      if (filepath.endsWith('.wav')) {
        res.setHeader('Content-Type', 'audio/wav');
      } else if (filepath.endsWith('.mp3')) {
        res.setHeader('Content-Type', 'audio/mpeg');
      }
    }
  }));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      audioDir,
      port
    });
  });

  // Audio upload endpoint
  app.post("/audio", async (req, res) => {
    try {
      const audioBuffer = req.body;

      if (!audioBuffer || audioBuffer.length === 0) {
        return res.status(400).json({
          error: 'No audio data provided'
        });
      }

      // Generate unique filename
      const filename = `audio_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.wav`;
      const filepath = path.join(audioDir, filename);

      debug(`Saving audio to ${filepath} (${audioBuffer.length} bytes)`);

      // Save to disk
      await fs.writeFile(filepath, audioBuffer);

      // Generate URL
      const url = `http://localhost:${port}/audio-files/${filename}`;

      debug(`Audio saved, URL: ${url}`);

      res.json({
        success: true,
        url,
        filename,
        size: audioBuffer.length
      });

    } catch (error) {
      console.error('Error saving audio:', error);
      res.status(500).json({
        error: 'Failed to save audio',
        message: error.message
      });
    }
  });

  // NOTE: 404 and error handlers are added in finalize() AFTER additional routes

  // Start server
  const server = app.listen(port, () => {
    debug(`HTTP server listening on port ${port}`);
    debug(`Serving audio files from ${audioDir}`);
  });

  // Cleanup old files periodically
  const cleanupTimer = setInterval(async () => {
    try {
      await cleanupOldFiles(audioDir, FILE_MAX_AGE);
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }, CLEANUP_INTERVAL);

  // Cleanup on server close
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    debug('Stopping HTTP server');
    clearInterval(cleanupTimer);
    originalClose(callback);
  };

  /**
   * Save audio buffer to file and return URL
   * @param {Buffer} audioBuffer - Audio data
   * @param {string} format - File format (wav, mp3)
   * @returns {Promise<string>} URL to audio file
   */
  async function saveAudio(audioBuffer, format = 'wav') {
    const filename = `audio_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${format}`;
    const filepath = path.join(audioDir, filename);

    debug(`Saving ${format} audio to ${filepath} (${audioBuffer.length} bytes)`);

    await fs.writeFile(filepath, audioBuffer);

    const url = `http://localhost:${port}/audio-files/${filename}`;
    debug(`Audio saved, URL: ${url}`);

    return url;
  }

  /**
   * Get URL for a filename in audio directory
   * @param {string} filename - Name of audio file
   * @returns {string} Full URL
   */
  function getAudioUrl(filename) {
    return `http://localhost:${port}/audio-files/${filename}`;
  }

  /**
   * Finalize the Express app by adding 404 and error handlers
   * Call this AFTER adding any additional routes
   */
  function finalize() {
    // 404 handler
    app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        path: req.path
      });
    });

    // Error handler
    app.use((err, req, res, next) => {
      console.error('Server error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: err.message
      });
    });

    debug('HTTP server finalized with 404/error handlers');
  }

  return {
    app,
    server,
    saveAudio,
    getAudioUrl,
    close: () => server.close(),
    finalize
  };
}

/**
 * Cleanup files older than maxAge
 * @param {string} directory - Directory to clean
 * @param {number} maxAge - Max age in milliseconds
 */
async function cleanupOldFiles(directory, maxAge) {
  try {
    const files = await fs.readdir(directory);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filepath = path.join(directory, file);

      try {
        const stats = await fs.stat(filepath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          debug(`Deleting old file: ${file} (age: ${Math.round(age / 1000)}s)`);
          await fs.unlink(filepath);
          deletedCount++;
        }
      } catch (error) {
        // Skip files that can't be accessed
        debug(`Error checking file ${file}:`, error.message);
      }
    }

    if (deletedCount > 0) {
      debug(`Cleanup complete: deleted ${deletedCount} old files`);
    }

  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

module.exports = {
  createHttpServer,
  cleanupOldFiles
};
