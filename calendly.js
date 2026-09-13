// =============================================================================
// calendly.js -- Calendly v2 API client (shared module)
//
// Scope used: scheduled_events:read (personal token for the zinn_ai account,
// user FEHCI6LOMAVWAHI5). Reads bookings across the account's event types --
// including meetings hosted by other team members, who appear in
// event_memberships on each event.
//
// The API requires the user filter in FULL URI form (not bare UUID), and the
// invitee details (email, name, timezone, status) live on a per-event
// sub-resource. This module hides both details.
// =============================================================================

'use strict';

const https = require('https');

const API_BASE = 'https://api.calendly.com';
const USER_URI =
  process.env.CALENDLY_USER_URI ||
  'https://api.calendly.com/users/FEHCI6LOMAVWAHI5';

function calendlyGet(path) {
  return new Promise(function(resolve, reject) {
    const token = process.env.CALENDLY_TOKEN || '';
    if (!token) {
      reject(new Error('CALENDLY_TOKEN not set'));
      return;
    }
    const u = new URL(API_BASE + path);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      },
      function(res) {
        let body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error('Calendly GET ' + path + ' failed: ' + res.statusCode + ' ' + body.slice(0, 200)));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Calendly GET ' + path + ' JSON parse: ' + e.message));
          }
        });
      }
    );
    req.on('error', function(e) {
      reject(new Error('Calendly GET ' + path + ' request: ' + e.message));
    });
    req.end();
  });
}

// List scheduled events for the zinn_ai account (all event types, any host).
// status=active excludes canceled/deleted bookings.
// Returns the full response body: { collection, pagination }.
async function listScheduledEvents(opts) {
  opts = opts || {};
  const params = new URLSearchParams();
  params.set('user', USER_URI); // full URI form is required by the API
  params.set('status', 'active');
  params.set('count', String(opts.count || 100));
  if (opts.minStartTime) params.set('min_start_time', opts.minStartTime);
  if (opts.maxStartTime) params.set('max_start_time', opts.maxStartTime);
  if (opts.pageToken) params.set('page_token', opts.pageToken);
  return await calendlyGet('/scheduled_events?' + params.toString());
}

// Invitees for one event (email, name, status, timezone). Event URI is the
// full "https://api.calendly.com/scheduled_events/<UUID>" form.
async function getInvitees(eventUri) {
  const p = eventUri.replace(API_BASE, '') + '/invitees';
  const data = await calendlyGet(p);
  return data.collection || [];
}

module.exports = { listScheduledEvents, getInvitees, calendlyGet, USER_URI, API_BASE };
module.exports.VERSION = '1.0.0';
