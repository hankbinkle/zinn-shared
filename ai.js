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

  const payload = {
    model: model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: message },
    ],
    temperature: temperature,
    max_tokens: maxTokens,
  };

  // -- Backend 1: DeepSeek API (direct) ------------------------------------
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
      console.log('[shared/ai] DeepSeek failed: ' + e.message + '. Trying OpenAI...');
    }
  }

  // -- Backend 2: OpenAI API (fallback) ------------------------------------
  if (OPENAI_KEY) {
    try {
      console.log('[shared/ai] Calling OpenAI API');
      payload.model = model.replace(/^deepseek\/deepseek/, 'gpt-4o-mini');
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
      console.log('[shared/ai] OpenAI failed: ' + e.message);
    }
  }

  // -- Backend 3: RH Gateway proxy (future) --------------------------------
  // TODO: Add Howard proxy endpoint. Currently blocked on:
  //   - admin-http-rpc lacks a chat/completions method
  //   - Need a custom proxy endpoint on Railway Howard
  //   - SRM issue #1 tracks this

  throw new Error(
    'No AI backend available. Set DEEPSEEK_API_KEY or OPENAI_API_KEY ' +
    'on the calling service\'s Railway env vars.'
  );
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

module.exports = {
  callAI: callAI,
  extractJSON: extractJSON,
  VERSION: '2.0.0',
};
