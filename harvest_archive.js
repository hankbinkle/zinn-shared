/**
 * harvest_archive.js — frozen historical Harvest time, for the Harvest->QBO
 * merge (Rob 2026-10-08).
 *
 * Harvest was retired 2026-09-08; its time was NEVER back-logged into
 * QuickBooks (Shireen 2026-10: no). Consumers that report "expended" therefore
 * read BOTH sources: QuickBooks TimeActivity (current) plus this static archive
 * (historical), and merge them.
 *
 * Data files (siblings, produced by project_automator/_scripts/
 * build_harvest_archive.js from the frozen Harvest backup):
 *   harvest_time_archive.json — { projects: { id: { name, client,
 *                                entries:[{d,u,h,r,t}] } } }
 *                               d=date, u=user, h=hours, r=billable rate,
 *                               t=Harvest task name
 *   harvest_map.json          — [{cardId, cardName, harvestProjectIds, hours}]
 *
 * Historical hours are FROZEN (last Harvest entry 2026-08-24). New time comes
 * only from QBO, so a project that has no cardId in the map simply has no
 * historical record — that is correct, not an error.
 *
 * QBO is authoritative from CUTOVER on. Overlap handling: a Harvest entry that
 * a card's QBO entries already contain (same date + hours) is dropped, so the
 * Aug 2026 overlap window cannot double-count. Pass the card's QBO entries to
 * selectForCard(); omit them to get the raw historical list.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const CUTOVER = '2026-08-21'; // QBO time posting began; QBO wins from here.

let _arch = null;
let _map = null;

function load() {
  if (_arch) return;
  const base = __dirname;
  try { _arch = JSON.parse(fs.readFileSync(path.join(base, 'harvest_time_archive.json'), 'utf8')); }
  catch (e) { _arch = { projects: {} }; }
  try { _map = JSON.parse(fs.readFileSync(path.join(base, 'harvest_map.json'), 'utf8')); }
  catch (e) { _map = []; }
}

function cardId(card) { return typeof card === 'string' ? card : (card && card.id); }

function mapEntry(card) {
  load();
  const id = cardId(card);
  if (!id) return null;
  for (var i = 0; i < _map.length; i++) if (_map[i].cardId === id) return _map[i];
  return null;
}

/** Raw historical entries for a card, or [] when it has none. */
function entriesForCard(card) {
  load();
  var m = mapEntry(card);
  if (!m) return [];
  var out = [];
  (m.harvestProjectIds || []).forEach(function (pid) {
    var p = _arch.projects[pid];
    if (p && p.entries) p.entries.forEach(function (e) { out.push(e); });
  });
  return out;
}

/** Historical entries for a card minus anything the card's QBO entries
 *  already contain (same date + hours). qboEntries may be omitted. */
function selectForCard(card, qboEntries) {
  var he = entriesForCard(card);
  var q = (qboEntries || []).map(function (t) {
    return { d: String(t.TxnDate || '').slice(0, 10),
             h: (Number(t.Hours) || 0) + (Number(t.Minutes) || 0) / 60 };
  });
  if (!q.length) return he;
  return he.filter(function (e) {
    return !q.some(function (x) { return x.d === e.d && Math.abs(x.h - e.h) < 0.01; });
  });
}

function hoursForCard(card, qboEntries) {
  return selectForCard(card, qboEntries).reduce(function (a, e) { return a + (Number(e.h) || 0); }, 0);
}

function dollarsForCard(card, qboEntries, defaultRate) {
  var dr = Number(defaultRate) || 100;
  return selectForCard(card, qboEntries).reduce(function (a, e) {
    return a + (Number(e.h) || 0) * (Number(e.r) || dr);
  }, 0);
}

/**
 * Phase tag from a Harvest task name — "2 - sd - preliminary floor plans" ->
 * "sd". Returns the lower-case phase letter code (pd/sd/dd/cd/ca) or null for
 * legacy labels (drafting and modeling, admin, etc.), which the caller
 * attributes by date window instead.
 */
function phaseTag(entry) {
  var t = String((entry && entry.t) || '').toLowerCase();
  var m = t.match(/^\s*\d+\s*-\s*(pd|sd|dd|cd|ca)\b/);
  if (m) return m[1];
  m = t.match(/^\s*\d+\s*-\s*(bid|permit)/);
  if (m) return 'ca';
  return null;
}

function _normTask(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Harvest task name -> timesheet-creator service type. Ported verbatim from the
 * Harvest back-log mapping (backlog_dryrun.js, 2026-09-08) so historical
 * work-type labels match posted QuickBooks time. Per Rob 2026-10-08,
 * "drafting and modeling" -> "Production - Modeling and Rendering".
 */
function serviceFor(entry) {
  var n = _normTask(entry && entry.t);
  if (!n) return 'Admin';
  if (n.indexOf('vacation') >= 0 || n.indexOf('sick') >= 0) return 'Vacation / Sick';
  if (n.indexOf('holiday') >= 0) return 'Holiday';
  if (n.indexOf('unpaid leave') >= 0) return 'Unpaid Leave';
  if (n.indexOf('business development') >= 0) return 'Business Development - Networking';
  if (n.indexOf('admin') >= 0) return 'Admin';
  if (n.indexOf('site visit') >= 0 || n.indexOf('observation') >= 0) return 'Meetings - Site Meetings';
  if (n.indexOf('errands') >= 0) return 'Admin - Errands';
  if (n.indexOf('travel') >= 0) return 'Meetings - Travel';
  if (n.indexOf('meeting') >= 0 || n.indexOf('internal team review') >= 0) return 'Meetings - Team Meetings';
  if (n.indexOf('quote') >= 0 || n.indexOf('bid review') >= 0) return 'Research - Bids and Quotes';
  if (n.indexOf('permit comment') >= 0 || n.indexOf('code analysis') >= 0) return 'Research - Permitting and Code Research';
  if (n.indexOf('email') >= 0 || n.indexOf('phone call') >= 0 || n.indexOf('correspondence') >= 0 || n.indexOf('request') >= 0
    || n.indexOf('coordination') >= 0 || n.indexOf('submittal') >= 0 || n.indexOf('introduction') >= 0
    || n.indexOf('questionnaire') >= 0 || n.indexOf('interview') >= 0) return 'Admin - Emails and Phone Calls';
  if (n.indexOf('modeling') >= 0 || n.indexOf('model refinement') >= 0 || n.indexOf('floor plan') >= 0 || n.indexOf('preliminary') >= 0) return 'Production - Modeling and Rendering';
  if (n.indexOf('research') >= 0) return 'Research - Finishes and Fixtures';
  if (n.indexOf('markup') >= 0 || n.indexOf('review') >= 0 || n.indexOf('value engineering') >= 0 || n.indexOf('sheet setup') >= 0
    || n.indexOf('annotat') >= 0 || n.indexOf('keynot') >= 0 || n.indexOf('dimension') >= 0 || n.indexOf('drawing sheet') >= 0
    || n.indexOf('detailing') >= 0 || n.indexOf('life safety') >= 0 || n.indexOf('scheduling and tagging') >= 0
    || n.indexOf('construction sketch') >= 0 || n.indexOf('window door finish') >= 0 || n.indexOf('cabinetry') >= 0
    || n.indexOf('fixture') >= 0 || n.indexOf('product') >= 0 || n.indexOf('file setup') >= 0 || n.indexOf('presentation') >= 0
    || n.indexOf('drafting') >= 0) return 'Production - Drafting and Annotation';
  if (n.indexOf('error') >= 0 || n.indexOf('correction') >= 0 || n.indexOf('z other') >= 0 || n.indexOf('comp') >= 0) return 'Errors/Corrections';
  return 'Errors/Corrections';
}

module.exports = { entriesForCard, selectForCard, hoursForCard, dollarsForCard, phaseTag, serviceFor, mapEntry, CUTOVER, VERSION };
