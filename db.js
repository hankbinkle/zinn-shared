// =============================================================================
// db.js — Shared PostgreSQL database module for ZINN Railway services
// Manages token persistence (Dropbox OAuth tokens, etc.) in a Railway Postgres DB.
// Uses DATABASE_URL env var (auto-provided by Railway when Postgres is linked).
//
// Originally extracted from account_setup/db.js — the canonical source.
// =============================================================================
'use strict';

const { Pool } = require('pg');

let pool = null;

/**
 * Get or create the connection pool.
 */
function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('[shared/db] No DATABASE_URL set — running without database persistence');
    return null;
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Railway uses self-signed certs
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[shared/db] Unexpected pool error:', err.message);
  });

  return pool;
}

/**
 * Ensure required tables exist.
 */
async function ensureTables() {
  const p = getPool();
  if (!p) return false;

  const client = await p.connect();
  try {
    // Tokens table (shared across services)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        service VARCHAR(64) NOT NULL,
        token_type VARCHAR(64) NOT NULL,
        value TEXT NOT NULL,
        expires_at BIGINT DEFAULT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (service, token_type)
      );
    `);

    // Settings table (key-value config store)
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(128) NOT NULL PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log('[shared/db] Tables ensured');
    return true;
  } catch (err) {
    console.error('[shared/db] Failed to ensure tables:', err.message);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Get a stored token from the database.
 * @param {string} service - e.g. 'dropbox'
 * @param {string} tokenType - e.g. 'refresh', 'access', 'app_key'
 * @returns {Promise<{value: string, expiresAt: number|null}|null>}
 */
async function getStoredToken(service, tokenType) {
  const p = getPool();
  if (!p) return null;

  try {
    const result = await p.query(
      `SELECT value, expires_at FROM tokens WHERE service = $1 AND token_type = $2`,
      [service, tokenType]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { value: row.value, expiresAt: row.expires_at ? Number(row.expires_at) : null };
  } catch (err) {
    console.error(`[shared/db] Error reading token ${service}/${tokenType}:`, err.message);
    return null;
  }
}

/**
 * Store (upsert) a token in the database.
 * @param {string} service - e.g. 'dropbox'
 * @param {string} tokenType - e.g. 'refresh', 'access', 'app_key'
 * @param {string} value - The token value
 * @param {number|null} expiresAt - Unix ms timestamp when token expires, or null
 */
async function storeToken(service, tokenType, value, expiresAt) {
  const p = getPool();
  if (!p) return;

  try {
    await p.query(
      `INSERT INTO tokens (service, token_type, value, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (service, token_type)
       DO UPDATE SET value = $3, expires_at = $4, updated_at = NOW()`,
      [service, tokenType, value, expiresAt || null]
    );
    console.log(`[shared/db] Stored token ${service}/${tokenType} (expires_at: ${expiresAt || 'never'})`);
  } catch (err) {
    console.error(`[shared/db] Error storing token ${service}/${tokenType}:`, err.message);
  }
}

/**
 * Delete a token from the database.
 */
async function deleteToken(service, tokenType) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `DELETE FROM tokens WHERE service = $1 AND token_type = $2`,
      [service, tokenType]
    );
  } catch (err) {
    console.error(`[shared/db] Error deleting token ${service}/${tokenType}:`, err.message);
  }
}

/**
 * Get a setting value from the settings table.
 */
async function getSetting(key) {
  const p = getPool();
  if (!p) return null;
  try {
    const result = await p.query(
      `SELECT value FROM settings WHERE key = $1`,
      [key]
    );
    return result.rows.length > 0 ? result.rows[0].value : null;
  } catch (err) {
    console.error(`[shared/db] Error reading setting ${key}:`, err.message);
    return null;
  }
}

/**
 * Store (upsert) a setting value.
 */
async function setSetting(key, value) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  } catch (err) {
    console.error(`[shared/db] Error storing setting ${key}:`, err.message);
  }
}

/**
 * Initialize the database connection and ensure tables exist.
 * Call once at startup.
 */
async function initDb() {
  const p = getPool();
  if (!p) {
    console.warn('[shared/db] No DATABASE_URL — running without DB');
    return false;
  }

  try {
    const client = await p.connect();
    const result = await client.query('SELECT NOW() AS db_time');
    console.log('[shared/db] Connected. Server time:', result.rows[0].db_time);
    client.release();
    await ensureTables();
    return true;
  } catch (err) {
    console.error('[shared/db] Connection failed:', err.message);
    return false;
  }
}

/**
 * Gracefully close the pool (for shutdown).
 */
async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[shared/db] Pool closed');
  }
}

module.exports = {
  initDb,
  closeDb,
  getStoredToken,
  storeToken,
  deleteToken,
  getSetting,
  setSetting,
};

module.exports.VERSION = '1.0.0';
