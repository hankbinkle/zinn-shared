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
function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

module.exports = {
  slugify,
};

module.exports.VERSION = '1.0.0';
