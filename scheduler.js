// =============================================================================
// scheduler.js — Duration/scheduling utilities for ZINN project tasks
//
// Converts template hours into scaled durations, calculates sequential
// due dates within business hours (9AM-5PM ET, weekdays only), and
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

var BENCHMARK_SQFT = 2000;

/**
 * Scale template hours by project size relative to the 2000 sq ft benchmark.
 * Rounds to the nearest half hour.
 * @param {number} templateHours - Hours from ZPTB template card
 * @param {number} projectSqFt - Square footage from project card
 * @returns {number} Scaled hours
 */
function calcAdjustedHours(templateHours, projectSqFt) {
  if (!projectSqFt || projectSqFt <= 0) return templateHours;
  var raw = templateHours * (projectSqFt / BENCHMARK_SQFT);
  return Math.round(raw * 2) / 2;
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

/**
 * Return the next business day at 9 AM ET, starting from "the day after
 * the given date". Skips weekends.
 * @param {Date|string} fromDate
 * @returns {Date} Next business day at 9 AM ET
 */
function nextBusinessDay9am(fromDate) {
  var src = new Date(fromDate);
  // Tomorrow
  var tomorrow = new Date(src.getTime() + 86400000);
  var comp = getETComponents(tomorrow);
  // Advance past Saturday (6) and Sunday (0)
  var dow = new Date(comp.year, comp.month - 1, comp.day).getDay();
  while (dow === 0 || dow === 6) {
    comp.day += 1;
    dow = new Date(comp.year, comp.month - 1, comp.day).getDay();
  }
  return makeETDate(comp.year, comp.month, comp.day, 9, 0);
}

// ===== Business Hours Calculator ===========================================

/**
 * Add a duration in hours to a starting point, advancing through
 * 9AM-5PM ET workdays and skipping weekends.
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
    // Weekend check
    var dow = new Date(c.year, c.month - 1, c.day).getDay();
    if (dow === 0 || dow === 6) {
      c.day += (dow === 6) ? 2 : 1;
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

    // After work hours (>= 5 PM) -> next day 9 AM
    if (c.hour >= 17) {
      c.day += 1;
      c.hour = 9;
      c.minute = 0;
      continue;
    }

    // Within the workday — how many minutes left today?
    var minLeftToday = (17 - c.hour) * 60 - c.minute;

    if (minLeftToday >= remainingMin) {
      // Finishes today
      c.minute += remainingMin;
      c.hour += Math.floor(c.minute / 60);
      c.minute = c.minute % 60;
      remainingMin = 0;
    } else {
      // Uses rest of today, continues next workday
      remainingMin -= minLeftToday;
      c.day += 1;
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
 * @param {Array} hoursList - Array of {shortLink, hours} objects.
 *   hours is the adjusted (scaled) duration for each task.
 * @param {Date} anchorDate - First task starts the next business day at 9 AM
 *   after this date.
 * @returns {Array} Array of {shortLink, startISO, dueISO, scaledHours}
 */
function calculateSchedule(hoursList, anchorDate) {
  if (!hoursList || hoursList.length === 0) return [];

  var results = [];
  var cursor = nextBusinessDay9am(anchorDate);

  for (var i = 0; i < hoursList.length; i++) {
    var item = hoursList[i];

    if (!item.hours || item.hours <= 0) {
      results.push({
        shortLink: item.shortLink,
        startISO: null,
        dueISO: null,
        scaledHours: 0,
      });
      continue;
    }

    var startISO = cursor.toISOString();
    var endDate = addBusinessHours(cursor, item.hours);
    var dueISO = endDate.toISOString();

    results.push({
      shortLink: item.shortLink,
      startISO: startISO,
      dueISO: dueISO,
      scaledHours: item.hours,
    });

    cursor = endDate;
  }

  return results;
}

// ===== Hidden Markdown =====================================================

/**
 * Build the hidden start-date markdown suffix for board-visualizer compatibility.
 * Format: " [ ](start_date=YYYY-MM-DD)"
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

// ===== Exports ==============================================================

module.exports = {
  parseAreaSqFt: parseAreaSqFt,
  calcAdjustedHours: calcAdjustedHours,
  nextBusinessDay9am: nextBusinessDay9am,
  addBusinessHours: addBusinessHours,
  calculateSchedule: calculateSchedule,
  buildStartDateMarkdown: buildStartDateMarkdown,
  BENCHMARK_SQFT: BENCHMARK_SQFT,
};
