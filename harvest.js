// =============================================================================
// harvest.js — Shared Harvest API module for ZINN Railway services
// Handles Harvest time tracking and invoicing: clients, projects, invoices.
// Uses credentials from shared config (HARVEST_ACCOUNT_ID, HARVEST_TOKEN).
// =============================================================================
'use strict';

const https = require('https');
const config = require('./config');

// ─── Low-Level API Call ────────────────────────────────────────────────────

/**
 * Make a Harvest API request.
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE, PATCH)
 * @param {string} endpoint - API path (e.g., 'clients', 'projects/123')
 * @param {object|null} body - Request body for POST/PUT/PATCH
 * @returns {Promise<{status: number, data: object|null}>}
 */
async function harvest(method, endpoint, body) {
  const ACCOUNT_ID = config.HARVEST_ACCOUNT_ID;
  const TOKEN = config.HARVEST_TOKEN;

  return new Promise((resolve, reject) => {
    const u = new URL(`https://api.harvestapp.com/v2/${endpoint}`);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Harvest-Account-ID': ACCOUNT_ID,
        'Content-Type': 'application/json',
        'User-Agent': 'ZINN Automation',
      },
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data: data ? { raw: data.slice(0, 500) } : null });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── Paginated Fetch ───────────────────────────────────────────────────────

/**
 * Fetch all pages of a Harvest entity (clients, projects, invoices, etc.).
 * @param {string} entity - Entity name (e.g., 'clients', 'projects', 'invoices')
 * @param {object} [filters] - Optional query params (e.g., { is_active: true })
 * @returns {Promise<Array>}
 */
async function fetchAll(entity, filters = {}) {
  const results = [];
  let page = 1;
  let totalPages = Infinity;

  while (page <= totalPages) {
    const params = new URLSearchParams({ ...filters, per_page: 200, page: String(page) });
    const res = await harvest('GET', `${entity}?${params}`);

    if (!res.data) {
      console.error(`[shared/harvest] fetchAll(${entity}) failed: HTTP ${res.status}`);
      break;
    }

    totalPages = res.data.total_pages || 1;
    const items = res.data[entity] || [];
    results.push(...items);

    if (items.length < 200) break;
    page++;
  }

  console.log(`[shared/harvest] fetchAll(${entity}): ${results.length} items`);
  return results;
}

// ─── Clients ───────────────────────────────────────────────────────────────

/**
 * Find a Harvest client by name.
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function findClient(name) {
  const clients = await fetchAll('clients');
  return clients.find(c => c.name === name) || null;
}

/**
 * Create a Harvest client.
 * @param {object} data - { name, is_active, address, currency, ... }
 * @returns {Promise<object|null>} Created client object, or null on failure
 */
async function createClient(data) {
  const res = await harvest('POST', 'clients', {
    name: data.name,
    is_active: data.is_active !== undefined ? data.is_active : true,
    ...(data.address && { address: data.address }),
    ...(data.notes && { notes: data.notes }),
  });

  if (!res.data || !res.data.id) {
    console.error(`[shared/harvest] createClient failed:`, JSON.stringify(res.data));
    return null;
  }

  console.log(`[shared/harvest] Created client #${res.data.id}: ${res.data.name}`);
  return res.data;
}

/**
 * Delete a Harvest client.
 * @param {number|string} clientId
 * @returns {Promise<boolean>}
 */
async function deleteClient(clientId) {
  try {
    await harvest('DELETE', `clients/${clientId}`);
    console.log(`[shared/harvest] Deleted client #${clientId}`);
    return true;
  } catch (e) {
    console.error(`[shared/harvest] Delete client #${clientId} failed: ${e.message}`);
    return false;
  }
}

// ─── Update Client ───────────────────────────────────────────────────────────

/**
 * Update a Harvest client (e.g., toggle is_active).
 * @param {number|string} clientId
 * @param {object} data - Fields to update (e.g., { is_active: false })
 * @returns {Promise<object|null>}
 */
async function updateClient(clientId, data) {
  const res = await harvest('PATCH', `clients/${clientId}`, data);
  if (!res.data || !res.data.id) {
    console.error(`[shared/harvest] updateClient #${clientId} failed:`, JSON.stringify(res.data));
    return null;
  }
  console.log(`[shared/harvest] Updated client #${res.data.id}: ${res.data.name} (is_active=${res.data.is_active})`);
  return res.data;
}

// ─── Projects ──────────────────────────────────────────────────────────────

/**
 * Find a Harvest project by name and client ID.
 * @param {string} name
 * @param {number|string} clientId
 * @returns {Promise<object|null>}
 */
async function findProject(name, clientId) {
  const projects = await fetchAll('projects');
  return projects.find(p => p.name === name && p.client?.id === clientId) || null;
}

/**
 * Create a Harvest project.
 * @param {object} data - Project creation payload
 * @returns {Promise<object|null>}
 */
async function createProject(data) {
  const res = await harvest('POST', 'projects', data);

  if (!res.data || !res.data.id) {
    console.error(`[shared/harvest] createProject failed:`, JSON.stringify(res.data));
    return null;
  }

  console.log(`[shared/harvest] Created project #${res.data.id}: ${res.data.name}`);
  return res.data;
}

// ─── Update Project ───────────────────────────────────────────────────────────

/**
 * Update a Harvest project (e.g., toggle is_active).
 * @param {number|string} projectId
 * @param {object} data - Fields to update (e.g., { is_active: false })
 * @returns {Promise<object|null>}
 */
async function updateProject(projectId, data) {
  const res = await harvest('PATCH', `projects/${projectId}`, data);
  if (!res.data || !res.data.id) {
    console.error(`[shared/harvest] updateProject #${projectId} failed:`, JSON.stringify(res.data));
    return null;
  }
  console.log(`[shared/harvest] Updated project #${res.data.id}: ${res.data.name} (is_active=${res.data.is_active})`);
  return res.data;
}

// ─── Invoices ──────────────────────────────────────────────────────────────

/**
 * Create a Harvest invoice.
 * @param {object} data - Invoice creation payload
 * @returns {Promise<object|null>}
 */
async function createInvoice(data) {
  const res = await harvest('POST', 'invoices', data);

  if (!res.data || !res.data.id) {
    console.error(`[shared/harvest] createInvoice failed:`, JSON.stringify(res.data));
    return null;
  }

  console.log(`[shared/harvest] Created invoice #${res.data.id} for $${res.data.total}`);
  return res.data;
}

/**
 * Find existing invoices for a project.
 * @param {number|string} projectId
 * @returns {Promise<Array>}
 */
async function findInvoices(projectId) {
  const invoices = await fetchAll('invoices', { project_id: projectId });
  return invoices;
}

// ─── Projects (single) ─────────────────────────────────────────────────────

/**
 * Fetch a single Harvest project by ID.
 * @param {number|string} projectId
 * @returns {Promise<object|null>}
 */
async function getProject(projectId) {
  const res = await harvest('GET', 'projects/' + projectId);
  if (!res.data || !res.data.id) {
    console.error('[shared/harvest] getProject #' + projectId + ' failed:', JSON.stringify(res.data));
    return null;
  }
  return res.data;
}

// ─── Time Entries ────────────────────────────────────────────────────────────

/**
 * Fetch time entries for a project, optionally filtered by date range.
 * @param {number|string} projectId
 * @param {object} [opts] - { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 * @returns {Promise<Array>} Array of time entry objects
 */
async function getTimeEntries(projectId, opts) {
  var filters = { project_id: projectId };
  if (opts && opts.from) filters.from = opts.from;
  if (opts && opts.to) filters.to = opts.to;
  return await fetchAll('time_entries', filters);
}

module.exports = {
  harvest,
  fetchAll,
  findClient,
  createClient,
  updateClient,
  deleteClient,
  findProject,
  createProject,
  updateProject,
  createInvoice,
  findInvoices,
  getProject,
  getTimeEntries,
};

module.exports.VERSION = '1.0.0';
