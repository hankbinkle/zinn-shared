// =============================================================================
// task-chain.js — Shared task chain filtering and population module
// Used by entry_actions_server.js and _callable/populate_task_chain.js
// =============================================================================
'use strict';

const trello = require('./trello');
const scheduler = require('./scheduler');
const ZPT_BOARD_ID = '66f2e19a4dd7012acc370148';

// ─── Phase / List Helpers ─────────────────────────────────────────────────

const LIST_CACHE = new Map();
const CACHE_TTL_MS = 300000;
let allZptCardsCache = null;
let allZptCardsTs = 0;

function normalizePhase(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function getPhaseFromListName(listName) {
  var idx = listName.indexOf('|');
  return idx >= 0 ? listName.slice(0, idx).trim() : listName.trim();
}

function getSubphaseName(listName) {
  var idx = listName.indexOf('|');
  return idx >= 0 ? listName.slice(idx + 1).trim() : '';
}

async function getBoardLists(boardId) {
  var cached = LIST_CACHE.get(boardId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.map;
  var lists = await trello.trelloGet('/boards/' + boardId + '/lists?fields=name,id,pos');
  var map = new Map();
  for (var i = 0; i < lists.length; i++) {
    var l = lists[i];
    map.set(normalizePhase(l.name), { id: l.id, name: l.name, pos: l.pos });
  }
  LIST_CACHE.set(boardId, { map: map, ts: Date.now() });
  return map;
}

function getCardPhases(card) {
  var desc = card.desc || '';
  var m = desc.match(/##\s*Phases\s*\n([\s\S]*?)(?=\n##|\n---|\n$|$)/i);
  var phases = ['leads'];
  if (!m) return phases;
  var lines = m[1].trim().split('\n');
  for (var i = 0; i < lines.length; i++) {
    var name = normalizePhase(lines[i].replace(/^[-*]\s*/, ''));
    if (name && name !== 'leads') phases.push(name);
  }
  return phases;
}

async function findZptListsForPhase(phaseName) {
  var n = normalizePhase(phaseName);
  var zptLists = await getBoardLists(ZPT_BOARD_ID);
  var matches = [];
  for (var entry of zptLists) {
    var normalizedName = entry[0];
    var data = entry[1];
    if (normalizedName === n || normalizedName.startsWith(n + ' |')) {
      matches.push({ listId: data.id, listName: data.name, pos: data.pos });
    }
  }
  return matches.sort(function(a, b) { return a.pos - b.pos; });
}

async function findFirstSubphase(phaseName) {
  var lists = await findZptListsForPhase(phaseName);
  return lists.length > 0 ? lists[0].listName : null;
}

// ─── Task Chain Filtering ─────────────────────────────────────────────────

async function getAllZptCards() {
  if (allZptCardsCache && Date.now() - allZptCardsTs < CACHE_TTL_MS) return allZptCardsCache;
  var lists = await getBoardLists(ZPT_BOARD_ID);
  var allCards = [];
  for (var entry of lists) {
    var listData = entry[1];
    var cards = await trello.trelloGet('/lists/' + listData.id + '/cards?fields=name,desc,shortLink,labels,pos,idList,shortUrl');
    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      if (card.closed) continue;
      allCards.push({
        name: card.name,
        desc: card.desc,
        shortLink: card.shortLink,
        labels: card.labels || [],
        pos: card.pos,
        idList: card.idList,
        shortUrl: card.shortUrl,
        _listId: listData.id,
        _listName: listData.name,
        _listPos: listData.pos
      });
    }
  }
  allCards.sort(function(a, b) {
    if (a._listPos !== b._listPos) return a._listPos - b._listPos;
    return a.pos - b.pos;
  });
  allZptCardsCache = allCards;
  allZptCardsTs = Date.now();
  return allCards;
}

async function getFilteredTaskChain(card, phaseWhitelist) {
  // phaseWhitelist: optional array of phase names to restrict to (e.g., just ['leads'])
  // If omitted, all phases from card's ## Phases section are used.
  var phases = phaseWhitelist ? phaseWhitelist.slice() : getCardPhases(card);
  // Always include leads for leads-phase ZPTB cards
  if (phases.indexOf('leads') < 0) phases.unshift('leads');
  var phaseLabels = new Set(phases.map(function(p) { return normalizePhase(p); }));
  var projectLabels = (card.labels || []).map(function(l) { return l.name.toLowerCase(); });
  var allCards = await getAllZptCards();
  var zptLists = await getBoardLists(ZPT_BOARD_ID);
  var result = [];
  for (var i = 0; i < allCards.length; i++) {
    var zc = allCards[i];
    var cardPhase = null;
    for (var entry of zptLists) {
      var normalizedName = entry[0];
      var listData = entry[1];
      if (listData.id === zc._listId) {
        if (normalizedName === zc._listName || zc._listName.startsWith(normalizedName + ' |')) {
          cardPhase = normalizePhase(getPhaseFromListName(zc._listName));
        }
        break;
      }
    }
    // Leads ZPTB cards are universal - skip phase check
    if (cardPhase !== 'leads' && (!cardPhase || !phaseLabels.has(cardPhase))) continue;
    var zptLabels = (zc.labels || []).map(function(l) { return l.name.toLowerCase(); });
    if (zptLabels.length > 0 && !zptLabels.some(function(l) { return projectLabels.includes(l); })) continue;
    result.push({
      zptCard: zc,
      phaseName: cardPhase,
      subphaseName: getSubphaseName(zc._listName),
      listId: zc._listId,
      listName: zc._listName
    });
  }
  return result;
}

// ─── Checkitem Population ─────────────────────────────────────────────────

function extractShortLinkFromCheckitem(rawName) {
  var m = rawName.match(/^\[.+?\]\(https?:\/\/trello\.com\/c\/([a-zA-Z0-9]+)\)/);
  return m ? m[1] : null;
}

async function getExistingZptCardIds(cardId) {
  var ids = new Set();
  try {
    var cls = await trello.getChecklists(cardId);
    for (var i = 0; i < cls.length; i++) {
      var items = cls[i].checkItems || [];
      for (var j = 0; j < items.length; j++) {
        var sl = extractShortLinkFromCheckitem(items[j].name);
        if (sl) ids.add(sl);
      }
    }
  } catch (e) {}
  return ids;
}

async function isTaskChainPopulated(cardId) {
  var existing = await getExistingZptCardIds(cardId);
  return existing.size > 0;
}

// Track auto-checked shortLinks so ACB handlers can skip them.
// Keyed by cardId -> Set<shortLink>. Exported for use by entry_actions_server.js.
var autoCheckedShortLinks = new Map();

async function setCheckitemState(cardId, checkItemId, state, shortLink) {
  if (state === 'complete' && shortLink) {
    if (!autoCheckedShortLinks.has(cardId)) autoCheckedShortLinks.set(cardId, new Set());
    autoCheckedShortLinks.get(cardId).add(shortLink);
  }
  await trello.trelloPut('/cards/' + cardId + '/checkItem/' + checkItemId, { state: state });
}

/**
 * Get all ZPT-format checkitems on a card, ordered by Trello position.
 */
async function getCardZptItemsInOrder(cardId) {
  var items = [];
  try {
    var cls = await trello.getChecklists(cardId);
    for (var i = 0; i < cls.length; i++) {
      var checkItems = cls[i].checkItems || [];
      for (var j = 0; j < checkItems.length; j++) {
        var sl = extractShortLinkFromCheckitem(checkItems[j].name);
        if (sl) items.push({ shortLink: sl, state: checkItems[j].state, pos: checkItems[j].pos, id: checkItems[j].id });
      }
    }
  } catch (_) {}
  items.sort(function(a, b) { return a.pos - b.pos; });
  return items;
}

// ─── Hours & Scheduling ──────────────────────────────────────────────────────

/**
 * Fetch the "hours" Trello custom field value for each ZPTB card in the chain.
 * Returns a map: shortLink -> hours (number). Skips cards with no hours set.
 */
async function fetchHoursForChain(taskChain) {
  var cfs = await trello.getBoardCustomFields(ZPT_BOARD_ID);
  var hoursDef = null;
  for (var ci = 0; ci < cfs.length; ci++) {
    if (cfs[ci].name.toLowerCase() === 'hours') {
      hoursDef = cfs[ci];
      break;
    }
  }
  if (!hoursDef) {
    console.log('[task-chain] No "hours" custom field found on ZPT2 board');
    return {};
  }

  var hoursMap = {};
  for (var i = 0; i < taskChain.length; i++) {
    var sl = taskChain[i].zptCard.shortLink;
    try {
      var val = await trello.getCustomFieldValue(sl, hoursDef.id);
      if (val !== null && val > 0) {
        var numVal = (typeof val === 'string') ? parseFloat(val) : val;
        if (numVal > 0) hoursMap[sl] = numVal;
      }
    } catch (e) {
      console.log('[task-chain] Failed to fetch hours for ' + sl + ': ' + e.message);
    }
    await new Promise(function(r) { setTimeout(r, 50); });
  }
  return hoursMap;
}

/**
 * Apply scheduling to newly added checkitems: set due dates and update names
 * with hidden start date markdown for board-visualizer compatibility.
 */
async function applyScheduleToItems(cardId, addedItems, hoursMap, projectSqFt) {
  if (!addedItems || addedItems.length === 0) return;

  var hoursList = [];
  for (var i = 0; i < addedItems.length; i++) {
    if (!addedItems[i]) {
      hoursList.push({ shortLink: null, hours: 0 });
      continue;
    }
    var sl = addedItems[i].item.zptCard.shortLink;
    var rawHours = hoursMap[sl] || 0;
    var adjHours = scheduler.calcAdjustedHours(rawHours, projectSqFt);
    hoursList.push({ shortLink: sl, hours: adjHours });
  }

  var schedule = scheduler.calculateSchedule(hoursList, new Date());

  for (var i = 0; i < addedItems.length; i++) {
    if (!addedItems[i] || !schedule[i]) continue;
    var s = schedule[i];
    if (!s.dueISO && !s.startISO) continue;

    var ci = addedItems[i].checkItemId;
    var zc = addedItems[i].item.zptCard;
    var baseUrl = zc.shortUrl || 'https://trello.com/c/' + zc.shortLink;
    var hiddenMd = scheduler.buildStartDateMarkdown(s.startISO);
    var fullName = '[' + zc.name + '](' + baseUrl + ')' + hiddenMd;

    try {
      await trello.trelloPut('/cards/' + cardId + '/checkItem/' + ci, { name: fullName });
    } catch (e) {
      console.log('[task-chain] Failed to set name for checkitem ' + ci + ': ' + e.message);
    }

    if (s.dueISO) {
      try {
        await trello.trelloPut('/cards/' + cardId + '/checkItem/' + ci, { due: s.dueISO });
      } catch (e) {
        console.log('[task-chain] Failed to set due for checkitem ' + ci + ': ' + e.message);
      }
    }
  }

  console.log('[task-chain] Applied schedule to ' + schedule.filter(function(s) { return s.dueISO; }).length + ' checkitems');
}

// ─── Population ───────────────────────────────────────────────────────────────

async function populateEntireTaskChain(card, taskChain, entrySubphaseListName, leadsMemberId, actorMemberId) {
  var total = taskChain.length;
  var added = 0;

  // --- Fetch hours from ZPTB template cards ---
  var hoursMap = await fetchHoursForChain(taskChain);

  // --- Parse project area for hours scaling ---
  var projectSqFt = null;
  var areaText = trello.getSection(card, 'Area');
  if (areaText) {
    projectSqFt = scheduler.parseAreaSqFt(areaText);
  }
  if (!projectSqFt) {
    projectSqFt = scheduler.BENCHMARK_SQFT;
    console.log('[task-chain] No ## Area on "' + card.name + '" — defaulting to ' + projectSqFt + ' sq ft');
  } else {
    console.log('[task-chain] Project sq ft: ' + projectSqFt);
  }

  var cardData = await trello.getChecklists(card.id);
  var checklistId = null;
  if (cardData.length > 0) {
    checklistId = cardData[0].id;
  } else {
    var newCl = await trello.trelloPost('/cards/' + card.id + '/checklists', { name: 'Checklist' });
    checklistId = newCl.id;
  }

  // Check for existing ZPT checkitems to avoid duplicates
  var existingShortLinks = new Set();
  try {
    var existing = await getExistingZptCardIds(card.id);
    for (var sl of existing) existingShortLinks.add(sl);
  } catch (_) {}

  var addedItems = [];
  for (var i = 0; i < total; i++) {
    var item = taskChain[i];
    var sl = item.zptCard.shortLink;
    var url = item.zptCard.shortUrl || 'https://trello.com/c/' + sl;
    var itemName = '[' + item.zptCard.name + '](' + url + ')';

    if (existingShortLinks.has(sl)) {
      console.log('[task-chain] Skipping duplicate: ' + sl + ' (' + item.zptCard.name + ')');
      addedItems.push(null);
      continue;
    }

    var body = { name: itemName };
    if (leadsMemberId && item.phaseName === 'leads') body.idMember = leadsMemberId;
    var newItem = await trello.trelloPost('/checklists/' + checklistId + '/checkItems', body);
    addedItems.push({ item: item, checkItemId: newItem.id });
    existingShortLinks.add(sl);
    added++;

    if (i % 5 === 4) await new Promise(function(r) { setTimeout(r, 100); });
  }

  // --- Apply scheduling ---
  await applyScheduleToItems(card.id, addedItems, hoursMap, projectSqFt);

  // Auto-check block removed 2026-07-24. Humans check items as work is completed.
  // All newly added items remain unchecked.

  await trello.addComment(card.id, 'Checklist updated: ' + added + ' items.');
  console.log('[task-chain] Populated ' + added + ' items for "' + card.name + '"');
  return { added: added, total: total };
}

module.exports = {
  normalizePhase,
  getPhaseFromListName,
  getSubphaseName,
  getBoardLists,
  getCardPhases,
  findZptListsForPhase,
  findFirstSubphase,
  getAllZptCards,
  getFilteredTaskChain,
  extractShortLinkFromCheckitem,
  getExistingZptCardIds,
  isTaskChainPopulated,
  getCardZptItemsInOrder,
  populateEntireTaskChain,
  autoCheckedShortLinks,
};
