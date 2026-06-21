// =============================================================================
// pdf.js — Shared Puppeteer/PDF module for ZINN Railway services
// Provides Chrome lifecycle management, standard PDF rendering options,
// and both in-process and subprocess-worker PDF generation.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ─── Chrome Path Resolution ──────────────────────────────────────────────────

/**
 * Get Puppeteer launch options with automatic Chrome path resolution.
 * Works on Railway (where Chrome is installed via Puppeteer postinstall)
 * and locally on macOS.
 * @returns {object} Puppeteer launchOpts object
 */
function getLaunchOptions() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  // 1. Explicit path from env var
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    return opts;
  }

  // 2. Try puppeteer's installed browser
  try {
    const puppeteer = require('puppeteer');
    const execPath = puppeteer.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      opts.executablePath = execPath;
      return opts;
    }
  } catch { /* fall through */ }

  // 3. Try system-installed Chrome/Chromium
  try {
    const { execSync } = require('child_process');
    const paths = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
    for (const p of paths) {
      try {
        const out = execSync(`which ${p} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (out) {
          opts.executablePath = out;
          return opts;
        }
      } catch { /* try next */ }
    }
  } catch { /* exec not available */ }

  // No custom path — let Puppeteer find it (may fail on some systems)
  console.warn('[shared/pdf] No Chrome path found — letting Puppeteer auto-detect');
  return opts;
}

// ─── PDF Options ─────────────────────────────────────────────────────────────

/**
 * Standard PDF options for ZINN documents.
 * @param {object} [overrides] - Override any option
 * @returns {object} PDF options for Puppeteer page.pdf()
 */
function getPdfOptions(overrides = {}) {
  return {
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: false,
    margin: {
      top: '0.75in',
      bottom: '0.75in',
      left: '0.75in',
      right: '0.75in',
    },
    displayHeaderFooter: false,
    ...overrides,
  };
}

// ─── In-Process Rendering ────────────────────────────────────────────────────

/**
 * Launch Puppeteer, render HTML to PDF, and return the buffer.
 * Handles full lifecycle: launch → page → setContent → pdf → close.
 * Use this for quick, one-off renders in non-critical paths.
 *
 * @param {string} html - Full HTML document string
 * @param {object} [pdfOpts] - Options for page.pdf() (see getPdfOptions)
 * @param {object} [launchOpts] - Override launch options
 * @returns {Promise<Buffer>} PDF bytes
 */
async function renderPdf(html, pdfOpts = {}, launchOpts = {}) {
  const puppeteer = require('puppeteer');
  const options = { ...getPdfOptions(), ...pdfOpts };
  const launch = { ...getLaunchOptions(), ...launchOpts };

  const browser = await puppeteer.launch(launch);
  try {
    const page = await browser.newPage();

    // Block tracking/analytics/font/xhr requests that can hang PDF generation
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      const type = req.resourceType();
      if (url.includes('analytics') || url.includes('facebook') || url.includes('doubleclick') ||
          url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') ||
          type === 'fetch' || type === 'xhr') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for layout/fonts to settle
    await new Promise(r => setTimeout(r, 2000));

    const buf = await page.pdf(options);
    console.log(`[shared/pdf] Generated PDF (in-process): ${(buf.length / 1024).toFixed(1)} KB`);
    return buf;
  } finally {
    await browser.close();
  }
}

// ─── Subprocess Worker Rendering ─────────────────────────────────────────────

/**
 * Source for the worker subprocess script.
 * Runs Puppeteer in isolation and communicates via stdin/stdout.
 * This prevents Chrome crashes from killing the parent Express server.
 *
 * @type {string}
 */
const WORKER_SOURCE = `#!/usr/bin/env node
'use strict';
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  try {
    const execPath = puppeteer.executablePath();
    if (execPath && require('fs').existsSync(execPath)) {
      return execPath;
    }
  } catch { /* not available */ }
  try {
    const paths = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
    for (const p of paths) {
      try {
        const out = execSync('which ' + p + ' 2>/dev/null', { encoding: 'utf8', timeout: 2000 }).trim();
        if (out) return out;
      } catch { /* try next */ }
    }
  } catch { /* exec not available */ }
  return undefined;
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  const { html, options } = JSON.parse(input);

  const launchOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  const chromePath = findChrome();
  if (chromePath) {
    launchOpts.executablePath = chromePath;
    console.error('[pdf-worker] Using Chrome at: ' + chromePath);
  }

  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      const type = req.resourceType();
      if (url.includes('analytics') || url.includes('facebook') ||
          url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com') ||
          type === 'fetch' || type === 'xhr') {
        req.abort();
      } else {
        req.continue();
      }
    });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    const buf = await page.pdf(options);
    process.stdout.write(Buffer.from(buf).toString('base64'));
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  process.stderr.write('pdf-worker error: ' + e.message + '\\\\n');
  process.exitCode = 1;
});
`;

/**
 * Get the path to the worker script. Creates a temp file on first call.
 * The worker script is a standalone Node.js file that runs Puppeteer
 * in a subprocess, isolating the parent from Chrome crashes.
 *
 * @returns {string} Absolute path to the worker script
 */
let _workerPath = null;
function getWorkerPath() {
  if (_workerPath) return _workerPath;

  const tmpDir = require('os').tmpdir();
  _workerPath = path.join(tmpDir, `zinn-pdf-worker-${process.pid}.cjs`);
  fs.writeFileSync(_workerPath, WORKER_SOURCE);
  fs.chmodSync(_workerPath, 0o755);
  console.log(`[shared/pdf] Worker script at: ${_workerPath}`);
  return _workerPath;
}

/**
 * Clean up the worker temp file (optional — called on process exit).
 */
function cleanupWorker() {
  if (_workerPath) {
    try { fs.unlinkSync(_workerPath); } catch { /* ignore */ }
    _workerPath = null;
  }
}

/**
 * Render HTML to PDF using a subprocess worker.
 * Spawns a Node.js child process that runs Puppeteer in isolation,
 * preventing Chrome crashes from affecting the parent server.
 *
 * Use this for production Express routes (/sign, /generate) where
 * process stability matters. For CLI/dev use, renderPdf() is simpler.
 *
 * @param {string} html - Full HTML document string
 * @param {object} [pdfOpts] - Options for page.pdf() (see getPdfOptions)
 * @returns {Promise<Buffer>} PDF bytes
 */
async function renderPdfViaWorker(html, pdfOpts = {}) {
  const options = { ...getPdfOptions(), ...pdfOpts };
  const workerPath = getWorkerPath();

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (code) => {
      if (code !== 0) {
        const msg = stderr.trim() || `Worker exited with code ${code}`;
        console.error(`[shared/pdf] Worker failed: ${msg}`);
        reject(new Error(msg));
        return;
      }

      try {
        const buf = Buffer.from(stdout, 'base64');
        console.log(`[shared/pdf] Generated PDF (via worker): ${(buf.length / 1024).toFixed(1)} KB`);
        resolve(buf);
      } catch (e) {
        reject(new Error(`Failed to decode PDF from worker: ${e.message}`));
      }
    });

    child.on('error', reject);
    child.stdin.end(JSON.stringify({ html, options }));
  });
}

// Clean up worker file on process exit
process.once('exit', cleanupWorker);
process.once('SIGINT', () => { cleanupWorker(); process.exit(); });
process.once('SIGTERM', () => { cleanupWorker(); process.exit(); });

module.exports = {
  getLaunchOptions,
  getPdfOptions,
  renderPdf,
  renderPdfViaWorker,
  getWorkerPath,
  cleanupWorker,
};

module.exports.VERSION = '1.0.0';
