// =============================================================================
// task-chain.js — Shared task chain filtering and population module
// Used by entry_actions_server.js and _callable/populate_task_chain.js
// =============================================================================
'use strict';

const trello = require('./trello');
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

async function populateEntireTaskChain(card, taskChain, entrySubphaseListName) {
  var total = taskChain.length;
  var added = 0;

  var currentSubphaseStart = -1;
  var currentSubphaseEnd = -1;
  if (entrySubphaseListName) {
    for (var i = 0; i < total; i++) {
      if (taskChain[i].listName === entrySubphaseListName) {
        if (currentSubphaseStart === -1) currentSubphaseStart = i;
        currentSubphaseEnd = i;
      } else if (currentSubphaseEnd >= 0) {
        break;
      }
    }
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

    var newItem = await trello.trelloPost('/checklists/' + checklistId + '/checkItems', {
      name: itemName
    });
    addedItems.push({ item: item, checkItemId: newItem.id });
    existingShortLinks.add(sl);
    added++;
  }

  console.log('[task-chain] Subphase range: start=' + currentSubphaseStart + ' end=' + currentSubphaseEnd + ' total=' + total);
  if (currentSubphaseStart >= 0) {
    for (var i = 0; i < total; i++) {
      if (i >= currentSubphaseStart && i <= currentSubphaseEnd) {
        console.log('[task-chain]  SKIP entry subphase item ' + i + ': ' + (taskChain[i] ? taskChain[i].zptCard.name.substring(0,40) : '?'));
        continue;
      }
      if (addedItems[i] && addedItems[i].checkItemId) {
        console.log('[task-chain]  CHECK item ' + i + ': ' + (taskChain[i] ? taskChain[i].zptCard.name.substring(0,40) : '?'));
        var shortLink = taskChain[i] ? taskChain[i].zptCard.shortLink : null;
        await setCheckitemState(card.id, addedItems[i].checkItemId, 'complete', shortLink);
      } else {
        console.log('[task-chain]  SKIP item ' + i + ' (null/duplicate): ' + (taskChain[i] ? taskChain[i].zptCard.name.substring(0,40) : '?'));
      }
    }
  } else {
    console.log('[task-chain] No entry subphase range, leaving all items unchecked');
  }

  // Note: Task Chain metadata section removed -- checkitem-based tracking is the source of truth

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
