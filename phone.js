// =============================================================================
// phone.js — Centralized phone number formatting for ZINN Railway services
// Single source of truth for the platform-wide phone standard: NNN-NNN-NNNN
// =============================================================================
'use strict';

/**
 * Format any US phone input to the ZINN standard NNN-NNN-NNNN.
 * Accepts bare digits, dashes, dots, parens, spaces, +1 / 1 prefix, extensions.
 * @param {string|number} input - Raw phone value
 * @returns {string} Formatted phone, or the trimmed original if not parseable
 */
function formatPhone(input) {
  if (input === null || input === undefined) return '';
  const raw = String(input).trim();
  if (!raw) return '';

  // Strip extension suffix (e.g. "9045551212 ext 42")
  const noExt = raw.replace(/(?:\s*(?:ext|x)\s*\.?\s*\d{1,5})$/i, '');

  // Strip everything except digits
  let digits = noExt.replace(/\D/g, '');

  // Drop US country code prefix (11 digits starting with 1)
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);

  if (digits.length !== 10) return raw; // not a standard US 10-digit number

  return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
}

/**
 * True if a line/string looks like a phone number.
 * Matches formatted numbers AND bare digit runs of 7+ digits (the
 * "9046695787" case that leaked into greetings).
 * @param {string} line
 * @returns {boolean}
 */
function isPhone(line) {
  if (!line) return false;
  const s = String(line).trim();
  if (!s) return false;
  // Extensions are phones too
  if (/(ext|x)\s*\.?\s*\d{1,5}$/i.test(s)) return true;
  // Formatted 10-digit (with separators) or bare 7+ digit run
  if (/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(s)) return true;
  if (/\d{7,}/.test(s)) return true;
  return false;
}

/**
 * Extract the first phone number from a block of text and format it.
 * @param {string} text
 * @returns {string} Formatted phone or ''
 */
function extractPhone(text) {
  if (!text) return '';
  // Find candidate lines containing digits, prefer formatted/longer first
  const candidates = String(text).split('\n')
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
    .filter(isPhone);
  for (const c of candidates) {
    const formatted = formatPhone(c);
    if (formatted && /^\d{3}-\d{3}-\d{4}$/.test(formatted)) return formatted;
  }
  return '';
}

/**
 * Normalize every phone number found in a text block.
 * Used by the lead parser so phones are correct from the moment a card is born.
 * @param {string} text
 * @returns {string} Text with each phone line replaced by its NNN-NNN-NNNN form
 */
function normalizePhones(text) {
  if (!text) return text;
  return String(text).split('\n').map(function(l) {
    const trimmed = l.replace(/^[-*•]\s*/, '').trim();
    if (isPhone(trimmed)) {
      const formatted = formatPhone(trimmed);
      if (formatted && /^\d{3}-\d{3}-\d{4}$/.test(formatted)) return formatted;
    }
    return l;
  }).join('\n');
}

module.exports = {
  formatPhone,
  isPhone,
  extractPhone,
  normalizePhones,
};
