// =============================================================================
// data.js — Shared data utilities for ZINN Railway services
// Template helpers, HTML escaping, file parsing, amount normalization.
// =============================================================================
'use strict';

/**
 * HTML-escape a string (safe for injection into HTML/XML contexts).
 * @param {*} str
 * @returns {string}
 */

/**
 * Check if a value is truthy (Yes/yes/YES/true).
 * @param {*} val
 * @returns {boolean}
 */
function isYes(val) {
  return val === 'yes' || val === 'Yes' || val === 'YES' || val === true;
}

function esc(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fill {{VARIABLE}} placeholders in a template string.
 * Safe for simple key-value replacement; keys must be {{...}}-wrapped.
 *
 * @param {string} template — HTML/text with {{KEY}} placeholders
 * @param {object} vars     — { key: value, ... } (keys matched case-sensitively)
 * @returns {string}
 */
function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(key).join(value != null ? String(value) : '');
  }
  return result;
}

/**
 * Load and parse a Markdown file with YAML-like front matter.
 * Front matter is the block between the first pair of `---` lines.
 * Returns an object with front-matter keys + the raw body content.
 *
 * Supports:
 *   key: value
 *   key: "quoted value"   # trailing comment
 *   key: |                # multiline (lines starting with -)
 *     - item 1
 *     - item 2
 *
 * @param {string} filePath
 * @returns {object|null} { frontMatter: {}, body: string } or null if not found
 */
function loadFrontMatter(filePath) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;

  const lines = m[1].split('\n');
  const frontMatter = {};
  let multiKey = null;
  let multiLines = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // If inside multiline block, collect lines
    if (multiKey) {
      if (trimmed.startsWith('-') || trimmed.startsWith('  -') || trimmed.startsWith('  ')) {
        multiLines.push(trimmed);
        continue;
      } else {
        // End of multiline block
        frontMatter[multiKey] = multiLines.join('\n');
        multiKey = null;
        multiLines = [];
        // Fall through to process line as new key
      }
    }

    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    if (val === '|' || val === '>') {
      multiKey = key;
      multiLines = [];
      continue;
    }

    val = val.replace(/^["']|["']$/g, '').trim();
    const commentIdx = val.lastIndexOf(' #');
    if (commentIdx > 0) val = val.slice(0, commentIdx).trim();
    val = val.replace(/^["']|["']$/g, '').trim();

    if (key) frontMatter[key] = val || '';
  }

  if (multiKey) {
    frontMatter[multiKey] = multiLines.join('\n');
  }

  const bodyStart = m[0].length;
  const body = raw.slice(bodyStart).trim();

  return { frontMatter, body };
}

/**
 * Normalize a dollar amount string to standard "$X,XXX.XX" format.
 * Handles negative values (returns "-$X,XXX.XX").
 * @param {string} raw — e.g. "$1,234.56", "$1000", "-$500"
 * @returns {string}
 */
function normalizeAmount(raw) {
  if (!raw) return '';
  const s = raw.replace(/[$,]/g, '').trim();
  const n = parseFloat(s);
  if (isNaN(n)) return raw;
  const formatted = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-$${formatted}` : `$${formatted}`;
}

/**
 * Parse fee lines from a Trello card Fee section.
 * Handles three formats:
 *   description: $1,234.00                         → required static line
 *   description (optional): $1,234.00              → optional checkbox line
 *   description: $1,000, $2,000, $3,000            → tiered (basic/standard/premium)
 *   description (optional): $1,000, $2,000, $3,000 → tiered optional
 *
 * @param {string} text — raw fee section text
 * @returns {Array<object>} fee line objects
 */
function parseFeeLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim().replace(/^[•\-*]\s*/, '');
    if (!trimmed) continue;

    const m = trimmed.match(/^(.*?):\s*(.+)$/);
    if (!m) continue;

    const rawDesc = m[1].trim();
    const amountRaw = m[2].trim();

    // Check for tiered: three comma-separated amounts
    const tieredMatch = amountRaw.match(
      /^(-?\$?[\d,]+(?:\.\d{2})?)\s*,\s*(-?\$?[\d,]+(?:\.\d{2})?)\s*,\s*(-?\$?[\d,]+(?:\.\d{2})?)$/
    );
    if (tieredMatch) {
      const tiers = [
        normalizeAmount(tieredMatch[1]),
        normalizeAmount(tieredMatch[2]),
        normalizeAmount(tieredMatch[3]),
      ];
      const subMatch = rawDesc.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      const desc = subMatch ? subMatch[1].trim() : rawDesc;
      const subNote = subMatch ? subMatch[2].trim() : '';
      const optional = /optional/i.test(desc) || /optional/i.test(subNote);
      result.push({
        desc: desc.replace(/^optional[:\s-]*/i, '').trim(),
        subNote,
        tiers,
        optional,
        type: 'tiered',
      });
      continue;
    }

    // Standard single-amount line
    const normalizedAmt = normalizeAmount(amountRaw);
    const subMatch = rawDesc.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    let desc = subMatch ? subMatch[1].trim() : rawDesc;
    let subNote = subMatch ? subMatch[2].trim() : '';
    const optional = /optional/i.test(desc) || /optional/i.test(subNote);
    desc = desc.replace(/^optional[:\s-]*/i, '').trim();
    subNote = subNote.replace(/^optional[:\s-]*/i, '').trim();

    if (desc) {
      result.push({
        desc,
        subNote,
        amount: normalizedAmt,
        optional,
        type: optional ? 'optional' : 'required',
      });
    }
  }

  return result;
}

module.exports = {
  isYes,
  esc,
  fillTemplate,
  loadFrontMatter,
  normalizeAmount,
  parseFeeLines,
};

module.exports.VERSION = '1.0.0';
