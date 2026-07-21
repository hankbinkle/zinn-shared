// =============================================================================
// slug.js — Shared slugify utility for ZINN Railway services
// Single source of truth for project name slug generation.
// =============================================================================
'use strict';

/**
 * Convert a project name to a Dropbox-safe slug.
 * Lowercase, non-alphanumeric to underscore, trimmed, max 60 chars.
 * @param {string} name - Project name (e.g., "Allen Residence - New Build")
 * @returns {string} Slug (e.g., "allen_residence_new_build")
 */
/**
 * Convert a project name to a Dropbox-safe slug.
 * Preserves hyphens that are part of the name (e.g., "Cantor-Wilson" preserves its hyphen).
 * Converts " - " separators to singular "-".
 * All remaining spaces become underscores.
 * @param {string} name - Project name (e.g., "Cantor-Wilson Pre Design")
 * @returns {string} Slug (e.g., "cantor-wilson_pre_design")
 */
function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/ - | -|- /g, '-')    // " - " separator → hyphen
    .replace(/[^a-z0-9-]+/g, '_')  // remaining non-alnum (except hyphen) → underscore
    .replace(/_+/g, '_')            // collapse multiple underscores
    .replace(/^[-_]+|[-_]+$/g, '') // trim leading/trailing
    .slice(0, 60);
}

module.exports = {
  slugify,
};

module.exports.VERSION = '1.0.0';
