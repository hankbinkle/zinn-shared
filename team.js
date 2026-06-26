// =============================================================================
// team.js — ZINN Team Bio Retrieval Module
// Dynamically fetches team member bios from zinn.ai/meet-the-zinn-team.
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

// ─── Known member keys and their display names ────────────────────────────

const MEMBER_KEYS = ['kassia', 'rob', 'hannah', 'robin', 'daniel'];

const MEMBER_NAMES = {
  kassia: 'Kassia Zinn',
  rob:    'Rob Zinn, AIA',
  hannah: 'Hannah Jensen',
  robin:  'Robin Tuazon',
  daniel: 'Daniel Paul',
};

// Names as they appear in zinn.ai HTML (simpler — no titles/credentials)
const SEARCH_NAMES = {
  kassia: 'kassia zinn',
  rob:    'rob zinn',
  hannah: 'hannah jensen',
  robin:  'robin tuazon',
  daniel: 'daniel paul',
};

const MEMBER_TITLES = {
  kassia: 'President, Principal Design Lead',
  rob:    'Vice President, Principal in Charge',
  hannah: 'Interior Designer I',
  robin:  'Project Architect',
  daniel: 'Architectural Designer',
};

// Member email addresses (TODO: replace with Directory API lookup)
const MEMBER_EMAILS = {
  kassia: 'kassia@zinn.ai',
  rob:    'rob@zinn.ai',
  hannah: 'hannah@zinn.ai',
  robin:  'robin@zinn.ai',
  daniel: 'daniel@zinn.ai',
};

// Known photo URLs (Squarespace CDN — stable, embedded in page HTML)
const PHOTO_URLS = {
  kassia: 'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/1cb7ba90-7db7-4844-8173-a6e5516a86ee/kassia-headshot-02.jpg?format=500w',
  rob:    'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/c7c391cf-f64e-404d-825e-36ef0d68dbfe/_rob_glasses_sm.jpg?format=500w',
  hannah: 'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/c1bef1e4-e4ba-4755-8eb8-c6e6b37a5ea2/hannah.jpg?format=500w',
  robin:  'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/9d7af6f9-97ea-4fc2-905c-651ac576b22d/robin.jpg?format=500w',
  daniel: 'https://images.squarespace-cdn.com/content/v1/5e67c2d2cd094e004e07ff41/67d99d44-fd23-4ace-8c72-b4a259568ffb/daniel-headshot.jpg?format=500w',
};

// ─── HTML Parsing ──────────────────────────────────────────────────────────

/**
 * Extract bio text for a team member from the zinn.ai page HTML.
 * @param {string} html - Full page HTML
 * @param {string} name - Name to search for (e.g. "kassia zinn")
 * @returns {string|null} Bio text or null
 */
function extractBio(html, name) {
  // Each team member lives in its own <div class="sqs-html-content">.
  // Find the div that contains this member's <strong>name</strong>,
  // then extract <p class="sqsrte-large"> paragraphs from within that div only.
  const divPattern = /<div[^>]*class="[^"]*sqs-html-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let divMatch;
  while ((divMatch = divPattern.exec(html)) !== null) {
    const block = divMatch[1];
    // Check if this block contains the name
    const nameInBlock = new RegExp(
      `<strong>\\s*${escapeRegex(name)}\\s*</strong>`,
      'i'
    );
    if (!nameInBlock.test(block)) continue;

    // Extract all sqsrte-large paragraphs within this div
    const paraPattern = /<p[^>]*class="[^"]*sqsrte-large[^"]*"[^>]*>(.*?)<\/p>/gi;
    const paragraphs = [];
    let paraMatch;
    while ((paraMatch = paraPattern.exec(block)) !== null) {
      let text = paraMatch[1]
        .replace(/<[^>]+>/g, '')       // strip HTML tags
        .replace(/&nbsp;/g, ' ')       // decode &nbsp;
        .replace(/&amp;/g, '&')        // decode &amp;
        .replace(/&lt;/g, '<')         // decode &lt;
        .replace(/&gt;/g, '>')         // decode &gt;
        .replace(/&[a-z]+;/g, ' ')     // strip other entities
        .replace(/\s+/g, ' ')          // collapse whitespace
        .trim();

      // Strip the name itself if it appears in this paragraph (e.g. Hannah's inline layout)
      text = text.replace(new RegExp(escapeRegex(name), 'gi'), '').trim();

      if (text.length > 20) {
        paragraphs.push(text);
      }
    }

    return paragraphs.length > 0 ? paragraphs.join('\n\n') : null;
  }

  return null;
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}



/**
 * Extract photo URL for a team member from the page HTML.
 * Photos are in <img data-src="..." > tags that appear before the name.
 */
function extractPhotoUrl(html, name) {
  const nameIdx = html.toLowerCase().indexOf(`<strong>${name.toLowerCase()}`);
  if (nameIdx < 0) return null;

  const before = html.slice(0, nameIdx);
  // Find the last data-src attribute before the name
  const srcMatch = before.match(/data-src="([^"]+)"(?:[^>]*>)?$/m);
  if (srcMatch) {
    const url = srcMatch[1];
    // Add format param if not present
    return url.includes('?') ? url : `${url}?format=500w`;
  }
  return null;
}

// ─── Main Fetch ────────────────────────────────────────────────────────────

/**
 * Fetch team member data from zinn.ai.
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
    throw new Error(`HTTP ${resp.status} fetching team page`);
  }

  const html = await resp.text();
  const members = [];

  for (const key of MEMBER_KEYS) {
    const searchName = SEARCH_NAMES[key];
    const bio = extractBio(html, searchName);
    // Use known photo URLs (page extraction unreliable due to Squarespace gallery layout)
    const photoUrl = PHOTO_URLS[key];
    members.push({
      key,
      name: MEMBER_NAMES[key],
      title: MEMBER_TITLES[key],
      bio: bio || null,
      photoUrl,
    });
  }

  if (members.every(m => !m.bio)) {
    throw new Error('Failed to extract any bio text from team page');
  }

  return members;
}

/**
 * Load fallback data from static team.json.
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
    console.error(`[shared/team] Fallback load failed: ${e.message}`);
  }
  // Ultimate fallback: return minimal data
  console.log('[shared/team] Using hardcoded minimal fallback');
  return MEMBER_KEYS.map(key => ({
    key,
    name: MEMBER_NAMES[key],
    title: MEMBER_TITLES[key],
    bio: null,
    photoUrl: PHOTO_URLS[key],
  }));
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get all team members.
 * Fetches from zinn.ai with fallback to cached/static data.
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] - Skip cache and re-fetch
 * @returns {Promise<Array>}
 */
async function getTeamMembers(opts = {}) {
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
    console.error(`[shared/team] Website fetch failed: ${e.message}`);
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
  return members.find(m => m.key === key) || null;
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
 * Returns an array of HTML strings (one per member) with headshot, name, and title.
 * No bio text — just headshot images and titles per Rob's direction.
 * @param {object} [opts]
 * @returns {Promise<string[]>}
 */
async function buildTeamBioHtmlBlock(opts) {
  const members = await getTeamMembers(opts);
  return members.map(m => {
    const photoImg = m.photoUrl
      ? `<img src="${m.photoUrl}" alt="${m.name}" style="width:100px; height:100px; border-radius:50%; object-fit:cover; margin:0 auto 8px auto; display:block;">`
      : '';
    return `
<div style="text-align:center; margin-bottom:24px; min-width:130px;">
  ${photoImg}
  <div style="font-weight:600; font-size:14px;">${m.name}</div>
  <div style="font-size:12px; color:#666;">${m.title}</div>
</div>`;
  });
}

// Trello member ID → email (for staff notifications, phase gate, etc.)
const TRELLO_ID_TO_EMAIL = {
  '5f84a8b7d1746581a597e28f': 'rob@zinn.ai',
  '5f84c9afd2273e1d31fceb93': 'kassia@zinn.ai',
  '664ca53f40650a918a45270a': 'hannah@zinn.ai',
  '65f1d66e561bf4af7889ccd6': 'robin@zinn.ai',
  '69d146103ea45591803e9703': 'daniel@zinn.ai',
};

/**
 * Get email address for a Trello member ID.
 * @param {string} trelloMemberId
 * @returns {string|null}
 */
function getEmailByTrelloId(trelloMemberId) {
  return TRELLO_ID_TO_EMAIL[trelloMemberId] || null;
}

module.exports = {
  getTeamMembers,
  getTeamMember,
  clearCache,
  buildTeamBioHtmlBlock,
  getEmailByTrelloId,
};

module.exports.VERSION = '1.0.0';
