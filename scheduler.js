// =============================================================================
// scheduler.js — Duration/scheduling utilities for ZINN project tasks
//
// Converts template hours into scaled durations, calculates sequential
// due dates within business hours (9AM-4PM ET, weekdays only), and
// formats hidden start date markdown for board-visualizer compatibility.
// =============================================================================
'use strict';

// ===== Square Footage Parsing ==============================================

/**
 * Parse square footage from the ## Area section of a card description.
 * Handles: "2000", "2,000", "2000 SF", "2,000 sq ft", "2000 ft2", "2000 ft\xb2",
 *          "2,000 square feet", etc.
 * @param {string} areaText - Content of the ## Area section
 * @returns {number|null} Square footage as number, or null if not parseable
 */
function parseAreaSqFt(areaText) {
  if (!areaText || typeof areaText !== 'string') return null;
  // Strip commas from numbers
  var cleaned = areaText.replace(/,/g, '');
  // Find the first numeric value (integer or decimal)
  var match = cleaned.match(/(\d+\.?\d*)/);
  if (!match) return null;
  var val = parseFloat(match[1]);
  return (isNaN(val) || val <= 0) ? null : val;
}

// ===== Hours Scaling =======================================================

// Base area per project type. A project of its type's typical size gets the
// template's hours unchanged; the base area is what "typical" means. These
// differ by type because a 10,000 sq ft restaurant and a 10,000 sq ft house
// are not the same amount of drawing, and warehouses are mostly repetition.
var BENCHMARK_SQFT = 2000;              // residential (historical base)
var TYPE_BENCHMARKS = {
  residential: 2000,
  commercial: 10000,
  warehouse: 30000,
};

// Commercial and warehouse chains carry a fixed share of meetings, reviews
// and correspondence that does not shrink with square footage, and they vary
// widely in size. Their scaling therefore never falls below the template
// hours. Residential schedules may scale below the template.
var FLOORED_TYPES = { commercial: true, warehouse: true };

// Waiting items (a checkitem whose template card carries follow_up intervals)
// hold the chain for their first interval instead of taking a working slot.
// A booking gate also gives the event that follows it lead time, so a meeting
// never lands on the same day the client is asked to book it.
var DEFAULT_WAIT_DAYS = 7;
var BOOKING_LEAD_DAYS = 7;

/**
 * Normalize the third argument of calcAdjustedHours. Accepts a type name, a
 * {type} object, or the legacy boolean isWarehouse flag.
 * @returns {string} residential | commercial | warehouse
 */
function normalizeType(opts) {
  if (typeof opts === 'string' && TYPE_BENCHMARKS[opts.toLowerCase()]) {
    return opts.toLowerCase();
  }
  if (opts && typeof opts === 'object' && typeof opts.type === 'string'
      && TYPE_BENCHMARKS[opts.type.toLowerCase()]) {
    return opts.type.toLowerCase();
  }
  if (opts === true) return 'warehouse';   // legacy boolean: isWarehouse
  return 'residential';
}

/**
 * Scale template hours by project size relative to the type's base area.
 * Rounds to the nearest half hour. Commercial and warehouse results are
 * floored at the template hours; residential may scale below.
 * @param {number} templateHours - Hours from ZPTB template card
 * @param {number} projectSqFt - Square footage from project card
 * @param {string|object|boolean} [opts] - Project type, {type}, or legacy boolean
 * @returns {number} Scaled hours
 */
function calcAdjustedHours(templateHours, projectSqFt, opts) {
  var type = normalizeType(opts);
  var baseline = TYPE_BENCHMARKS[type];
  var hours = templateHours;
  if (projectSqFt && projectSqFt > 0) {
    var factor = projectSqFt / baseline;
    if (FLOORED_TYPES[type] && factor < 1) factor = 1;
    hours = templateHours * factor;
  }
  return Math.round(hours * 2) / 2;
}

/**
 * Labels array from a card or an array of labels.
 */
function labelsOf(cardOrLabels) {
  return Array.isArray(cardOrLabels)
    ? cardOrLabels
    : (cardOrLabels && Array.isArray(cardOrLabels.labels) ? cardOrLabels.labels : []);
}

function hasLabel(cardOrLabels, name) {
  var want = String(name).trim().toLowerCase();
  return labelsOf(cardOrLabels).some(function (l) {
    var n = (typeof l === 'string') ? l : (l && l.name);
    return typeof n === 'string' && n.trim().toLowerCase() === want;
  });
}

/**
 * True when the card carries a label named "warehouse" (case-insensitive).
 * @param {object|Array} cardOrLabels
 * @returns {boolean}
 */
function hasWarehouseLabel(cardOrLabels) {
  return hasLabel(cardOrLabels, 'warehouse');
}

/**
 * True when the card carries a label named "commercial" (case-insensitive).
 */
function hasCommercialLabel(cardOrLabels) {
  return hasLabel(cardOrLabels, 'commercial');
}

/**
 * Project type from card labels: warehouse wins over commercial, which wins
 * over residential. Unlabeled cards fall back to residential.
 * @param {object|Array} cardOrLabels
 * @returns {string} residential | commercial | warehouse
 */
function projectTypeFromLabels(cardOrLabels) {
  if (hasWarehouseLabel(cardOrLabels)) return 'warehouse';
  if (hasCommercialLabel(cardOrLabels)) return 'commercial';
  return 'residential';
}

// ===== Eastern Time Helpers ================================================

/**
 * Get ET offset in hours behind UTC for a given date.
 * Returns 4 (EDT) or 5 (EST).
 */
function getETOffset(date) {
  var d = date || new Date();
  var str = d.toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
  return str.indexOf('EDT') >= 0 ? 4 : 5;
}

/**
 * Extract ET (America/New_York) date/time components from a Date or ISO string.
 */
function getETComponents(input) {
  var d = typeof input === 'string' ? new Date(input) : input;
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  var parts = fmt.formatToParts(d);
  function p(type) { return parseInt(parts.find(function(x) { return x.type === type; }).value, 10); }
  return { year: p('year'), month: p('month'), day: p('day'), hour: p('hour'), minute: p('minute') };
}

/**
 * Create a Date from ET components. Returns a proper Date object whose
 * .toISOString() yields the UTC equivalent.
 */
function makeETDate(year, month, day, hour, minute) {
  var test = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  var offset = getETOffset(test);
  return new Date(Date.UTC(year, month - 1, day, hour + offset, minute || 0, 0));
}

// ===== Holiday Calendar ====================================================

// Days the studio does not work. Fixed-date holidays are observed on the
// nearest weekday (Saturday moves to Friday, Sunday to Monday). Floating ones
// are the nth weekday of a month, -1 meaning last.
var FIXED_HOLIDAYS = [
  [1, 1],     // New Year's Day
  [6, 19],    // Juneteenth
  [7, 4],     // Independence Day
  [11, 11],   // Veterans Day
  [12, 24],   // Christmas Eve
  [12, 25],   // Christmas Day
  [12, 31],   // New Year's Eve
];
var FLOATING_HOLIDAYS = [
  { month: 1, weekday: 1, nth: 3 },    // Martin Luther King Day
  { month: 2, weekday: 1, nth: 3 },    // Presidents Day
  { month: 5, weekday: 1, nth: -1 },   // Memorial Day
  { month: 9, weekday: 1, nth: 1 },    // Labor Day
  { month: 10, weekday: 1, nth: 2 },   // Columbus Day
  { month: 11, weekday: 4, nth: 4 },   // Thanksgiving
];

var _holidayCache = {};

function dayStamp(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function weekdayOf(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nthWeekdayOfMonth(y, m, weekday, nth) {
  if (nth > 0) {
    var first = weekdayOf(y, m, 1);
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  var lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return lastDay - ((weekdayOf(y, m, lastDay) - weekday + 7) % 7);
}

function holidaySetForYear(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  var set = {};
  // Neighbour years too, so a Saturday New Year's Day observed on Dec 31 and
  // a Sunday December holiday observed in January both land in this set.
  [year - 1, year, year + 1].forEach(function (y) {
    FIXED_HOLIDAYS.forEach(function (h) {
      var m = h[0], d = h[1];
      var dow = weekdayOf(y, m, d);
      if (dow === 6) d -= 1;
      else if (dow === 0) d += 1;
      var dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() === year) {
        set[dayStamp(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())] = true;
      }
    });
    if (y === year) {
      FLOATING_HOLIDAYS.forEach(function (h) {
        set[dayStamp(y, h.month, nthWeekdayOfMonth(y, h.month, h.weekday, h.nth))] = true;
      });
      // Day after Thanksgiving
      set[dayStamp(y, 11, nthWeekdayOfMonth(y, 11, 4, 4) + 1)] = true;
    }
  });
  _holidayCache[year] = set;
  return set;
}

function isHoliday(c) {
  return !!holidaySetForYear(c.year)[dayStamp(c.year, c.month, c.day)];
}

/**
 * Weekend or studio holiday, given ET components.
 */
function isClosedDay(c) {
  var dow = new Date(c.year, c.month - 1, c.day).getDay();
  return dow === 0 || dow === 6 || isHoliday(c);
}

/**
 * Move ET components by a whole number of days, normalizing month rollover.
 */
function bumpDay(c, n) {
  var d = new Date(Date.UTC(c.year, c.month - 1, c.day + n));
  c.year = d.getUTCFullYear();
  c.month = d.getUTCMonth() + 1;
  c.day = d.getUTCDate();
}

/**
 * 9 AM ET on the given day, or on the next open day if that day is closed.
 */
function openDay9am(dateLike) {
  var c = getETComponents(dateLike);
  while (isClosedDay(c)) bumpDay(c, 1);
  return makeETDate(c.year, c.month, c.day, 9, 0);
}

/**
 * 4 PM ET on the given day, or on the next open day if that day is closed.
 * Used for waiting items, whose due date is a deadline rather than work.
 */
function workdayEndET(dateLike) {
  var c = getETComponents(dateLike);
  while (isClosedDay(c)) bumpDay(c, 1);
  return makeETDate(c.year, c.month, c.day, 16, 0);
}

/**
 * Return the next business day at 9 AM ET, starting from "the day after
 * the given date". Skips weekends and studio holidays.
 * @param {Date|string} fromDate
 * @returns {Date} Next business day at 9 AM ET
 */
function nextBusinessDay9am(fromDate) {
  var c = getETComponents(new Date(new Date(fromDate).getTime() + 86400000));
  while (isClosedDay(c)) bumpDay(c, 1);
  return makeETDate(c.year, c.month, c.day, 9, 0);
}

// ===== Business Hours Calculator ===========================================

/**
 * Add a duration in hours to a starting point, advancing through
 * 9AM-4PM ET workdays and skipping weekends.
 *
 * @param {Date} startDate - Start Date object (assumed to be an ET time
 *   already, i.e., its UTC representation matches an ET wall-clock + offset)
 * @param {number} hoursToAdd - Duration in hours (e.g. 5, 0.5, 10.25)
 * @returns {Date} End date as Date object (same scheme — UTC with ET offset
 *   baked in)
 */
function addBusinessHours(startDate, hoursToAdd) {
  var remainingMin = Math.round(hoursToAdd * 60);
  var c = getETComponents(startDate);

  while (remainingMin > 0) {
    // Weekend or studio holiday
    if (isClosedDay(c)) {
      bumpDay(c, 1);
      c.hour = 9;
      c.minute = 0;
      continue;
    }

    // Before work hours -> jump to 9 AM
    if (c.hour < 9) {
      c.hour = 9;
      c.minute = 0;
      continue;
    }

    // After work hours (>= 4 PM) -> next day 9 AM
    if (c.hour >= 16) {
      bumpDay(c, 1);
      c.hour = 9;
      c.minute = 0;
      continue;
    }

    // Within the workday — how many minutes left today?
    var minLeftToday = (16 - c.hour) * 60 - c.minute;

    if (minLeftToday >= remainingMin) {
      // Finishes today
      c.minute += remainingMin;
      c.hour += Math.floor(c.minute / 60);
      c.minute = c.minute % 60;
      remainingMin = 0;
    } else {
      // Uses rest of today, continues next workday
      remainingMin -= minLeftToday;
      bumpDay(c, 1);
      c.hour = 9;
      c.minute = 0;
    }
  }

  return makeETDate(c.year, c.month, c.day, c.hour, c.minute);
}

// ===== Schedule Calculator ==================================================

/**
 * Calculate sequential start/due times for a list of tasks.
 *
 * A waiting item has no work of its own but holds the chain for a number of
 * calendar days:
 *   { shortLink, hours: 0, waitDays: 7, waitTo: 'end' }
 * 'end' lands the due date at 4 PM on the target day (a deadline someone else
 * must meet). 'start' lands it at 9 AM on the target day (lead time before an
 * event such as a meeting). Non-waiting entries are { shortLink, hours }.
 * item.marker overrides the duration written to the hidden marker.
 *
 * @param {Array} hoursList - Array of {shortLink, hours, waitDays?, waitTo?, marker?}
 * @param {Date} anchorDate - The chain starts the next business day at 9 AM.
 * @returns {Array} Array of {shortLink, startISO, dueISO, scaledHours}
 */
function calculateSchedule(hoursList, anchorDate) {
  if (!hoursList || hoursList.length === 0) return [];

  var results = [];
  var cursor = nextBusinessDay9am(anchorDate);

  for (var i = 0; i < hoursList.length; i++) {
    var item = hoursList[i];
    var waitDays = item.waitDays || 0;

    if (waitDays > 0) {
      var target = new Date(cursor.getTime() + waitDays * 86400000);
      cursor = (item.waitTo === 'end') ? workdayEndET(target) : openDay9am(target);
    }

    var hours = item.hours || 0;
    if (hours <= 0) {
      results.push({
        shortLink: item.shortLink,
        startISO: waitDays > 0 ? cursor.toISOString() : null,
        dueISO: waitDays > 0 ? cursor.toISOString() : null,
        scaledHours: item.marker || 0,
      });
      continue;
    }

    var startISO = cursor.toISOString();
    var endDate = addBusinessHours(cursor, hours);
    results.push({
      shortLink: item.shortLink,
      startISO: startISO,
      dueISO: endDate.toISOString(),
      scaledHours: item.marker || hours,
    });

    cursor = endDate;
  }

  return results;
}

// ===== Hidden Markdown =====================================================

/**
 * Build the hidden start-date markdown suffix for board-visualizer compatibility.
 * Format: " [ ](start_date=YYYY-MM-DD)"
 * LEGACY: kept for backward compatibility with existing checkitem names.
 * New schedules emit the duration form (buildDurationMarkdown) instead.
 */
function buildStartDateMarkdown(isoString) {
  if (!isoString) return '';
  var d = new Date(isoString);
  var c = getETComponents(d);
  var ymd = String(c.year) + '-' +
    String(c.month).padStart(2, '0') + '-' +
    String(c.day).padStart(2, '0');
  return ' [ ](start_date=' + ymd + ')';
}

/**
 * Build the hidden duration markdown suffix for board-visualizer compatibility.
 * Format: " [ ](duration=N)" where N is the task's scaled hours (e.g. 32).
 * Duration is the invariant: the visualizer derives the span as due minus
 * duration, so the marker never goes stale when a due date is re-stamped.
 */
function buildDurationMarkdown(scaledHours) {
  if (!scaledHours || scaledHours <= 0) return '';
  var n = Math.round(scaledHours * 10) / 10;
  return ' [ ](duration=' + n + ')';
}

// ===== Exports ==============================================================

module.exports = {
  parseAreaSqFt: parseAreaSqFt,
  calcAdjustedHours: calcAdjustedHours,
  hasWarehouseLabel: hasWarehouseLabel,
  hasCommercialLabel: hasCommercialLabel,
  projectTypeFromLabels: projectTypeFromLabels,
  nextBusinessDay9am: nextBusinessDay9am,
  openDay9am: openDay9am,
  workdayEndET: workdayEndET,
  isClosedDay: isClosedDay,
  addBusinessHours: addBusinessHours,
  calculateSchedule: calculateSchedule,
  buildStartDateMarkdown: buildStartDateMarkdown,
  buildDurationMarkdown: buildDurationMarkdown,
  BENCHMARK_SQFT: BENCHMARK_SQFT,
  TYPE_BENCHMARKS: TYPE_BENCHMARKS,
  DEFAULT_WAIT_DAYS: DEFAULT_WAIT_DAYS,
  BOOKING_LEAD_DAYS: BOOKING_LEAD_DAYS,
};
