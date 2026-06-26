// =============================================================================
// trello.js — Shared Trello API module for ZINN Railway services
// Card fetch, list operations, field parsing, card movement, and actions.
// =============================================================================
'use strict';

const fetch = require('node-fetch');
const https = require('https');
const { TRELLO_KEY, TRELLO_TOKEN } = require('./config');

const API_BASE = 'https://api.trello.com/1';

// ─── Low-Level HTTP ───────────────────────────────────────────────────────

/**
 * Trello GET using native https module (node-fetch v2 has premature close issues
 * with Trello API on Node 24). Falls back to node-fetch for non-GET operations.
 */
function trelloGet(path) {
  return new Promise((resolve, reject) => {
    const urlStr = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Accept-Encoding': 'identity' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Trello GET ${path} failed: ${res.statusCode}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Trello GET ${path} JSON parse failed: ${e.message}`)); }
        }
      });
    });
    req.on('error', (e) => reject(new Error(`Trello GET ${path} request failed: ${e.message}`)));
    req.end();
  });
}

async function trelloPost(path, body) {
  const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Trello POST ${path} failed: ${res.status}`);
  return res.json();
}

async function trelloPut(path, body) {
  const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Trello PUT ${path} failed: ${res.status}`);
  return res.json();
}

// ─── Cards ────────────────────────────────────────────────────────────────

/**
 * Fetch a Trello card by ID. Falls back to scanning board lists if direct
 * fetch fails (Atlassian migration bug workaround).
 * @param {string} cardId
 * @returns {Promise<object>}
 */
async function getCard(cardId) {
  try {
    const card = await trelloGet(`/cards/${cardId}`);
    if (card && card.id) return card;
  } catch (e) {
    console.log(`[shared/trello] Direct fetch failed: ${e.message.slice(0, 80)}. Trying board list...`);
  }

  // Fallback: scan board lists for the card
  // First try to find which board the card is on
  const trimId = cardId.trim();
  if (trimId !== cardId) return getCard(trimId);

  // Scan all known boards
  const boardIds = Object.values(require('./config').BOARDS);
  for (const boardId of boardIds) {
    try {
      const lists = await trelloGet(`/boards/${boardId}/lists?fields=id`);
      for (const list of lists) {
        const cards = await trelloGet(`/lists/${list.id}/cards?fields=id,name,shortLink`);
        const found = cards.find(c => c.id === trimId || c.shortLink === trimId || c.id.startsWith(trimId));
        if (found) {
          console.log(`[shared/trello] Found card ${found.name} via board scan`);
          return trelloGet(`/cards/${found.id}`);
        }
      }
    } catch { /* skip board */ }
  }

  throw new Error(`Card ${cardId} not found on any board`);
}

/**
 * Get all cards in a specific list.
 * @param {string} listId
 * @returns {Promise<Array>}
 */
async function getCardsInList(listId) {
  return trelloGet(`/lists/${listId}/cards?customFieldItems=true`);
}

// ─── Lists ────────────────────────────────────────────────────────────────

/**
 * Get a list by ID.
 * @param {string} listId
 * @returns {Promise<object>}
 */
async function getList(listId) {
  return trelloGet(`/lists/${listId}?fields=name,closed,pos`);
}

/**
 * Get all lists on a board.
 * @param {string} boardId
 * @param {boolean} [includeClosed=false]
 * @returns {Promise<Array>}
 */
async function getBoardLists(boardId, includeClosed = false) {
  const filter = includeClosed ? 'all' : 'open';
  return trelloGet(`/boards/${boardId}/lists?fields=name,closed,pos&filter=${filter}`);
}

/**
 * Resolve a list name from its ID (caches after first call).
 * @param {string} listId
 * @returns {Promise<string|null>}
 */
const listNameCache = {};
async function getListName(listId) {
  if (listNameCache[listId]) return listNameCache[listId];
  try {
    const list = await getList(listId);
    listNameCache[listId] = list.name;
    return list.name;
  } catch {
    return null;
  }
}

/**
 * Find a list ID by name on a specific board.
 * @param {string} boardId
 * @param {string} listName
 * @returns {Promise<string|null>}
 */
async function findListId(boardId, listName) {
  const lists = await getBoardLists(boardId);
  const match = lists.find(l => l.name.toLowerCase() === listName.toLowerCase());
  return match ? match.id : null;
}

// ─── Card Actions ─────────────────────────────────────────────────────────

/**
 * Move a card to a specific list.
 * @param {string} cardId
 * @param {string} listId - Target list ID
 */
/**
 * Get checklists on a card.
 * @param {string} cardId
 * @returns {Promise<Array>}
 */
async function getChecklists(cardId) {
  return trelloGet('/cards/' + cardId + '/checklists');
}

/**
 * Get Trello member info by member ID.
 * @param {string} memberId
 * @returns {Promise<object|null>}
 */
async function getMember(memberId) {
  if (!memberId) return null;
  try {
    return await trelloGet(`/members/${memberId}`);
  } catch (e) {
    console.error(`[shared/trello] Failed to fetch member ${memberId}: ${e.message}`);
    return null;
  }
}

async function moveCardToList(cardId, listId) {
  await trelloPut(`/cards/${cardId}`, { idList: listId });
  console.log(`[shared/trello] Card ${cardId} moved to list ${listId}`);
}

/**
 * Set the due date on a card.
 * @param {string} cardId
 * @param {string} dueDateISO - ISO 8601 date string
 */
async function setDueDate(cardId, dueDateISO) {
  await trelloPut(`/cards/${cardId}`, { due: dueDateISO });
  console.log(`[shared/trello] Due date set on ${cardId}: ${dueDateISO}`);
}

/**
 * Clear the due date on a card.
 * @param {string} cardId
 */
async function clearDueDate(cardId) {
  await trelloPut(`/cards/${cardId}`, { due: null });
  console.log(`[shared/trello] Due date cleared on ${cardId}`);
}

/**
 * Update arbitrary card fields (description, name, etc.).
 * @param {string} cardId
 * @param {object} fields - Key-value pairs to update (e.g., { desc: '...', name: '...' })
 */
async function updateCard(cardId, fields) {
  await trelloPut(`/cards/${cardId}`, fields);
  const desc = fields.desc ? '(desc)' : '';
  console.log(`[shared/trello] Card ${cardId} updated: ${Object.keys(fields).join(', ')}`);
}

/**
 * Add a comment to a card.
 * @param {string} cardId
 * @param {string} text
 */
async function addComment(cardId, text) {
  await trelloPost(`/cards/${cardId}/actions/comments`, { text });
  console.log(`[shared/trello] Comment added to ${cardId}`);
}

/**
 * Add a checkitem to a card's checklist.
 * Creates a new checklist named "Automation" if none exists.
 * @param {string} cardId
 * @param {string} text - Checkitem text
 * @param {string} [memberId] - Trello member ID to assign (optional)
 */
async function addCheckitem(cardId, text, memberId, dueDate) {
  // Get card to find existing checklists
  const card = await trelloGet(`/cards/${cardId}/checklists`);
  let checklistId = card.length > 0 ? card[0].id : null;

  if (!checklistId) {
    // Create a new checklist
    const newChecklist = await trelloPost(`/cards/${cardId}/checklists`, { name: 'Automation' });
    checklistId = newChecklist.id;
  }

  const body = { name: text };
  if (memberId) body.idMember = memberId;
  const newItem = await trelloPost(`/checklists/${checklistId}/checkItems`, body);

  // Set due date if provided
  if (dueDate && newItem && newItem.id) {
    await trelloPut(`/cards/${cardId}/checkItem/${newItem.id}`, { due: dueDate });
  }

  console.log(`[shared/trello] Checkitem added to ${cardId}: "${text}"${dueDate ? ' (due ' + dueDate + ')' : ''}`);
}

/**
 * Update the state of a checkitem on a card.
 * Used to reset checkitems to incomplete for re-testing.
 * @param {string} cardId
 * @param {string} checkItemId
 * @param {string} state - 'complete' or 'incomplete'
 */
async function setCheckitemState(cardId, checkItemId, state) {
  await trelloPut(`/cards/${cardId}/checkItem/${checkItemId}`, { state });
  console.log(`[shared/trello] Checkitem ${checkItemId} state set to ${state}`);
}

/**
 * Archive a card.
 * @param {string} cardId
 */
async function archiveCard(cardId) {
  await trelloPut(`/cards/${cardId}`, { closed: true });
  console.log(`[shared/trello] Card ${cardId} archived`);
}

// ─── Card Field Parsing ───────────────────────────────────────────────────

/**
 * Parse a Trello card description into sections by ## heading.
 * Returns an object with section names as keys and content as values.
 * @param {string} desc - Card description text
 * @returns {object}
 */
function parseSections(desc) {
  const sections = {};
  const lines = (desc || '').split('\n');
  let currentSection = '_header'; // Content before first ## heading
  let currentLines = [];

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      if (currentSection) sections[currentSection] = currentLines.join('\n').trim();
      currentSection = match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentSection) sections[currentSection] = currentLines.join('\n').trim();

  return sections;
}

/**
 * Extract a specific section value from a card description.
 * @param {object|string} card - Card object or description string
 * @param {string} sectionName - Section name without ## (e.g., "Client", "Fee")
 * @returns {string|null}
 */
function getSection(card, sectionName) {
  const desc = typeof card === 'string' ? card : (card.desc || '');
  const sections = parseSections(desc);
  return sections[sectionName] || null;
}

/**
 * Extract email addresses from a section (usually ## Client).
 * First tries lines starting with "email:" or "Email:",
 * then falls back to finding any email address in the raw text.
 * @param {string} sectionText
 * @returns {string[]}
 */
function extractEmails(sectionText) {
  if (!sectionText) return [];
  const emails = [];
  const seen = new Set();
  for (const line of sectionText.split('\n')) {
    // Try email: prefix format first
    const prefixed = line.match(/email:\s*(\S+@\S+)/i);
    if (prefixed && !seen.has(prefixed[1].trim())) {
      emails.push(prefixed[1].trim());
      seen.add(prefixed[1].trim());
    }
  }
  // Fallback: find any email addresses in the raw text
  if (emails.length === 0) {
    const raw = sectionText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (raw) {
      for (const e of raw) {
        if (!seen.has(e)) {
          emails.push(e);
          seen.add(e);
        }
      }
    }
  }
  return emails;
}

/**
 * Build a client greeting from the ## Client section.
 * Female first, then males/unknowns, joined with "and".
 * @param {string} clientSection - Raw ## Client content
 * @returns {string} Greeting like "Hello Mary and Marc,"
 */
function buildClientGreeting(clientSection) {
  if (!clientSection) return 'Hello,';

  // Collect ALL non-email, non-phone lines (multiple clients on separate lines)
  const allLines = clientSection.split('\n')
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);

  // Filter out emails, phone numbers, addresses, URLs, and dashes
  const nameLines = allLines.filter(l =>
    !/@/.test(l) &&
    !/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(l) &&
    !/^(https?:\/\/)/i.test(l) &&
    !/^[-]{2,}$/.test(l.trim()) &&
    !/^\d+\s/.test(l) // street addresses start with a number
  );

  if (nameLines.length === 0) return 'Hello,';

  // Check for an attention: line (company client)
  const attentionLine = nameLines.find(l => /^attention:/i.test(l) || /^attn:/i.test(l));
  if (attentionLine) {
    const match = attentionLine.match(/:(.+)/);
    if (match) {
      const firstName = match[1].trim().split(' ')[0];
      return 'Hello ' + firstName + ',';
    }
  }

  // Remove company inc/suffixes from name lines
  const cleaned = nameLines.map(l => l.replace(/,\s*(Inc\.?|LLC|PLLC|PA|Corp\.?|Company|Ltd\.?).*/i, '').trim()).filter(Boolean);

  if (cleaned.length === 0) return 'Hello,';

  // Expand "X and Y Lastname" lines into separate names
  const expanded = [];
  for (const name of cleaned) {
    if (/\s+and\s+/i.test(name)) {
      const parts = name.split(/\s+and\s+/i);
      for (const part of parts) {
        expanded.push(part.trim());
      }
    } else {
      expanded.push(name);
    }
  }

  // Female-first heuristic for multiple clients
  var femaleNames = ['Teresa', 'Mary', 'Ann', 'Anne', 'Katherine', 'Elizabeth', 'Sarah', 'Jessica', 'Jennifer', 'Linda', 'Patricia', 'Susan', 'Lisa', 'Nancy', 'Karen', 'Betty', 'Helen', 'Sandra', 'Donna', 'Carol', 'Ruth', 'Sharon', 'Michelle', 'Laura', 'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Shirley', 'Cynthia', 'Kathleen', 'Amy', 'Angela', 'Anna', 'Brenda', 'Pamela', 'Emma', 'Nicole', 'Samantha', 'Katherine', 'Christine', 'Debra', 'Rachel', 'Carolyn', 'Janet', 'Catherine', 'Maria', 'Heather', 'Diane', 'Ruby', 'Julie', 'Joyce', 'Evelyn', 'Joan', 'Victoria', 'Kelly', 'Christina', 'Lauren', 'Frances', 'Martha', 'Judith', 'Cheryl', 'Megan', 'Andrea', 'Olivia', 'Sophia', 'Isabella', 'Mia', 'Charlotte', 'Amelia', 'Harper', 'Evelyn', 'Abigail', 'Emily', 'Ella', 'Avery', 'Scarlett', 'Grace', 'Chloe', 'Victoria', 'Riley', 'Aria', 'Lily', 'Aurora', 'Zoey', 'Nora', 'Camila', 'Penelope', 'Layla', 'Luna', 'Stella', 'Eliana', 'Hannah', 'Maya', 'Naomi', 'Ellie', 'Sadie', 'Aubrey', 'Claire', 'Alice', 'Eva', 'Hailey', 'Kaylee', 'Alyssa', 'Brianna', 'Julia', 'Kassia', 'Lindsay', 'Robin', 'Shukry', 'Shireen', 'Taylor', 'Casey'];

  // Extract first names
  const firstNames = expanded.map(function(l) {
    return l.trim().split(' ')[0];
  }).filter(Boolean);

  if (firstNames.length === 0) return 'Hello,';
  if (firstNames.length === 1) return 'Hello ' + firstNames[0] + ',';

  var sorted = [].concat(firstNames).sort(function(a, b) {
    var aF = femaleNames.indexOf(a) >= 0 ? 0 : 1;
    var bF = femaleNames.indexOf(b) >= 0 ? 0 : 1;
    return aF - bF;
  });

  if (sorted.length === 2) return 'Hello ' + sorted[0] + ' and ' + sorted[1] + ',';
  return 'Hello ' + sorted.slice(0, -1).join(', ') + ', and ' + sorted[sorted.length - 1] + ',';
}

/**
 * Extract fee lines from ## Fee section.
 * Format: • Description: $1,234
 * @param {string} feeSection - Raw ## Fee content
 * @returns {Array<{desc: string, amount: number, type: string}>}
 */
function parseFeeLines(feeSection) {
  if (!feeSection) return [];
  const lines = feeSection.split('\n');
  const fees = [];

  for (const line of lines) {
    const feeMatch = line.match(/•\s*([^:]+):\s*\$?([\d,]+\.?\d*)/);
    if (feeMatch) {
      fees.push({
        desc: feeMatch[1].trim(),
        amount: parseFloat(feeMatch[2].replace(/,/g, '')),
        type: 'required',
      });
    }
  }

  return fees;
}

module.exports = {
  trelloGet,
  trelloPost,
  trelloPut,
  getCard,
  getCardsInList,
  getList,
  getListName,
  getBoardLists,
  findListId,
  getChecklists,
  getMember,
  moveCardToList,
  setDueDate,
  clearDueDate,
  updateCard,
  addComment,
  addCheckitem,
  setCheckitemState,
  archiveCard,
  parseSections,
  getSection,
  extractEmails,
  buildClientGreeting,
  parseFeeLines,
};

module.exports.VERSION = '1.0.0';
