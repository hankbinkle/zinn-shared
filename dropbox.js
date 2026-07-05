// =============================================================================
// dropbox.js — Shared Dropbox API module for ZINN Railway services
// Handles team-scoped token operations: OAuth refresh, team member lookup,
// file upload, shared link generation, and folder operations.
// =============================================================================
'use strict';

const https = require('https');
const fetch = require('node-fetch');
const { getStoredToken, storeToken, getSetting, setSetting } = require('./db');
const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_TEAM_MEMBER_EMAIL } = require('./config');

/**
 * Dropbox-safe HTTP request using https module (bypasses node-fetch Premature close issues on Railway).
 */
function dropboxFetch(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isContent = u.hostname === 'content.dropboxapi.com';
    const https = require('https');
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      rejectUnauthorized: true,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: function() { try { return JSON.parse(body); } catch(e) { return null; } },
          text: function() { return body; },
        });
      });
    });
    req.on('error', reject);
    if (opts.body) {
      if (typeof opts.body === 'string') req.write(opts.body);
      else req.write(JSON.stringify(opts.body));
    }
    req.end();
  });
}


const DROPBOX_API = 'https://api.dropboxapi.com';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com';

// ─── Token Management ─────────────────────────────────────────────────────

/**
 * Get a fresh Dropbox access token via OAuth refresh.
 * Checks DB cache first, then uses refresh token from DB or env var.
 * @returns {Promise<string|null>} Access token, or null if unavailable.
 */
async function getAccessToken() {
  try {
    // 1. Check DB for valid cached access token
    const cached = await getStoredToken('dropbox', 'access');
    if (cached && cached.expiresAt && Date.now() < cached.expiresAt - 60000) {
      console.log('[shared/dropbox] Using cached access token');
      return cached.value;
    }

    // 2. Get refresh token (DB first, then env var)
    let refreshToken = await getStoredToken('dropbox', 'refresh');
    if (!refreshToken) {
      const fromEnv = process.env.DROPBOX_REFRESH_TOKEN;
      if (fromEnv) {
        refreshToken = { value: fromEnv, expiresAt: null };
        await storeToken('dropbox', 'refresh', fromEnv, null);
      }
    }
    if (!refreshToken || !refreshToken.value) {
      console.error('[shared/dropbox] No refresh token available');
      return null;
    }

    // 3. Refresh (https module to avoid node-fetch transport issues)
    
    let data;
    try {
      data = await new Promise((resolve, reject) => {
        const bodyStr = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken.value) + '&client_id=' + encodeURIComponent(DROPBOX_APP_KEY) + '&client_secret=' + encodeURIComponent(DROPBOX_APP_SECRET);
        const req = require("https").request({
          hostname: 'api.dropboxapi.com',
          path: '/oauth2/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON: ' + body.slice(0,200))); }
          });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });
    } catch (httpErr) {
      console.error('[shared/dropbox] Token refresh HTTP error: ' + httpErr.message);
      return null;
    }
    if (!data.access_token) {
      console.error('[shared/dropbox] OAuth refresh failed: ' + (data.error_description || data.error || JSON.stringify(data)));
      return null;
    }
    console.log('[shared/dropbox] Got fresh access token via OAuth refresh (expires in ' + data.expires_in + 's)');

    // Store new access token
    await storeToken('dropbox', 'access', data.access_token, data.expires_in ? Date.now() + data.expires_in * 1000 : null);

    // Handle token rotation (Dropbox may issue a new refresh token)
    if (data.refresh_token) {
      await storeToken('dropbox', 'refresh', data.refresh_token, null);
    }

    return data.access_token;
  } catch (e) {
    console.error(`[shared/dropbox] Token refresh error: ${e.message}`);
    return null;
  }
}

/**
 * Get Rob's Dropbox team member ID for Dropbox-API-Select-User header.
 * Caches in memory after first lookup.
 * @param {string} token - Valid Dropbox access token
 * @returns {Promise<string|null>}
 */
let cachedMemberId = null;
async function getTeamMemberId(token) {
  if (cachedMemberId) return cachedMemberId;

  // Prefer env var
  if (process.env.DROPBOX_MEMBER_ID) {
    cachedMemberId = process.env.DROPBOX_MEMBER_ID;
    console.log(`[shared/dropbox] Using DROPBOX_MEMBER_ID from env: ${cachedMemberId}`);
    return cachedMemberId;
  }

  try {
    const res = await dropboxFetch(`${DROPBOX_API}/2/team/members/get_info`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      // Bare JSON array per Dropbox API — NOT wrapped in { members: [...] }
      body: JSON.stringify({ members: [{ '.tag': 'email', email: DROPBOX_TEAM_MEMBER_EMAIL }] }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`[shared/dropbox] team/members/get_info failed: ${res.status} ${text.slice(0, 200)}`);
      return null;
    }

    const data = JSON.parse(text);
    const memberData = Array.isArray(data) ? data[0] : data;
    const profile = memberData?.profile || memberData || {};
    const memberId = profile.team_member_id || null;
    if (memberId) {
      cachedMemberId = memberId;
      console.log(`[shared/dropbox] Found member ID: ${memberId}`);
      // Also extract root namespace for team folder access
      const rootNs = profile.root_folder_id || profile.root_info?.root_namespace_id || null;
      if (rootNs) {
        cachedRootNs = rootNs;
        console.log(`[shared/dropbox] Team root namespace: ${rootNs}`);
      }
      return memberId;
    }

    console.error(`[shared/dropbox] Could not extract member ID from: ${text.slice(0, 200)}`);
    return null;
  } catch (e) {
    console.error(`[shared/dropbox] Member lookup failed: ${e.message}`);
    return null;
  }
}

/**
 * Get team root namespace ID so Dropbox paths resolve correctly.
 * Extracted from team/members/get_info response in getTeamMemberId.
 * @param {string} token - Access token
 * @param {string} memberId - Team member ID
 * @returns {Promise<string|null>}
 */
let cachedRootNs = null;
async function getTeamRootNamespace(token, memberId) {
  // Use cached value from getTeamMemberId if available
  if (cachedRootNs && cachedRootNs !== '' && cachedRootNs !== 'null') {
    return cachedRootNs;
  }
  
  // Fallback: call team/members/get_info directly to get root namespace
  try {
    const memberResult = await getTeamMemberId(token);
    if (!memberResult && cachedRootNs) return cachedRootNs;
    return cachedRootNs || null;
  } catch (e) {
    console.error(`[shared/dropbox] Namespace lookup failed: ${e.message}`);
    return null;
  }
}

// ─── File Operations ──────────────────────────────────────────────────────

/**
 * Build the required Dropbox headers for an API call.
 * @param {string} token - Access token
 * @param {string|null} memberId - Team member ID for Select-User (optional)
 * @param {string|null} rootNs - Team root namespace ID (optional)
 * @returns {object} Headers object
 */
function buildHeaders(token, memberId, rootNs) {
  const headers = {
    'Authorization': `Bearer ${token}`,
  };
  if (memberId) headers['Dropbox-API-Select-User'] = memberId;
  if (rootNs) {
    headers['Dropbox-API-Path-Root'] = JSON.stringify({ '.tag': 'namespace_id', namespace_id: rootNs });
  }
  return headers;
}

/**
 * Upload a file buffer to Dropbox.
 * @param {Buffer} fileBuffer - File contents
 * @param {string} dropboxPath - Full path in Dropbox (e.g., /projects/_leads/slug/file.pdf)
 * @param {object} [options]
 * @param {string} [options.mode='add'] - 'add' or 'overwrite'
 * @returns {Promise<{path: string, size: number, link: string|null}|null>}
 */
async function uploadFile(fileBuffer, dropboxPath, options = {}) {
  const token = await getAccessToken();
  if (!token) {
    console.error('[shared/dropbox] No valid token available — skipping upload');
    return null;
  }

  const memberId = await getTeamMemberId(token);
  const rootNs = memberId ? await getTeamRootNamespace(token, memberId) : null;

  const headers = buildHeaders(token, memberId, rootNs);
  headers['Content-Type'] = 'application/octet-stream';
  headers['Dropbox-API-Arg'] = JSON.stringify({
    path: dropboxPath,
    mode: options.mode || 'add',
    autorename: true,
  });

  try {
    const res = await dropboxFetch(`${DROPBOX_CONTENT}/2/files/upload`, {
      method: 'POST',
      headers,
      body: fileBuffer,
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`[shared/dropbox] Upload failed (${res.status}): ${text.slice(0, 300)}`);
      return null;
    }

    const data = JSON.parse(text);
    console.log(`[shared/dropbox] Uploaded: ${dropboxPath} (${data.size} bytes)`);

    // Create shared link
    const shareI = await createSharedLink(dropboxPath, token, memberId, rootNs);

    return { path: data.path_display || data.path_lower, size: data.size, link: shareI };
  } catch (e) {
    console.error(`[shared/dropbox] Upload error: ${e.message}`);
    return null;
  }
}

/**
 * Create a public shared link for a Dropbox file.
 * @param {string} dropboxPath - Path to the uploaded file
 * @param {string} token - Access token
 * @param {string|null} memberId - Team member ID
 * @param {string|null} rootNs - Team root namespace
 * @returns {Promise<string|null>} Download URL or null
 */
async function createSharedLink(dropboxPath, token, memberId, rootNs) {
  try {
    const headers = buildHeaders(token, memberId, rootNs);
    headers['Content-Type'] = 'application/json';

    const linkRes = await dropboxFetch(`${DROPBOX_API}/2/sharing/create_shared_link_with_settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: dropboxPath,
        settings: { requested_visibility: { '.tag': 'public' } },
      }),
    });

    const linkRaw = await linkRes.text();

    if (linkRes.ok) {
      let linkData;
      try { linkData = JSON.parse(linkRaw); } catch { linkData = {}; }
      const sharedUrl = linkData.url;
      if (sharedUrl) {
        const downloadUrl = sharedUrl
          .replace('?dl=0', '?dl=1')
          .replace('www.dropbox.com', 'dl.dropboxusercontent.com');
        console.log(`[shared/dropbox] Shared link: ${downloadUrl}`);
        return downloadUrl;
      }
    }

    // Check for "already exists" error — extract existing link
    try {
      const errData = JSON.parse(linkRaw);
      const existingUrl = errData.error?.shared_link_already_exists?.metadata?.url;
      if (existingUrl) {
        const downloadUrl = existingUrl
          .replace('?dl=0', '?dl=1')
          .replace('www.dropbox.com', 'dl.dropboxusercontent.com');
        console.log(`[shared/dropbox] Using existing shared link: ${downloadUrl}`);
        return downloadUrl;
      }
    } catch { /* not JSON */ }

    console.error(`[shared/dropbox] Shared link failed: ${linkRaw.slice(0, 200)}`);
    return null;
  } catch (e) {
    console.error(`[shared/dropbox] Shared link error: ${e.message}`);
    return null;
  }
}

/**
 * Copy a folder template to a new location.
 * Uses Dropbox API /2/files/copy_v2 recursively.
 * @param {string} sourcePath - Source folder path (e.g., /projects/_new_project)
 * @param {string} destPath - Destination path (e.g., /projects/_leads/{slug})
 * @returns {Promise<boolean>}
 */
async function copyFolder(sourcePath, destPath) {
  const token = await getAccessToken();
  if (!token) return false;

  const memberId = await getTeamMemberId(token);
  const rootNs = memberId ? await getTeamRootNamespace(token, memberId) : null;
  const headers = { ...buildHeaders(token, memberId, rootNs), 'Content-Type': 'application/json' };

  try {
    const res = await dropboxFetch(`${DROPBOX_API}/2/files/copy_v2`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from_path: sourcePath, to_path: destPath }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[shared/dropbox] Copy failed (${res.status}): ${text.slice(0, 300)}`);
      return false;
    }

    console.log(`[shared/dropbox] Copied ${sourcePath} → ${destPath}`);
    return true;
  } catch (e) {
    console.error(`[shared/dropbox] Copy error: ${e.message}`);
    return false;
  }
}

/**
 * Move a folder from one path to another.
 * @param {string} sourcePath - Current path
 * @param {string} destPath - New path
 * @returns {Promise<boolean>}
 */
async function moveFolder(sourcePath, destPath) {
  const token = await getAccessToken();
  if (!token) return false;

  const memberId = await getTeamMemberId(token);
  const rootNs = memberId ? await getTeamRootNamespace(token, memberId) : null;
  const headers = { ...buildHeaders(token, memberId, rootNs), 'Content-Type': 'application/json' };

  try {
    const res = await dropboxFetch(`${DROPBOX_API}/2/files/move_v2`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from_path: sourcePath, to_path: destPath }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[shared/dropbox] Move failed (${res.status}): ${text.slice(0, 300)}`);
      return false;
    }

    console.log(`[shared/dropbox] Moved ${sourcePath} → ${destPath}`);
    return true;
  } catch (e) {
    console.error(`[shared/dropbox] Move error: ${e.message}`);
    return false;
  }
}

/**
 * List folders inside a Dropbox directory (supports pagination).
 * Returns an array of folder metadata objects with `name`, `path_lower`, `id`.
 * @param {string} dirPath - Path to list (e.g., /projects/_leads)
 * @returns {Promise<Array<{name: string, path_lower: string, id: string}>>}
 */
async function listFolder(dirPath) {
  const token = await getAccessToken();
  if (!token) {
    console.error('[shared/dropbox] listFolder("' + dirPath + '"): no token available, returning []');
    return [];
  }

  const memberId = await getTeamMemberId(token);
  const rootNs = memberId ? await getTeamRootNamespace(token, memberId) : null;
  const headers = { ...buildHeaders(token, memberId, rootNs), 'Content-Type': 'application/json' };

  const entries = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    try {
      const endpoint = cursor
        ? `${DROPBOX_API}/2/files/list_folder/continue`
        : `${DROPBOX_API}/2/files/list_folder`;
      const body = cursor ? { cursor } : { path: dirPath };

      const res = await dropboxFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[shared/dropbox] listFolder failed (${res.status}): ${text.slice(0, 300)}`);
        return entries; // Return what we have so far
      }

      const data = await res.json();
      for (const entry of (data.entries || [])) {
        if (entry['.tag'] === 'folder') {
          entries.push({ name: entry.name, path_lower: entry.path_lower, id: entry.id });
        }
      }
      hasMore = data.has_more || false;
      cursor = data.cursor || null;
    } catch (e) {
      console.error(`[shared/dropbox] listFolder error: ${e.message}`);
      break;
    }
  }

  console.log(`[shared/dropbox] Listed ${entries.length} folders in ${dirPath}`);
  return entries;
}

/**
 * Delete a file or folder.
 * @param {string} dropboxPath - Path to delete
 * @returns {Promise<boolean>}
 */
async function deletePath(dropboxPath) {
  const token = await getAccessToken();
  if (!token) return false;

  const memberId = await getTeamMemberId(token);
  const rootNs = memberId ? await getTeamRootNamespace(token, memberId) : null;
  const headers = { ...buildHeaders(token, memberId, rootNs), 'Content-Type': 'application/json' };

  try {
    const res = await dropboxFetch(`${DROPBOX_API}/2/files/delete_v2`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: dropboxPath }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[shared/dropbox] Delete failed (${res.status}): ${text.slice(0, 300)}`);
      return false;
    }

    console.log(`[shared/dropbox] Deleted: ${dropboxPath}`);
    return true;
  } catch (e) {
    console.error(`[shared/dropbox] Delete error: ${e.message}`);
    return false;
  }
}

/**
 * Download a file from Dropbox as text.
 * @param {string} dropboxPath - Full path in Dropbox
 * @returns {Promise<string|null>} File text content, or null on failure
 */
async function downloadTextFile(dropboxPath) {
  const token = await getAccessToken();
  if (!token) return null;

  const memberId = await getTeamMemberId(token);
  const rootNs = memberId ? await getTeamRootNamespace(token, memberId) : null;
  const headers = { ...buildHeaders(token, memberId, rootNs) };
  headers['Dropbox-API-Arg'] = JSON.stringify({ path: dropboxPath });

  try {
    const res = await dropboxFetch(`${DROPBOX_CONTENT}/2/files/download`, {
      method: 'POST',
      headers,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[shared/dropbox] Download failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const content = await res.text();
    console.log(`[shared/dropbox] Downloaded: ${dropboxPath} (${content.length} chars)`);
    return content;
  } catch (e) {
    console.error(`[shared/dropbox] Download error: ${e.message}`);
    return null;
  }
}

module.exports = {
  getAccessToken,
  getTeamMemberId,
  getTeamRootNamespace,
  buildHeaders,
  uploadFile,
  downloadTextFile,
  createSharedLink,
  copyFolder,
  moveFolder,
  listFolder,
  deletePath,
};

module.exports.VERSION = '1.0.0';
