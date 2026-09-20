// qbo.js - QuickBooks Online client for timesheet_creator
// Handles token refresh, TimeActivity posting, employees/items/customers queries.
// Credentials: ~/.openclaw/credentials/qbo_tokens.json (local) or env vars (Railway).
//
// SINGLE-OWNER RULE (2026-09-20, Rob): Intuit keeps only ONE active refresh
// token per app+company, so a second sign-in silently kills the first. ZINN
// has exactly one QuickBooks sign-in, owned by the shared_resource_manager
// skill. Services are consumers only: no service may host its own sign-in or
// callback route. Renewal is the documented procedure in SRM's SKILL.md.
//
// Token storage (2026-09-20): mirrors dropbox.js. The Postgres `tokens` table
// is the durable copy; QBO_REFRESH_TOKEN is only the seed. See refreshAccessToken.

const fs = require('fs');
const path = require('path');
const https = require('https');

// Optional durable store - services without a DATABASE_URL keep env/file behaviour.
let tokenStore = null;
try { tokenStore = require('./db'); } catch (e) { tokenStore = null; }
const QBO_TOKEN_SERVICE = 'qbo';

const TOKEN_FILE = process.env.QBO_TOKEN_FILE || '/Users/robzinn/.openclaw/credentials/qbo_tokens.json';
const CREDS_FILE = process.env.QBO_CREDS_FILE || '/Users/robzinn/.openclaw/credentials/qbo.txt';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';

function httpReq(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* not json */ }
        if (res.statusCode >= 400) {
          const err = new Error(`QBO HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          err.body = data;
          reject(err);
        } else {
          resolve(parsed !== null ? parsed : data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseCredsFile() {
  // qbo.txt layout: sections "#Playground" and "#Production" with
  // Client ID: / Client secret: lines. We always use the LAST section (production).
  const txt = fs.readFileSync(CREDS_FILE, 'utf8');
  const sections = txt.split(/\n\s*#/).filter(Boolean);
  const use = sections[sections.length - 1];
  const idMatch = use.match(/Client\s*ID:?\s*\n?\s*([A-Za-z0-9]+)/i);
  const secMatch = use.match(/Client\s*[Ss]ecret:?\s*\n?\s*([A-Za-z0-9]+)/i);
  if (!idMatch || !secMatch) throw new Error('qbo.txt parse failed - missing client id/secret');
  return { clientId: idMatch[1], clientSecret: secMatch[1] };
}

class QBOClient {
  constructor() {
    this.tokens = null;
  }

  loadTokens() {
    if (this.tokens) return this.tokens;
    if (process.env.QBO_REFRESH_TOKEN) {
      this.tokens = {
        client_id: process.env.QBO_CLIENT_ID,
        client_secret: process.env.QBO_CLIENT_SECRET,
        refresh_token: process.env.QBO_REFRESH_TOKEN,
        access_token: null,
        realm_id: process.env.QBO_REALM_ID,
      };
    } else {
      this.tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
    return this.tokens;
  }

  async refreshAccessToken() {
    const t = this.loadTokens();
    // Durable copy first (added 2026-09-20): a re-authorised token lands in the
    // DB and is seen by every consumer of this service, instead of being lost
    // when the env seed goes stale. A stored row superseded by a later
    // re-authorisation would wedge the service, so a rejected stored token
    // falls back to the env token and re-persists.
    if (tokenStore) {
      try {
        const row = await tokenStore.getStoredToken(QBO_TOKEN_SERVICE, 'refresh');
        if (row && row.value) t.refresh_token = row.value;
      } catch (e) { /* no stored copy - keep the env/file token */ }
    }

    // Env-managed (Railway): client id/secret come from env vars. Local
    // fallback reads qbo.txt. (Fix 2026-08-30: the file was read
    // unconditionally, breaking QBO calls on Railway where the file
    // doesn't exist.)
    let clientId, clientSecret;
    if (process.env.QBO_REFRESH_TOKEN) {
      clientId = process.env.QBO_CLIENT_ID;
      clientSecret = process.env.QBO_CLIENT_SECRET;
    } else {
      const creds = parseCredsFile();
      clientId = creds.clientId;
      clientSecret = creds.clientSecret;
    }
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const request = (refreshToken) => httpReq(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    }, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString());

    let res;
    try {
      res = await request(t.refresh_token);
    } catch (e) {
      const envToken = process.env.QBO_REFRESH_TOKEN;
      if (envToken && envToken !== t.refresh_token) {
        console.log('[qbo] stored token rejected - retrying with the env token');
        res = await request(envToken);
        t.refresh_token = envToken;
      } else {
        throw e;
      }
    }

    t.access_token = res.access_token;
    if (res.refresh_token) t.refresh_token = res.refresh_token;
    if (tokenStore) {
      try { await tokenStore.storeToken(QBO_TOKEN_SERVICE, 'refresh', t.refresh_token, null); }
      catch (e) { /* non-fatal - in-memory token still works */ }
    }
    if (!process.env.QBO_REFRESH_TOKEN) {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 1));
    }
    return t;
  }

  async api(path, options = {}) {
    const t = this.loadTokens();
    if (!t.access_token) await this.refreshAccessToken();
    const headers = { Authorization: 'Bearer ' + t.access_token, Accept: 'application/json', ...(options.headers || {}) };
    const url = `${API_BASE}/v3/company/${t.realm_id}/${path}?minorversion=73${options.qs || ''}`;
    try {
      return await httpReq(url, { method: options.method || 'GET', headers }, options.body);
    } catch (e) {
      if (e.statusCode === 401) {
        // token expired - refresh once and retry
        await this.refreshAccessToken();
        const h2 = { ...headers, Authorization: 'Bearer ' + this.tokens.access_token };
        return await httpReq(url, { method: options.method || 'GET', headers: h2 }, options.body);
      }
      throw e;
    }
  }

  query(sql) {
    return this.api('query', { qs: '&query=' + encodeURIComponent(sql) });
  }

  async listEmployees(activeOnly = true) {
    const sql = `select * from Employee${activeOnly ? ' where Active=true' : ''} maxresults 200`;
    const res = await this.query(sql);
    return (res.QueryResponse && res.QueryResponse.Employee) || [];
  }

  async listServiceItems() {
    const sql = "select * from Item where Type='Service' maxresults 200";
    const res = await this.query(sql);
    return (res.QueryResponse && res.QueryResponse.Item) || [];
  }

  async listCustomers() {
    const sql = 'select * from Customer maxresults 200';
    const res = await this.query(sql);
    return (res.QueryResponse && res.QueryResponse.Customer) || [];
  }

  // Create a TimeActivity entry. https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/timeactivity
  // fields: employeeRef, itemRef (service item), hours, txnDate, description, billableStatus, customerRef
  // CustomerRef is REQUIRED for billable entries (QBO error 6310).
  // GOTCHA (verified 2026-08-24): the API truncates fractional Hours to the
  // integer part (1.5 -> 1, 0.25 -> 0). Fractions must be sent as Minutes.
  // ─── Customer (client) + sub-customer (project) management (Shireen's QBO process, 2026-08-26) ───
  // Client first (parent Customer), then project under it (Customer with ParentRef, Job=true).
  async createCustomer(payload) {
    const res = await this.api('customer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.Customer || res;
  }

  async updateCustomer(id, syncToken, payload) {
    const res = await this.api('customer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Id: String(id), SyncToken: syncToken, sparse: true, ...payload }) });
    return res.Customer || res;
  }

  // Find a customer by exact normalized DisplayName. Returns full record or null.
  async findCustomerByName(displayName) {
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const target = norm(displayName);
    const res = await this.query('select * from Customer maxresults 1000');
    const list = (res.QueryResponse && res.QueryResponse.Customer) || [];
    return list.find((c) => norm(c.DisplayName) === target) || null;
  }

  // Resolve the client (parent Customer) + project (sub-customer) for a Trello
  // card, guarding against duplicate clients. Added 2026-08-27 after Shireen's
  // feedback on the Yang test: the client already existed in QBO combined with
  // a project under a different DisplayName ("Yang Reno"), the exact-name
  // lookup missed it, and a second client was created.
  //
  // Returns { client, project, method, ambiguous, warnings }:
  //   client:    parent Customer record or null
  //   project:   sub-customer matching projectName under ANY parent, or null
  //   method:    'exact' | 'project-parent' | 'client-as-project' | 'combined' | 'surname' | 'none'
  //   ambiguous: true when multiple candidate clients exist - caller MUST NOT create
  //   warnings:  human-readable notes (candidates, combined records found, etc.)
  //
  // Callers: qbo_customer_setup.js (timesheet-creator) and bookkeeping_setup.js
  // (project_automator). Never create a client when ambiguous is true.
  async resolveClientProject(clientName, projectName) {
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const STOP = new Set(['and', 'the', 'for', 'with', 'of', 'at', 'by', 'to', 'in', 'on', 'a', 'an', 'llc', 'inc', 'co']);
    const sigTokens = (s) => norm(s).split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
    const targetClient = norm(clientName);
    const targetProject = norm(projectName);
    const clientTokens = sigTokens(clientName);
    const projectTokens = sigTokens(projectName);
    const warnings = [];

    const res = await this.query('select * from Customer maxresults 1000');
    const list = (res.QueryResponse && res.QueryResponse.Customer) || [];
    const byId = new Map(list.map((c) => [String(c.Id), c]));
    const rootParent = (c) => {
      let cur = c;
      while (cur && cur.ParentRef && byId.has(String(cur.ParentRef.value))) cur = byId.get(String(cur.ParentRef.value));
      return cur;
    };
    const dn = (c) => norm(c.DisplayName);
    const hasAnyToken = (tokens, name) => { const n = norm(name); return tokens.some((t) => n.includes(t)); };
    const hasAllTokens = (tokens, name) => { const n = norm(name); return tokens.length > 0 && tokens.every((t) => n.includes(t)); };

    // 1. project-first: a sub-customer (project) with this name already exists
    //    under some parent. Exact DisplayName wins; token overlap only when no
    //    exact match (avoids "Yang Reno" matching "Yang Reno VE Updates").
    const projMatches = list.filter((c) =>
      c.ParentRef && (dn(c) === targetProject || hasAllTokens(projectTokens, c.DisplayName))
    );
    const projUse = projMatches.filter((c) => dn(c) === targetProject).length ? projMatches.filter((c) => dn(c) === targetProject) : projMatches;
    if (projUse.length === 1) {
      const client = rootParent(projUse[0]);
      warnings.push('project "' + projUse[0].DisplayName + '" already exists under client "' + client.DisplayName + '" - reusing');
      return { client, project: projUse[0], method: 'project-parent', ambiguous: false, warnings };
    }
    if (projUse.length > 1) {
      warnings.push('project name matches ' + projUse.length + ' existing sub-customers: ' + projUse.map((c) => c.FullyQualifiedName || c.DisplayName).join(' | '));
      return { client: null, project: null, method: 'project-parent', ambiguous: true, warnings };
    }

    // 2. exact client match (previous behavior)
    const exact = list.find((c) => dn(c) === targetClient);
    if (exact) {
      if (exact.ParentRef) {
        // client record itself is marked as a sub-customer (project) - walk to its root
        const client = rootParent(exact);
        warnings.push('client record "' + exact.DisplayName + '" is itself a sub-customer (project) under "' + client.DisplayName + '" - using the root client');
        return { client, project: null, method: 'client-as-project', ambiguous: false, warnings };
      }
      return { client: exact, project: null, method: 'exact', ambiguous: false, warnings };
    }

    // 3. combined records: a top-level customer whose name blends client + project
    //    tokens (e.g. "Yang Reno" for client "Dunsong Yang" + project "Yang Reno VE Updates").
    //    Must include a project token that is NOT also a client token, so plain
    //    client records ("Dunsong Yang") don't self-match. Stopwords filtered so
    //    "and" in "Dunsong and Teresa Yang" can't match "BrANDon..." (2026-08-27).
    const nonClientProjectTokens = projectTokens.filter((t) => !clientTokens.includes(t));
    const combined = list.filter((c) =>
      !c.ParentRef && dn(c) !== targetClient && hasAnyToken(clientTokens, c.DisplayName) &&
      (nonClientProjectTokens.length ? hasAnyToken(nonClientProjectTokens, c.DisplayName) : hasAnyToken(projectTokens, c.DisplayName))
    );
    if (combined.length === 1) {
      const client = rootParent(combined[0]);
      warnings.push('client may be combined with a project in one record ("' + combined[0].DisplayName + '") - creating the project separately under it; Shireen may want to split/rename');
      return { client, project: null, method: 'combined', ambiguous: false, warnings };
    }
    if (combined.length > 1) {
      warnings.push('multiple combined records look like this client: ' + combined.map((c) => c.DisplayName).join(' | '));
      return { client: null, project: null, method: 'combined', ambiguous: true, warnings };
    }

    // 4. surname-unique fallback (cards say "Dunsong and Teresa Yang", QBO has
    //    "Dunsong Yang"; Shireen's own example: "Judi and Willie Alvarado" -> "Willie Alvarado")
    const surname = targetClient.split(/\s+/).pop();
    if (surname && surname.length > 2) {
      const surnameMatches = list.filter((c) => {
        const parts = dn(c).split(/\s+/);
        return parts[parts.length - 1] === surname;
      });
      if (surnameMatches.length === 1) return { client: surnameMatches[0], project: null, method: 'surname', ambiguous: false, warnings };
      if (surnameMatches.length > 1) {
        warnings.push('surname "' + surname + '" matches multiple customers: ' + surnameMatches.map((c) => c.DisplayName).join(' | '));
        return { client: null, project: null, method: 'surname', ambiguous: true, warnings };
      }
    }

    return { client: null, project: null, method: 'none', ambiguous: false, warnings };
  }

  // Attach a file to any QBO entity (e.g. project record) via the file upload API.
  // Shireen 2026-08-26: add all documentation (proposal etc.) to project attachments.
  // GOTCHAS (verified live 2026-08-26):
  //  - Use POST /upload (NOT /attachable - that endpoint rejects multipart with code 2010).
  //  - Content-Type header boundary must have NO space after the semicolon.
  //  - Metadata part is "file_metadata_01" (not "file_metadata"); file part is
  //    "file_content_01" with Content-Transfer-Encoding: base64 + base64 content.
  //  - Node sends chunked encoding by default; Content-Length must be set.
  async createAttachable({ entityType, entityId, fileName, note, fileBuffer, contentType }) {
    const boundary = 'zinn_attach_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({
      AttachableRef: [{ EntityRef: { type: entityType, value: String(entityId) } }],
      FileName: fileName,
      ContentType: contentType || 'application/pdf',
      Note: note || '',
    });
    const CRLF = '\r\n';
    const b64 = fileBuffer.toString('base64');
    const parts = [
      Buffer.from(`--${boundary}${CRLF}` + `Content-Disposition: form-data; name="file_metadata_01"; filename="attachment.json"${CRLF}` + `Content-Type: application/json; charset=UTF-8${CRLF}` + `Content-Transfer-Encoding: 8bit${CRLF}${CRLF}` + meta + CRLF),
      Buffer.from(`--${boundary}${CRLF}` + `Content-Disposition: form-data; name="file_content_01"; filename="${fileName}"${CRLF}` + `Content-Type: ${contentType || 'application/pdf'}${CRLF}` + `Content-Transfer-Encoding: base64${CRLF}${CRLF}`),
      Buffer.from(b64),
      Buffer.from(CRLF + `--${boundary}--${CRLF}`),
    ];
    const body = Buffer.concat(parts);
    const res = await this.api('upload?minorversion=65', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data;boundary=' + boundary,
        'Content-Length': String(body.length),
      },
      body,
    });
    const att = res && res.AttachableResponse && res.AttachableResponse[0] && res.AttachableResponse[0].Attachable;
    if (!att) throw new Error('upload response missing Attachable');
    return att;
  }

  // ─── TimeActivity ───
  async createTimeActivity({ employeeId, itemId, hours, txnDate, description, billable, customerId }) {
    const h = Number(hours);
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    const body = JSON.stringify({
      TxnDate: txnDate,
      EmployeeRef: { value: String(employeeId) },
      ItemRef: { value: String(itemId) },
      Hours: whole,
      Minutes: mins,
      Description: description,
      BillableStatus: billable ? 'Billable' : 'NotBillable',
      NameOf: 'Employee',
      ...(customerId ? { CustomerRef: { value: String(customerId) } } : {}),
    });
    const res = await this.api('timeactivity', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    return res.TimeActivity;
  }

  // Sparse update of a TimeActivity (e.g. staff correction of hours).
  // Requires Id + SyncToken (fetch the entry first for a fresh token).
  async updateTimeActivity({ id, syncToken, hours, description }) {
    const h = Number(hours);
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    const body = JSON.stringify({
      Id: String(id),
      SyncToken: syncToken,
      Hours: whole,
      Minutes: mins,
      sparse: true,
      ...(description ? { Description: description } : {}),
    });
    const res = await this.api('timeactivity', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    return res.TimeActivity;
  }

  // Vendor name collision check (Rob 2026-08-29). QBO blocks the same
  // DisplayName across Customer + Vendor (global name registry), so a company
  // that is both a provider and a client needs a distinguishing name. Returns
  // the matching vendor record, or null. Callers should apply a " (Client)"
  // suffix when this returns a hit.
  async findVendorByName(name) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = norm(name);
    if (!target) return null;
    const out = [];
    let sp = 1;
    for (;;) {
      const res = await this.query(`select Id, DisplayName from Vendor startposition ${sp} maxresults 1000`);
      const list = (res.QueryResponse && res.QueryResponse.Vendor) || [];
      out.push(...list);
      if (list.length < 1000) break;
      sp += 1000;
    }
    return out.find((v) => norm(v.DisplayName) === target) || null;
  }
}

module.exports = { QBOClient, parseCredsFile };
