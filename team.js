// =============================================================================
// team.js — ZINN Team Bio Retrieval Module
// Auto-discovers team members from zinn.ai/meet-the-zinn-team.
// Falls back to static JSON data if the website is unreachable.
// =============================================================================
'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const TEAM_PAGE_URL = 'https://www.zinn.ai/meet-the-zinn-team';
const FALLBACK_PATH = path.join(__dirname, 'team.json');

// ─── In-memory cache ───────────────────────────────────────────────────────

let cachedTeam = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Manual overrides (auto-discovery is primary) ─────────────────────────
// These override what would be inferred from the website. Add entries as
// needed, keyed by lowercase first name.

// Display names that differ from the page's raw <strong> text
const DISPLAY_NAME_OVERRIDES = {
  rob: 'Rob Zinn, AIA',
};

// Professional titles (not explicitly structured on the website page)
const TITLE_OVERRIDES = {
  kassia: 'President, Principal Design Lead',
  rob:    'Vice President, Principal in Charge',
  hannah: 'Interior Designer I',
  robin:  'Project Architect',
  daniel: 'Architectural Designer',
  abby:   'Architecture Intern',
  ryan:   'Business Development Representative',
};

// Email overrides (fallback is firstname@zinn.ai)
const EMAIL_OVERRIDES = {};

// Photo URL fallbacks (used when auto-extraction from page HTML fails)
const PHOTO_URL_FALLBACKS = {
  kassia: 'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/1cb7ba90-7db7-4844-8173-a6e5516a86ee/kassia-headshot-02.jpg?format=500w',
  rob:    'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/c7c391cf-f64e-404d-825e-36ef0d68dbfe/_rob_glasses_sm.jpg?format=500w',
  hannah: 'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/c1bef1e4-e4ba-4755-8eb8-c6e6b37a5ea2/hannah.jpg?format=500w',
  robin:  'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/9d7af6f9-97ea-4fc2-905c-651ac576b22d/robin.jpg?format=500w',
  daniel: 'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/67d99d44-fd23-4ace-8c72-b4a259568ffb/daniel-headshot.jpg?format=500w',
  abby:   'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/147e3a9b-8513-4173-b90a-2ca389e07dc1/abby-black_and_white.png?format=500w',
  ryan:   'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/f2b42a4a-c13d-4f76-892e-88c63769e34f/ryan_wills.jpg?format=500w',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Capitalize first letter of each word.
 */
function toTitleCase(str) {
  return str.replace(/\w\S*/g, function(t) {
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  });
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive a stable unique key from a team member's full name.
 * Uses the lowercase first-name portion.
 * @param {string} fullName - e.g. "Abby Labial"
 * @returns {string} e.g. "abby"
 */
function nameToKey(fullName) {
  return fullName.toLowerCase().split(/\s+/)[0];
}

// ─── HTML Parsing ──────────────────────────────────────────────────────────

/**
 * Extract bio text from an sqs-html-content block.
 * Handles two layouts:
 *   1. Name in first <p class="sqsrte-large">, bio in subsequent paragraphs.
 *   2. Name and bio together in one <p class="sqsrte-large"> (Hannah layout).
 * Strips HTML tags and returns joined text.
 * @param {string} block - Inner HTML of an sqs-html-content div
 * @param {string} nameToStrip - Name text to strip from paragraphs
 * @returns {string|null}
 */
function extractBioFromBlock(block, nameToStrip) {
  const paraPattern = /<p[^>]*class="[^"]*sqsrte-large[^"]*"[^>]*>(.*?)<\/p>/gi;
  const paragraphs = [];
  let paraMatch;
  let isFirst = true;
  while ((paraMatch = paraPattern.exec(block)) !== null) {
    var raw = paraMatch[1];

    // Clean HTML tags and entities from raw paragraph
    var clean = raw
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Strip name remnants
    if (nameToStrip) {
      clean = clean.replace(new RegExp(escapeRegex(nameToStrip), 'gi'), '').trim();
    }

    if (isFirst) {
      // First paragraph: remove the <strong>name</strong> portion from the RAW HTML,
      // then see if anything substantial remains (Hannah layout: name + bio in one <p>)
      var afterName = raw.replace(/<strong>.*?<\/strong>/i, '').trim();
      var afterNameClean = afterName
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,;.]+/, '')
        .trim();

      isFirst = false;

      // If the remaining content after the name has meaningful bio text, use it
      if (afterNameClean.length > 20) {
        if (nameToStrip) {
          afterNameClean = afterNameClean.replace(new RegExp(escapeRegex(nameToStrip), 'gi'), '').trim();
        }
        paragraphs.push(afterNameClean);
      }
      // Also add the full cleaned version if different (catches inline content)
      else if (clean.length > 20) {
        paragraphs.push(clean);
      }
    } else {
      // Subsequent paragraphs are pure bio text
      if (clean.length > 20) {
        paragraphs.push(clean);
      }
    }
  }

  return paragraphs.length > 0 ? paragraphs.join('\n\n') : null;
}



// ─── Main Fetch ────────────────────────────────────────────────────────────

/**
 * Fetch and auto-discover all team members from zinn.ai/meet-the-zinn-team.
 * Scans HTML for every <strong>name</strong> in an sqs-html-content div,
 * then extracts bio, photo, and applies overrides.
 * @returns {Promise<Array>} Array of { key, name, title, bio, photoUrl }
 */
async function fetchFromWebsite() {
  const resp = await fetch(TEAM_PAGE_URL, {
    headers: {
      'User-Agent': 'ZINN-Automation/1.0 (internal-service)',
      'Accept': 'text/html',
    },
    timeout: 10000,
  });

  if (!resp.ok) {
    throw new Error('HTTP ' + resp.status + ' fetching team page');
  }

  const html = await resp.text();

  // Scan all sqs-html-content divs for team member name headers
  const divPattern = /<div[^>]*class="[^"]*sqs-html-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const members = [];
  let divMatch;

  while ((divMatch = divPattern.exec(html)) !== null) {
    const block = divMatch[1];

    // Check if this block contains a team member name header.
    // Must be a <strong> name NOT wrapped in an <a> tag (filters out
    // service categories like "Commercial Architecture", "Pre-Sale Services").
    const nameMatch = block.match(
      /(?:^|[^a-zA-Z])<strong>\s*(.+?)\s*<\/strong>/i
    );
    if (!nameMatch) continue;

    // Verify the <strong> is NOT inside an <a> tag (service categories are linked)
    var nameHtml = nameMatch[0];
    if (/<a\s/.test(nameHtml)) continue;

    var rawName = nameMatch[1].trim().toLowerCase();
    // Reject names that don't look like actual people (e.g. "Commercial Architecture",
    // "Pre-Sale Services", or single words that aren't first+last)
    if (!rawName.includes(' ')) continue;
    // Reject names containing service/category keywords
    if (/\b(architecture|services|commercial|residential)\b/i.test(rawName)) continue;

    var key = nameToKey(rawName);

    // Build display name: use override if available, otherwise title-case
    var displayName = DISPLAY_NAME_OVERRIDES[key] || toTitleCase(rawName);

    // Extract bio from paragraph text in this block
    var bio = extractBioFromBlock(block, rawName);

    // Use known photo URLs (Squarespace layout makes auto-extraction unreliable)
    var photoUrl = PHOTO_URL_FALLBACKS[key] || null;

    // Apply overrides
    var title = TITLE_OVERRIDES[key] || '';
    var email = EMAIL_OVERRIDES[key] || (key + '@zinn.ai');

    members.push({
      key: key,
      name: displayName,
      title: title,
      bio: bio || null,
      photoUrl: photoUrl,
      email: email,
    });
  }

  if (members.length === 0) {
    throw new Error('No team members found on the team page');
  }

  if (members.every(function(m) { return !m.bio; })) {
    throw new Error('Failed to extract any bio text from team page');
  }

  return members;
}

/**
 * Load fallback data from static team.json or return empty array.
 * @returns {Array}
 */
function loadFallback() {
  try {
    if (fs.existsSync(FALLBACK_PATH)) {
      const data = JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8'));
      console.log('[shared/team] Loaded fallback from team.json');
      return data;
    }
  } catch (e) {
    console.error('[shared/team] Fallback load failed: ' + e.message);
  }
  console.log('[shared/team] No fallback data available');
  return [];
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get all team members.
 * Fetches from zinn.ai with fallback to cached/static data.
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] - Skip cache and re-fetch
 * @returns {Promise<Array>}
 */
async function getTeamMembers(opts) {
  opts = opts || {};
  const now = Date.now();

  // Return cached data if fresh enough
  if (!opts.forceRefresh && cachedTeam && (now - lastFetchTime) < CACHE_TTL_MS) {
    return cachedTeam;
  }

  // Try website fetch
  try {
    const members = await fetchFromWebsite();
    cachedTeam = members;
    lastFetchTime = now;
    console.log('[shared/team] Fetched fresh team bios from zinn.ai');
    return members;
  } catch (e) {
    console.error('[shared/team] Website fetch failed: ' + e.message);
  }

  // Fall back to cached data even if stale
  if (cachedTeam) {
    console.log('[shared/team] Returning stale cached team data');
    return cachedTeam;
  }

  // Fall back to static data
  cachedTeam = loadFallback();
  return cachedTeam;
}

/**
 * Get a single team member by key.
 * @param {string} key - Member key (e.g., 'rob', 'kassia')
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
async function getTeamMember(key, opts) {
  const members = await getTeamMembers(opts);
  return members.find(function(m) { return m.key === key; }) || null;
}

/**
 * Invalidate the in-memory cache so the next call re-fetches.
 */
function clearCache() {
  cachedTeam = null;
  lastFetchTime = 0;
}

/**
 * Build an HTML team bio block suitable for email embedding.
 * Returns an array of HTML strings (one per member) with headshot, name, and
 * the first sentence of their bio with an ellipsis and "read more" link to
 * https://www.zinn.ai/meet-the-zinn-team
 * @param {object} [opts]
 * @returns {Promise<string[]>}
 */
async function buildTeamBioHtmlBlock(opts) {
  const members = await getTeamMembers(opts);
  const TEAM_PAGE_LINK = 'https://www.zinn.ai/meet-the-zinn-team';
  return members.map(function(m) {
    var photoImg = m.photoUrl
      ? '<img src="' + m.photoUrl + '" alt="' + m.name + '" style="width:100px; height:100px; border-radius:50%; object-fit:cover; margin:0 auto 8px auto; display:block;">'
      : '';
    // Extract first sentence of bio
    var bioSnippet = '';
    if (m.bio) {
      var firstSentence = m.bio.match(/^.*?[\.!?](?:\s|$)/);
      var snippet = firstSentence ? firstSentence[0].trim() : '';
      if (snippet.length > 10) {
        bioSnippet = snippet + '.. <a href="' + TEAM_PAGE_LINK + '" style="color:#242C39;font-weight:600;text-decoration:underline;">read more</a>';
      }
    }
    return [
      '<div style="text-align:center; margin-bottom:24px; min-width:130px;">',
      '  ' + photoImg,
      '  <div style="font-weight:600; font-size:14px;">' + m.name + '</div>',
      '  <div style="font-size:12px; color:#666;">' + (m.title || '') + '</div>',
      bioSnippet ? '  <div style="font-size:12px; color:#444; margin-top:4px; line-height:1.4;">' + bioSnippet + '</div>' : '',
      '</div>'
    ].join('\n');
  });
}

// Trello member ID → email (for staff notifications, phase gate, etc.)
const TRELLO_ID_TO_EMAIL = {
  '5f84a8b7d1746581a597e28f': 'rob@zinn.ai',
  '5f84c9afd2273e1d31fceb93': 'kassia@zinn.ai',
  '664ca53f40650a918a45270a': 'hannah@zinn.ai',
  '65f1d66e561bf4af7889ccd6': 'robin@zinn.ai',
  '69d146103ea45591803e9703': 'daniel@zinn.ai',
  '6a270609bb018f2cc508171b': 'abby@zinn.ai',
};

// Trello member ID → display name
const TRELLO_ID_TO_NAME = {
  '5f84a8b7d1746581a597e28f': 'Rob Zinn',
  '5f84c9afd2273e1d31fceb93': 'Kassia Zinn',
  '664ca53f40650a918a45270a': 'Hannah Jensen',
  '65f1d66e561bf4af7889ccd6': 'Robin Tuazon',
  '69d146103ea45591803e9703': 'Daniel Paul',
  '6a270609bb018f2cc508171b': 'Abby Labial',
};

/**
 * Get email address for a Trello member ID.
 * @param {string} trelloMemberId
 * @returns {string|null}
 */
function getEmailByTrelloId(trelloMemberId) {
  return TRELLO_ID_TO_EMAIL[trelloMemberId] || null;
}

/**
 * Get display name for a Trello member ID.
 * @param {string} trelloMemberId
 * @returns {string|null}
 */
function getNameByTrelloId(trelloMemberId) {
  return TRELLO_ID_TO_NAME[trelloMemberId] || null;
}

module.exports = {
  getTeamMembers: getTeamMembers,
  getTeamMember: getTeamMember,
  clearCache: clearCache,
  buildTeamBioHtmlBlock: buildTeamBioHtmlBlock,
  getEmailByTrelloId: getEmailByTrelloId,
  getNameByTrelloId: getNameByTrelloId,
};

module.exports.VERSION = '1.0.0';
