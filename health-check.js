// =============================================================================
// health-check.js — _shared module: ping all ZINN Railway services
// Returns status object for SRM audit or monitoring.
// =============================================================================
'use strict';

const https = require('https');

const SERVICES = {
  'proposal_generator': 'https://zinn-proposals-production.up.railway.app',
  'account_setup': 'https://accountsetup-production.up.railway.app',
  'proposal_estimator': 'https://skillful-insight-production-ae28.up.railway.app',
  'label_manager': 'https://zinn-labels-production.up.railway.app',
  'project_automator': 'https://entry-actions-production.up.railway.app',
  'railway_howard': 'https://railway-howard-production.up.railway.app',
  'board_visualizer': 'https://boardvisualizersyncserver-production.up.railway.app',
};

async function ping(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, ok: res.statusCode < 500, data: data.slice(0, 200) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, ok: false, data: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, data: 'timeout' }); });
  });
}

async function checkAll() {
  const results = {};
  for (const [name, url] of Object.entries(SERVICES)) {
    const r = await ping(url);
    results[name] = { url, status: r.status, ok: r.ok };
    console.log(`[health] ${r.ok ? 'OK' : 'FAIL'} ${name}: ${r.status} (${url})`);
  }
  return results;
}

if (require.main === module) {
  checkAll().catch(console.error);
}

module.exports = { checkAll, ping, SERVICES };
