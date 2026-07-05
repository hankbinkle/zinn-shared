// =============================================================================
// email.js — Shared Gmail send module for ZINN Railway services
// Handles Gmail API authentication, branded HTML email sending, and drafts.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { GMAIL_CREDS_PATH, GMAIL_TOKEN_PATH, LOCAL_DROPBOX_ROOT } = require('./config');

// ─── Auth ─────────────────────────────────────────────────────────────────

let cachedGmailClient = null;

/**
 * Get an authenticated Gmail API client.
 * Works both locally (file-based credentials) and on Railway (env vars).
 * @returns {Promise<object|null>} Gmail API client or null
 */
async function getGmailClient() {
  if (cachedGmailClient) return cachedGmailClient;

  // Railway mode: credentials may be in env vars as JSON strings
  // Also checks GMAIL_CREDENTIALS / GMAIL_TOKEN (base64-encoded fallback)
  let credentials, token;

  if (process.env.GMAIL_CREDENTIALS_JSON) {
    try { credentials = JSON.parse(process.env.GMAIL_CREDENTIALS_JSON); } catch { credentials = null; }
  }
  if (!credentials && process.env.GMAIL_CREDENTIALS) {
    try { credentials = JSON.parse(Buffer.from(process.env.GMAIL_CREDENTIALS, 'base64').toString()); } catch { credentials = null; }
  }

  if (process.env.GMAIL_TOKEN_JSON) {
    try { token = JSON.parse(process.env.GMAIL_TOKEN_JSON); } catch { token = null; }
  }
  if (!token && process.env.GMAIL_TOKEN) {
    try { token = JSON.parse(Buffer.from(process.env.GMAIL_TOKEN, 'base64').toString()); } catch { token = null; }
  }

  // Local mode: file-based
  if (!credentials && fs.existsSync(GMAIL_CREDS_PATH)) {
    credentials = JSON.parse(fs.readFileSync(GMAIL_CREDS_PATH, 'utf8'));
  }
  if (!token && fs.existsSync(GMAIL_TOKEN_PATH)) {
    token = JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH, 'utf8'));
  }

  if (!credentials || !token) {
    console.log('[shared/email] Gmail credentials not found — emails will be skipped');
    return null;
  }

  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web || credentials;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || 'http://localhost');
  oAuth2Client.setCredentials(token);

  // Auto-refresh if needed
  oAuth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      console.log('[shared/email] Gmail token auto-refreshed');
    }
  });

  cachedGmailClient = google.gmail({ version: 'v1', auth: oAuth2Client });
  return cachedGmailClient;
}

// ─── Email Building ───────────────────────────────────────────────────────

const FONT = "'Avenir Next', Avenir, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Encode a subject line, stripping problematic characters.
 */
function encodeSubject(str) {
  return str.replace(/—/g, '-').replace(/–/g, '-').replace(/"/g, '').replace(/'/g, '');
}

/**
 * Build the ZINN header logo CID tag for Gmail inline embedding.
 * @param {object} [logoBuffer] - Buffer of the logo image, or null to read from disk
 * @returns {{html: string, buffer: Buffer|null}}
 */
function buildHeaderLogoTag(logoBuffer) {
  if (!logoBuffer) {
    // Try project-local assets path first (works on Railway too)
    const projectAssetPath = path.join(__dirname, '..', 'assets', 'logo-email.png');
    try { logoBuffer = fs.readFileSync(projectAssetPath); } catch { logoBuffer = null; }
  }
  if (!logoBuffer) {
    // Try canonical skills-level assets path (local dev, all skills)
    const canonPath = '/Users/robzinn/.openclaw/skills/assets/logo-email.png';
    try { logoBuffer = fs.readFileSync(canonPath); } catch { logoBuffer = null; }
  }
  if (!logoBuffer) {
    // Fall back to Dropbox path (local dev)
    const logoPath = path.join(LOCAL_DROPBOX_ROOT, 'marketing/branding/logos/_logo-email.png');
    try { logoBuffer = fs.readFileSync(logoPath); } catch { logoBuffer = null; }
  }
  if (!logoBuffer) {
    console.log('[shared/email] WARNING: Logo file not found, using text fallback');
  }

  return {
    html: logoBuffer
      ? `<img src="cid:zinn-logo" alt="ZINN Architecture" width="120" style="display:block;margin:0 0 24px 0;">`
      : '',
    buffer: logoBuffer,
  };
}

/**
 * Build a branded ZINN email body as an HTML string.
 * Simple wrapper with signature. For richer document layout, use buildDocumentEmail().
 * @param {string} contentHtml - The email's inner content (no wrapper)
 * @param {object} [opts]
 * @param {string} [opts.font=FONT]
 * @returns {string} Full HTML email body
 */
function buildEmailBody(contentHtml, opts = {}) {
  const font = opts.font || FONT;
  const bgColor = '#f0f0f0';
  const panelColor = '#ffffff';
  const textColor = '#242C39';

  // Optionally add logo header row
  var logoRow = '';
  if (opts.logo) {
    var logoT = buildHeaderLogoTag(opts.logoBuffer);
    if (logoT.html) {
      logoRow = '<tr><td style="padding:0 0 24px 0;">' + logoT.html + '</td></tr>';
    }
  }

  return [
    '<div style="background:' + bgColor + ';padding:40px 20px;font-family:' + font + ';">',
    '  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;">',
    '    <tr><td style="background:' + panelColor + ';padding:32px 40px;border-radius:4px;">',
    '      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">',
             logoRow,
    '        <tr><td style="padding:0 0 24px 0;">',
    '          <div style="font-family:' + font + ';font-size:14px;color:' + textColor + ';line-height:1.8;">' + contentHtml + '</div>',
    '        </td></tr>',
    '        <tr><td style="padding:0;"></td></tr>',
    '      </table>',
    '    </td></tr>',
    '  </table>',
    '</div>',
  ].join('\n');
}

/**
 * Build a branded ZINN document email with full masthead and Rob's signature block.
 * Richer layout than buildEmailBody() — includes logo at top, divider, body, Rob's signature, phone, footer.
 * Used for proposals, agreements, and other formal documents.
 *
 * @param {string} contentHtml — Inner content (greeting, body, etc.)
 * @param {object} [opts]
 * @param {string} [opts.recipientName] — If provided, adds "Hello {name}," greeting
 * @param {string} [opts.introHtml] — Additional intro block before body
 * @param {Buffer} [opts.logoBuffer] — Logo buffer; auto-loaded if omitted
 * @returns {{ html: string, logoBuffer: Buffer|null }}
 */
function buildDocumentEmail(contentHtml, opts = {}) {
  const logo = buildHeaderLogoTag(opts.logoBuffer);
  const logoTag = logo.html || '<div style="font-size:16px;font-weight:400;letter-spacing:4px;color:#242C39;">ZINN</div>';

  let greetingHtml = '';
  if (opts.recipientName) {
    greetingHtml = '<p style="font-family:' + FONT + ';font-size:14px;color:#242C39;margin:0 0 20px 0;">Hello ' + opts.recipientName + ',</div>';
  }

  const parts = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="UTF-8"></head>',
    '<body style="margin:0;padding:0;background-color:#f0f0f0;">',
    '<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f0f0;padding:40px 20px;">',
    '  <tr><td align="center">',
    '    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;">',
    '      <tr><td style="background-color:#ffffff;padding:32px 40px 20px 40px;text-align:left;">' + logoTag + '</td></tr>',
    '      <tr><td style="padding:0;"><div style="border-top:1px solid #000000;margin:0 40px;"></div></td></tr>',
    '      <tr><td style="padding:32px 40px;background-color:#ffffff;">',
    '        ' + greetingHtml,
    '        ' + (opts.introHtml || ''),
              contentHtml,
    '        <div style="border-top:1px solid #E0E8EC;margin:24px 0 20px 0;"></div>',
    '        <p style="font-family:' + FONT + ';font-size:12px;color:#242C39;margin:0 0 4px 0;font-weight:600;">Rob Zinn, AIA</div>',
    '        <p style="font-family:' + FONT + ';font-size:12px;color:#242C39;margin:0 0 2px 0;"><a href="https://zinn.ai" style="color:#242C39;text-decoration:none;">zinn.ai</a></div>',
    '        <p style="font-family:' + FONT + ';font-size:12px;color:#242C39;margin:0;">904.257.6117</div>',
    '      </td></tr>',
    '      <tr><td style="background-color:#f0f0f0;padding:16px 40px;border-top:1px solid #E0E8EC;">',
    '        <p style="font-family:' + FONT + ';font-size:11px;color:#81A2B2;margin:0;text-align:center;">1022 park street #407, jacksonville, FL 32204 &nbsp;|&nbsp; <a href="https://zinn.ai" style="color:#81A2B2;text-decoration:none;">zinn.ai</a></div>',
    '      </td></tr>',
    '    </table>',
    '  </td></tr>',
    '</table>',
    '</body></html>',
  ].join('\n');

  return { html: parts, logoBuffer: logo.buffer };
}

/**
 * Build a standard post-sign notification email.
 * Uses the rich document layout with Rob's signature block.
 * @param {object} opts
 * @param {string} opts.recipientName
 * @param {string} [opts.body] — Additional body text
 * @returns {{ html: string, logoBuffer: Buffer|null }}
 */
function buildSignNotificationEmail(opts) {
  const body = opts.body || 'Thank you for signing your document with ZINN. A copy is attached to this email for your records.';
  const contentHtml = '<p style="font-family:' + FONT + ';font-size:13px;color:#4e5757;line-height:1.8;">' + body + '</div>';
  return buildDocumentEmail(contentHtml, { recipientName: opts.recipientName });
}

// ─── Send / Draft ─────────────────────────────────────────────────────────

/**
 * Create a base64-encoded RFC 2822 email message for the Gmail API.
 * @param {object} opts
 * @param {string|string[]} opts.to - Recipient email(s)
 * @param {string} [opts.cc] - CC recipient
 * @param {string} opts.subject - Email subject
 * @param {string} opts.htmlBody - HTML body content
 * @param {Buffer} [opts.logoBuffer] - Logo image for CID embedding
 * @param {Buffer} [opts.pdfBuffer] - PDF attachment
 * @param {string} [opts.pdfName] - Attachment filename
 * @returns {string} Base64url-encoded message
 */
function createMessage(opts) {
  const to = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;
  const outerBoundary = 'zinn_outer_' + Date.now();
  const innerBoundary = 'zinn_inner_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';

  // Chunk base64 at 76 chars per line (MIME spec)
  function chunkBase64(b64) {
    return b64.match(/.{1,76}/g).join(CRLF);
  }

  // Auto-load logo buffer if HTML references cid:zinn-logo but no buffer provided
  // This ensures the CID attachment is always included when the HTML expects it
  if (!opts.logoBuffer && opts.htmlBody && opts.htmlBody.includes('cid:zinn-logo')) {
    const autoLogo = buildHeaderLogoTag();
    if (autoLogo.buffer) opts.logoBuffer = autoLogo.buffer;
  }

  const htmlB64   = chunkBase64(Buffer.from(opts.htmlBody, 'utf8').toString('base64'));
  const logoB64   = opts.logoBuffer ? chunkBase64(opts.logoBuffer.toString('base64')) : null;

  const lines = [
    'From: ' + (opts.from || 'rob@zinn.ai'),
    'To: ' + to,
    opts.cc ? 'Cc: ' + opts.cc : null,
    'Subject: ' + encodeSubject(opts.subject),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + outerBoundary + '"',
    '',
    // -- inner multipart/related --
    '--' + outerBoundary,
    'Content-Type: multipart/related; boundary="' + innerBoundary + '"',
    '',
    '--' + innerBoundary,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
  ];

  if (opts.logoBuffer && logoB64) {
    lines.push(
      '',
      '--' + innerBoundary,
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <zinn-logo>',
      'X-Attachment-Id: zinn-logo',
      '',
      logoB64,
    );
  }

  lines.push('--' + innerBoundary + '--');

  if (opts.pdfBuffer && opts.pdfName) {
    const pdfB64 = chunkBase64(opts.pdfBuffer.toString('base64'));
    lines.push(
      '',
      '--' + outerBoundary,
      'Content-Type: application/pdf; name="' + opts.pdfName + '"',
      'Content-Disposition: attachment; filename="' + opts.pdfName + '"',
      'Content-Transfer-Encoding: base64',
      '',
      pdfB64,
    );
  }

  lines.push('--' + outerBoundary + '--');

  const raw = lines.filter(l => l !== null).join(CRLF);
  const b64url = Buffer.from(raw, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return b64url;
}

/**
 * Send an email via Gmail API.
 * @param {object} opts - See createMessage() for fields
 * @returns {Promise<boolean>} True if sent successfully
 */
async function sendEmail(opts) {
  const gmail = await getGmailClient();
  if (!gmail) {
    console.log('[shared/email] Cannot send — no Gmail client');
    return false;
  }

  try {
    const raw = createMessage(opts);
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    console.log('[shared/email] Sent to: ' + opts.to);
    return true;
  } catch (e) {
    console.error('[shared/email] Send failed: ' + e.message);
    return false;
  }
}

/**
 * Create a Gmail draft (not sent).
 * @param {object} opts - See createMessage() for fields
 * @returns {Promise<boolean>} True if draft created
 */
async function createDraft(opts) {
  const gmail = await getGmailClient();
  if (!gmail) {
    console.log('[shared/email] Cannot create draft — no Gmail client');
    return false;
  }

  try {
    const raw = createMessage(opts);
    await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
    console.log('[shared/email] Draft created for: ' + opts.to);
    return true;
  } catch (e) {
    console.error('[shared/email] Draft creation failed: ' + e.message);
    return false;
  }
}

/**
 * Send a failure notification email to Rob.
 * Creates a branded draft with service name, card context, and error details.
 * Subject follows standard format: "{projectName} - Error" or "{service} - Error".
 * Non-blocking — logs errors but never throws.
 *
 * @param {object} opts
 * @param {string} opts.service - Short service name (e.g., 'account_setup', 'labels')
 * @param {string} opts.error - Error message or description
 * @param {string} [opts.cardName] - Trello card name if applicable (used as project name)
 * @param {string} [opts.cardId] - Trello card ID if applicable
 * @param {boolean} [opts.send=false] - If true, sends immediately. Defaults to draft.
 */
async function notifyOnFailure(opts) {
  const projectLabel = opts.cardName || opts.service;
  const subject = projectLabel + ' - Error';

  const cardLink = opts.cardId
    ? '<a href="https://trello.com/c/' + opts.cardId + '">' + (opts.cardName || opts.cardId) + '</a>'
    : opts.cardName || '';

  // Convert markdown links [text](url) to HTML anchor tags in the error text
  var errHtml = (opts.error || '').replace(/\n/g, '<br>');
  errHtml = errHtml.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const contentHtml = [
    '<div><p><strong>' + opts.service + '</strong> encountered an error.</p>',
    cardLink ? '<p>Card: ' + cardLink + '</p>' : '',
    '<p>' + errHtml + '</p>',
    '<p style="color:#999;font-size:11px;">This notification was auto-generated.</p></div>',
  ].filter(Boolean).join('\n');

  const htmlBody = buildEmailBody(contentHtml);

  try {
    if (opts.draft) {
      await createDraft({ to: 'rob@zinn.ai', subject: subject, htmlBody: htmlBody });
    } else {
      await sendEmail({ to: 'rob@zinn.ai', subject: subject, htmlBody: htmlBody });
    }
    return true;
  } catch (e) {
    console.error('[shared/email] notifyOnFailure failed: ' + e.message);
    return false;
  }
}

// ─── Google OAuth2 Token (direct HTTPS, Railway-safe) ─────────────────────

let cachedCreds = null;
let cachedToken = null;

/**
 * Load Google OAuth2 credentials from env vars or local files.
 * Shared by getGoogleAccessToken() and getGoogleOAuth2Client().
 */
function loadGoogleCreds() {
  if (cachedCreds) return cachedCreds;

  let credentials, token;

  if (process.env.GMAIL_CREDENTIALS_JSON) {
    try { credentials = JSON.parse(process.env.GMAIL_CREDENTIALS_JSON); } catch { credentials = null; }
  }
  if (!credentials && process.env.GMAIL_CREDENTIALS) {
    try { credentials = JSON.parse(Buffer.from(process.env.GMAIL_CREDENTIALS, 'base64').toString()); } catch { credentials = null; }
  }

  if (process.env.GMAIL_TOKEN_JSON) {
    try { token = JSON.parse(process.env.GMAIL_TOKEN_JSON); } catch { token = null; }
  }
  if (!token && process.env.GMAIL_TOKEN) {
    try { token = JSON.parse(Buffer.from(process.env.GMAIL_TOKEN, 'base64').toString()); } catch { token = null; }
  }

  if (!credentials && fs.existsSync(GMAIL_CREDS_PATH)) {
    credentials = JSON.parse(fs.readFileSync(GMAIL_CREDS_PATH, 'utf8'));
  }
  if (!token && fs.existsSync(GMAIL_TOKEN_PATH)) {
    token = JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH, 'utf8'));
  }

  if (!credentials || !token) {
    console.log('[shared/email] Google OAuth2 credentials not found');
    return null;
  }

  cachedCreds = credentials;
  cachedToken = token;
  return { credentials, token };
}

/**
 * Get a Google OAuth2 access token using direct HTTPS POST.
 * No googleapis SDK dependency — uses Node https module (same pattern as dropboxFetch).
 * Safe on Railway with Node 24 (avoids HTTP/2 premature close issues in googleapis).
 *
 * @returns {Promise<string>} Access token string
 */
async function getGoogleAccessToken() {
  const creds = loadGoogleCreds();
  if (!creds) throw new Error('Google OAuth2 credentials not configured');

  const { client_secret, client_id } = creds.credentials.installed || creds.credentials.web || creds.credentials;
  const refreshToken = creds.token.refresh_token;

  if (!refreshToken) {
    // Try fresh from the loaded token
    if (creds.token.access_token && creds.token.expiry_date > Date.now()) {
      return creds.token.access_token;
    }
    throw new Error('No refresh_token available for Google OAuth2');
  }

  // Check if current token is still valid (with 5-min buffer)
  const now = Date.now();
  const expiryMs = creds.token.expiry_date || 0;
  if (now < expiryMs - 300000 && creds.token.access_token) {
    console.log('[shared/email] Google token still valid, using cached');
    return creds.token.access_token;
  }

  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client_id,
      client_secret: client_secret,
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.access_token) {
            // Update cached token with new expiry for future calls
            j.refresh_token = refreshToken;
            j.expiry_date = now + (j.expires_in || 3600) * 1000;
            cachedToken = j;
            // Persist back to env var for process lifetime
            if (process.env.GMAIL_TOKEN_JSON) {
              process.env.GMAIL_TOKEN_JSON = JSON.stringify(j);
            }
            resolve(j.access_token);
          } else {
            reject(new Error(j.error_description || j.error || 'OAuth2 token refresh failed'));
          }
        } catch (e) {
          reject(new Error('OAuth2 token refresh parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Shared OAuth2 Client (local Mac use only — uses googleapis SDK) ───────

let cachedOAuth2Client = null;

/**
 * Get a raw Google OAuth2 client with auto-refresh.
 * Uses googleapis SDK — works locally on Mac but may fail on Railway (Node 24 HTTP/2 issues).
 * For Railway services, use getGoogleAccessToken() instead.
 * @returns {Promise<object|null>} OAuth2 client or null
 */
async function getGoogleOAuth2Client() {
  if (cachedOAuth2Client) return cachedOAuth2Client;

  const creds = loadGoogleCreds();
  if (!creds) return null;

  const { client_secret, client_id, redirect_uris } = creds.credentials.installed || creds.credentials.web || creds.credentials;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0] || 'http://localhost');
  oAuth2Client.setCredentials(creds.token);

  oAuth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      console.log('[shared/email] OAuth2 token auto-refreshed (raw client)');
    }
  });

  cachedOAuth2Client = oAuth2Client;
  return oAuth2Client;
}

module.exports = {
  getGmailClient,
  getGoogleAccessToken,
  getGoogleOAuth2Client,
  buildEmailBody,
  buildHeaderLogoTag,
  buildDocumentEmail,
  buildSignNotificationEmail,
  createMessage,
  sendEmail,
  createDraft,
  notifyOnFailure,
};

module.exports.VERSION = '1.0.0';
