// =============================================================================
// esign.js — Shared e-signature UI builder for ZINN Railway services
// Generates HTML for both PDF (ink signature block) and interactive web
// (canvas signature pad) contexts. Supports proposal and agreement variants.
// =============================================================================
'use strict';

const { esc } = require('./data');

// ─── PDF Signature Block ────────────────────────────────────────────────────

/**
 * Build a static ink-signature block for PDF output.
 * @param {object} opts
 * @param {string} [opts.context='proposal'] — 'proposal' or 'agreement'
 * @param {object} [opts.accepted=null] — signed data with .signed_by, .signed_at
 * @returns {string} HTML
 */
function buildPdfBlock(opts = {}) {
  const { accepted } = opts;
  const introText = opts.context === 'agreement'
    ? 'By signing below you agree to the terms outlined in this Employment Agreement.'
    : 'By signing below you agree to the scope, fee, and general conditions outlined in this proposal.';

  if (accepted && accepted.signed_by) {
    return buildSignedBlock(accepted);
  }

  return `<div class="section acceptance-section">
  <h2 class="section-label">acceptance</h2>
  <div class="section-accent"></div>
  <p class="legal-text">${introText} If you have questions, reply to the email and we&#8217;ll schedule a call.</p>

  <div style="margin-top:40px;">
    <div style="display:flex;gap:24px;align-items:flex-end;">
      <div style="flex:1;">
        <p style="font-size:11px;color:#81A2B2;margin-bottom:4px;letter-spacing:0.5px;">SIGNATURE</p>
        <div style="border-bottom:1px solid #000;min-height:60px;background:#fff;"></div>
      </div>
      <div style="flex:0 0 200px;">
        <p style="font-size:11px;color:#81A2B2;margin-bottom:4px;letter-spacing:0.5px;">DATE</p>
        <div style="border-bottom:1px solid #000;min-height:60px;background:#fff;"></div>
      </div>
    </div>
    <div style="margin-top:24px;">
      <p style="font-size:11px;color:#81A2B2;margin-bottom:4px;letter-spacing:0.5px;">PRINTED NAME</p>
      <div style="border-bottom:1px solid #000;min-height:44px;background:#fff;"></div>
    </div>
  </div>
</div>`;
}

// ─── Interactive Web Signature Block ────────────────────────────────────────

/**
 * Build the interactive e-signature UI for web rendering.
 * Includes canvas sig pad, name/email fields, form validation, POST to /sign.
 *
 * @param {object} opts
 * @param {string} [opts.context='proposal'] — 'proposal' or 'agreement'
 * @param {string} [opts.identifier=''] — cardId (proposal) or slug (agreement)
 * @returns {string} HTML with inline JS
 */
function buildWebBlock(opts = {}) {
  const { identifier, context } = opts;
  const introText = context === 'agreement'
    ? 'By signing below you agree to the terms outlined in this Employment Agreement. If you have questions, reply to the email and we&#8217;ll schedule a call.'
    : 'By signing below you agree to the scope, fee, and general conditions outlined in this proposal. If you have questions, reply to the email and we&#8217;ll schedule a call.';

  const extraFields = context !== 'agreement' ? '' : '';

  return `<div class="section acceptance-section" id="esign-section">
  <h2 class="section-label">acceptance</h2>
  <div class="section-accent"></div>
  <p class="legal-text">${introText}</p>

  <div id="sign-form" style="margin-top:32px;">
    <div style="margin-bottom:20px;">
      <p style="font-size:11px;color:#81A2B2;margin-bottom:6px;letter-spacing:0.5px;text-transform:uppercase;">Full Name</p>
      <input id="sign-name" type="text" placeholder="Your full name"
        style="width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;padding:10px 12px;font-size:14px;font-family:'Avenir Next',Avenir,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#242C39;outline:none;">
    </div>
    <div style="margin-bottom:20px;">
      <p style="font-size:11px;color:#81A2B2;margin-bottom:6px;letter-spacing:0.5px;text-transform:uppercase;">Email</p>
      <input id="sign-email" type="email" placeholder="Your email address"
        style="width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;padding:10px 12px;font-size:14px;font-family:'Avenir Next',Avenir,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#242C39;outline:none;">
    </div>
    <div style="margin-bottom:24px;">
      <p style="font-size:11px;color:#81A2B2;margin-bottom:6px;letter-spacing:0.5px;text-transform:uppercase;">Signature</p>
      <canvas id="sig-canvas" width="600" height="150"
        style="display:block;border:1px solid #ccc;border-radius:3px;background:#fff;width:100%;max-width:100%;touch-action:none;cursor:crosshair;"></canvas>
      <div style="margin-top:6px;text-align:right;">
        <button onclick="clearSig()" type="button"
          style="background:none;border:none;font-size:11px;color:#81A2B2;cursor:pointer;letter-spacing:0.5px;text-decoration:underline;font-family:'Avenir Next',Avenir,'Helvetica Neue',Helvetica,Arial,sans-serif;">Clear</button>
      </div>
    </div>
    <div id="sign-error" style="display:none;color:#c0392b;font-size:13px;margin-bottom:16px;"></div>
    <button id="sign-btn" onclick="submitSign('${esc(identifier)}')" type="button"
      style="background:#242C39;color:#fff;border:none;padding:14px 40px;font-size:13px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;font-family:'Avenir Next',Avenir,'Helvetica Neue',Helvetica,Arial,sans-serif;border-radius:2px;">
      Accept &amp; Sign
    </button>
  </div>

  <div id="accepted-status" style="display:none;text-align:center;padding:24px;">
    <p style="font-size:28px;color:#242C39;margin-bottom:8px;">&#10003;</p>
    <p id="accepted-message" style="font-size:16px;color:#242C39;font-weight:400;font-family:'Avenir Next',Avenir,'Helvetica Neue',Helvetica,Arial,sans-serif;"></p>
  </div>

  <script>
  (function() {
    function initCanvas() {
      const canvas = document.getElementById('sig-canvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');

      // Scale canvas for retina/high-DPI displays
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const cssW = rect.width || 600;
      const cssH = rect.height || 150;
      canvas.width  = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.scale(dpr, dpr);

      let drawing = false;
      let lastX = 0, lastY = 0;

      // Return coordinates in CSS pixels — ctx.scale handles the DPR mapping
      function getPos(e) {
        const r = canvas.getBoundingClientRect();
        if (e.touches) {
          return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
        }
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      }

      function start(e) { e.preventDefault(); drawing = true; const p = getPos(e); lastX = p.x; lastY = p.y; }
      function move(e) {
        e.preventDefault();
        if (!drawing) return;
        const p = getPos(e);
        ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = '#242C39'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
        lastX = p.x; lastY = p.y;
      }
      function stop() { drawing = false; }

      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', move);
      canvas.addEventListener('mouseup', stop);
      canvas.addEventListener('mouseleave', stop);
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', move, { passive: false });
      canvas.addEventListener('touchend', stop);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initCanvas);
    } else {
      initCanvas();
    }
  })();

  window.clearSig = function() {
    const canvas = document.getElementById('sig-canvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.getContext('2d').clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  };

  function isCanvasBlank() {
    const canvas = document.getElementById('sig-canvas');
    if (!canvas) return true;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) return false; }
    return true;
  }

  window.submitSign = async function(identifier) {
    const name    = document.getElementById('sign-name').value.trim();
    const email   = document.getElementById('sign-email').value.trim();
    const errEl   = document.getElementById('sign-error');
    const btn     = document.getElementById('sign-btn');
    errEl.style.display = 'none';

    if (!name)               { errEl.textContent = 'Please enter your full name.';          errEl.style.display='block'; return; }
    if (!email || !email.includes('@')) { errEl.textContent = 'Please enter a valid email.'; errEl.style.display='block'; return; }
    if (isCanvasBlank())     { errEl.textContent = 'Please draw your signature above.';     errEl.style.display='block'; return; }

    const signature  = document.getElementById('sig-canvas').toDataURL('image/png');
    const signedAt   = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      const res = await fetch('/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier, name: name, email: email, signature: signature, signedAt: signedAt })
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        const firstName = name.split(' ')[0];
        document.getElementById('sign-form').style.display = 'none';
        const msgEl = document.getElementById('accepted-message');
        msgEl.innerHTML = '<strong>Thank you, ' + firstName + '.</strong><br><span style="font-size:14px;">Your signed document will be emailed to you shortly.</span>';
        document.getElementById('accepted-status').style.display = 'block';
      } else {
        errEl.textContent = data.error || 'Something went wrong. Please try again or reply to our email.';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Accept & Sign';
      }
    } catch(e) {
      errEl.textContent = 'Network error. Please try again or reply to our email.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Accept & Sign';
    }
  };
  </script>
</div>`;
}

// ─── Already-Signed Block ─────────────────────────────────────────────────

/**
 * Build the "signed" display block showing who signed and when.
 * @param {object} accepted — { signed_by, signed_at }
 * @returns {string} HTML
 */
function buildSignedBlock(accepted) {
  const slug = accepted.slug || '';
  const sigHtml = accepted.signature_data_uri
    ? `<div style="margin:20px auto 8px auto;max-width:420px;border:1px solid #E0E8EC;padding:12px 16px;background:#fff;">
         <img src="${accepted.signature_data_uri}" style="max-width:100%;height:auto;display:block;" alt="Signature">
       </div>`
    : `<div style="border-bottom:1px solid #cccccc;width:240px;margin:24px auto 8px auto;min-height:48px;"></div>`;
  const downloadBtn = slug
    ? `<a href="/download/${esc(slug)}" style="display:inline-block;background:#242C39;color:#fff;padding:14px 40px;font-size:13px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;font-family:\'Avenir Next\',Avenir,\'Helvetica Neue\',Helvetica,Arial,sans-serif;border-radius:2px;margin-top:20px;">Download Agreement</a>`
    : '';
  return `<div class="section acceptance-section" style="text-align:center;">
  <h2 class="section-label" style="text-align:left;">acceptance</h2>
  <div class="section-accent"></div>
  <p style="font-size:15px;color:#242C39;font-weight:400;margin:24px 0 4px 0;">Accepted by</p>
  <p style="font-size:14px;color:#242C39;margin-bottom:4px;"><strong>${esc(accepted.signed_by)}</strong></p>
  ${sigHtml}
  <p style="font-size:11px;color:#81A2B2;margin-top:8px;">${esc(accepted.signed_at || '')}</p>
  ${downloadBtn}
</div>`;
}

// ─── Combined Entry Point ──────────────────────────────────────────────────

/**
 * Build the acceptance block (signature section) for a document.
 * Automatically selects PDF (ink) or Web (interactive canvas) variant.
 *
 * @param {object} opts
 * @param {boolean} [opts.forPdf=false] — true for static ink block in PDF
 * @param {string}  [opts.context='proposal'] — 'proposal' or 'agreement'
 * @param {string}  [opts.identifier=''] — cardId (proposal) or slug (agreement)
 * @param {object}  [opts.accepted=null] — signed data with .signed_by, .signed_at
 * @returns {string} HTML
 */
function buildAcceptanceBlock(opts = {}) {
  const {
    forPdf = false,
    context = 'proposal',
    identifier = '',
    accepted = null,
  } = opts;

  // Already signed — show static confirmation
  if (accepted && accepted.signed_by) {
    return buildSignedBlock(accepted);
  }

  // PDF — static ink block
  if (forPdf) {
    return buildPdfBlock({ context, accepted });
  }

  // Web — interactive canvas signature
  return buildWebBlock({ context, identifier });
}

module.exports = {
  buildAcceptanceBlock,
  buildPdfBlock,
  buildWebBlock,
  buildSignedBlock,
};

module.exports.VERSION = '1.0.0';
