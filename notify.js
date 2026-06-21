// =============================================================================
// notify.js — Centralized notification hub for ZINN Railway services
// Wraps email (Gmail draft) and Trello (card comment) into a single call.
// New notification channels added here, not scattered across skills.
// =============================================================================
'use strict';

const email = require('./email');
const trello = require('./trello');

/**
 * Send a notification across configured channels.
 * Always creates a Gmail draft to rob@zinn.ai.
 * Also posts a Trello card comment when cardId is provided.
 *
 * @param {object} opts
 * @param {string} opts.service   — Name of the service/reporting module (e.g. 'proposal_generator')
 * @param {string} opts.error     — Error or message text (plain text, newlines converted to <br> in email)
 * @param {string} [opts.cardName] — Human-friendly project name for subject line
 * @param {string} [opts.cardId]   — Trello card ID to also post a comment on
 * @param {boolean} [opts.send]    — true = send immediately, false/omit = create draft
 * @returns {Promise<{email: boolean, trello: boolean|null}>}
 */
async function notify(opts = {}) {
  const results = { email: false, trello: null };

  // ── Email (Gmail draft or send) ─────────────────────────────────────────
  try {
    results.email = await email.notifyOnFailure(opts);
  } catch (e) {
    console.error(`[shared/notify] Email notification failed: ${e.message}`);
  }

  // ── Trello card comment ─────────────────────────────────────────────────
  if (opts.cardId) {
    try {
      const msg = `[${opts.service}] ${opts.error}`;
      await trello.addCardComment(opts.cardId, msg);
      results.trello = true;
    } catch (e) {
      console.error(`[shared/notify] Trello comment failed: ${e.message}`);
      results.trello = false;
    }
  }

  return results;
}

module.exports = { notify };
module.exports.VERSION = '1.0.0';
