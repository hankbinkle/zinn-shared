// =============================================================================
// srm_request.js — SRM Request Reporter
//
// Fire-and-forget reporter to shared_resource_listener.
// Any ZINN Railway service can import and call reportSRM() on error.
//
// Usage:
//   const srm = require('../_shared/srm_request');
//   srm.reportSRM('bug_report', 'project_automator', 'entry-actions',
//     'parse_lead_data AI failed', error.message);
//
// Requires env var: SRM_LISTENER_URL (set per-service on Railway)
// =============================================================================
'use strict';

const https = require('https');
const http = require('http');

const LISTENER_URL = process.env.SRM_LISTENER_URL || '';

/**
 * Report a request to SRM.
 *
 * @param {string} type - 'assistance_request' | 'bug_report' | 'feature_request'
 * @param {string} skill - Name of the skill (e.g. 'project_automator')
 * @param {string} service - Name of the Railway service (e.g. 'entry-actions')
 * @param {string} summary - Short one-line description
 * @param {string} context - Detailed error message or context
 */
function reportSRM(type, skill, service, summary, context) {
  if (!LISTENER_URL) {
    console.log('[srm_request] SRM_LISTENER_URL not set. Skipping report.');
    return;
  }

  try {
    const body = JSON.stringify({
      type: type,
      skill: skill || 'unknown',
      service: service || 'unknown',
      summary: summary || '',
      context: context || '',
      timestamp: new Date().toISOString(),
    });

    const url = new URL(LISTENER_URL + '/srm-request');
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, function(res) {
      res.resume(); // drain response
    });

    req.on('error', function(e) {
      console.log('[srm_request] Report failed: ' + e.message);
    });

    req.write(body);
    req.end();

    console.log('[srm_request] Reported to SRM: ' + type + ' - ' + summary);
  } catch (e) {
    console.log('[srm_request] Report error: ' + e.message);
  }
}

module.exports = {
  reportSRM: reportSRM,
  VERSION: '1.0.0',
};
