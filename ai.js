// =============================================================================
// ai.js -- Shared AI module for ZINN Railway services
// General-purpose AI caller with backend fallback chain.
// Registered with shared_resource_manager.
//
// Backends (tried in order):
//   1. DeepSeek API (direct) -- primary, matches default gateway model
//   2. OpenAI API (direct) -- fallback when DeepSeek unavailable
//   3. RH Gateway (custom proxy) -- FUTURE, once Howard exposes an endpoint
//
// Any skill can import and call AI without duplicating HTTP/auth/retry logic:
//   const ai = require('../_shared/ai');
//   const result = await ai.callAI({ system, message });
// =============================================================================
'use strict';

const https = require('https');

// -------------------------------------------------------------------------
// Configuration (env var fallbacks)
// -------------------------------------------------------------------------

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek/deepseek-v4-flash';

// -------------------------------------------------------------------------
// Low-Level HTTPS POST
// -------------------------------------------------------------------------

function httpsPost(url, headers, body) {
  return new Promise(function(resolve, reject) {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: headers,
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode !== 200) {
          reject(new Error('AI HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('AI JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Call an AI model with system prompt and user message.
 * Tries backends in order: DeepSeek -> OpenAI.
 *
 * @param {object} opts
 * @param {string} opts.system - System prompt (role: system)
 * @param {string} opts.message - User message (role: user)
 * @param {number} [opts.temperature=0.1] - Model temperature
 * @param {number} [opts.maxTokens=4000] - Max output tokens
 * @param {string} [opts.model] - Model override
 * @returns {Promise<{content: string, model: string, backend: string}>}
 */
async function callAI(opts) {
  const system = opts.system || 'You are a helpful ZINN Architecture AI assistant.';
  const message = opts.message || '';
  const temperature = opts.temperature !== undefined ? opts.temperature : 0.1;
  const maxTokens = opts.maxTokens || 4000;
  const model = opts.model || DEFAULT_MODEL;

  // Strip OpenClaw-style provider prefix (deepseek/ -> deepseek-v4-flash)
  const cleanModel = model.replace(/^[a-z]+\//, '');
  const payload = {
    model: cleanModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: message },
    ],
    temperature: temperature,
    max_tokens: maxTokens,
  };

  // -- Backend 1: DeepSeek API (direct) ------------------------------------
  var lastError = null;
  if (DEEPSEEK_KEY) {
    try {
      console.log('[shared/ai] Calling DeepSeek API (' + model + ')');
      const res = await httpsPost(
        'https://api.deepseek.com/chat/completions',
        {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_KEY,
        },
        JSON.stringify(payload)
      );
      const content = extractContent(res);
      if (content) return { content: content, model: model, backend: 'deepseek' };
    } catch (e) {
      lastError = e;
      console.log('[shared/ai] DeepSeek failed: ' + e.message + '. Trying OpenAI...');
    }
  }

  // -- Backend 2: OpenAI API (fallback) ------------------------------------
  if (OPENAI_KEY) {
    try {
      console.log('[shared/ai] Calling OpenAI API');
      payload.model = 'gpt-4o-mini';
      const res = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENAI_KEY,
        },
        JSON.stringify(payload)
      );
      const content = extractContent(res);
      if (content) return { content: content, model: payload.model, backend: 'openai' };
    } catch (e) {
      lastError = e;
      console.log('[shared/ai] OpenAI failed: ' + e.message);
    }
  }

  // -- Backend 3: RH Gateway proxy (future) --------------------------------
  // TODO: Add Howard proxy endpoint. Currently blocked on:
  //   - admin-http-rpc lacks a chat/completions method
  //   - Need a custom proxy endpoint on Railway Howard
  //   - SRM issue #1 tracks this

  throw new Error(friendlyMessage(lastError));
}

/**
 * Extract text content from an OpenAI-compatible chat completions response.
 */
function extractContent(res) {
  if (!res || !res.choices || !res.choices[0]) return null;
  const msg = res.choices[0].message;
  return msg && msg.content ? msg.content : null;
}

/**
 * Extract JSON object from AI response text (handles markdown code fences).
 */
function extractJSON(text) {
  if (!text) return null;
  // bare JSON
  try { return JSON.parse(text); } catch (_) {}
  // markdown code fence
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch (_) {} }
  // first { ... } block
  const m2 = text.match(/\{[\s\S]*\}/);
  if (m2) { try { return JSON.parse(m2[0]); } catch (_) {} }
  return null;
}

/**
 * Turn a raw backend error into plain language a human can understand.
 * The technical details stay in the logs; the person reading the alert
 * gets a simple explanation instead of jargon.
 */
function friendlyMessage(err) {
  // No key was ever set up.
  if (!err) {
    return 'The AI helper is missing its secret key, so it cannot talk to ' +
      'the AI service. Please ask the person who runs the computers to add ' +
      'the key, then try again.';
  }
  var msg = err.message || String(err);

  // Can't reach the AI service at all (network / DNS problems).
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) {
    return 'We could not reach the AI service at all - the internet ' +
      'connection may have hiccupped. Please try again in a few minutes.';
  }

  // The AI service answered, but not happily.
  var m = msg.match(/AI HTTP (\d+)/);
  if (m) {
    var code = parseInt(m[1], 10);
    if (code === 401) {
      return 'The AI service said our secret key is wrong or out of date. ' +
        'Please ask the person who runs the computers to check the key.';
    }
    if (code === 402) {
      return 'The AI service says our account has run out of credit. ' +
        'Please ask the person who pays the bills to top it up.';
    }
    if (code === 429) {
      return 'The AI service is too busy right now and asked us to try ' +
        'again later. Please try again in a few minutes.';
    }
    if (code >= 500) {
      return 'The AI service is having problems on its end right now. ' +
        'Please try again in a few minutes.';
    }
    return 'The AI service answered with an unexpected response ' +
      '(code ' + code + '). Please try again in a few minutes.';
  }

  // The answer came back but we could not read it.
  if (/JSON parse|Unexpected token|AI JSON/i.test(msg)) {
    return 'The AI service sent back an answer we could not read. ' +
      'Please try again in a few minutes.';
  }

  // Anything else: keep it simple, technical detail goes to the logs.
  return 'Something went wrong while talking to the AI service. ' +
    'Please try again in a few minutes.';
}

module.exports = {
  callAI: callAI,
  extractJSON: extractJSON,
  VERSION: '2.0.0',
};
