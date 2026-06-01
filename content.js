// content.js — Holistic form filler with Claude AI fallback
(function () {

// ── MESSAGE LISTENER — registered on every injection so extension reloads
//    don't leave orphaned handlers with broken chrome.runtime connections.
//    window.__OT_RUNNING__ prevents concurrent fills across multiple injections.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_DATA') {
    sendResponse(typeof scrapePageData === 'function' ? scrapePageData() : {});
    return true;
  }
  if (msg.type === 'AUTO_APPLY') {
    if (window.__OT_RUNNING__) { sendResponse({ success: true }); return true; }
    window.__OT_RUNNING__ = true;
    handleAutofillClick()
      .then(() => { window.__OT_RUNNING__ = false; sendResponse({ success: true }); })
      .catch(() => { window.__OT_RUNNING__ = false; sendResponse({ success: false }); });
    return true;
  }
});

// Guard everything else — overlay button injection and function definitions
if (window.__OT_LOADED__) return;
window.__OT_LOADED__ = true;

let _overlayBtn = null;

// ── BOOT ──────────────────────────────────────────────────────────────────────
function boot() {
  watchForForms();
}

function watchForForms() {
  tryInjectOverlay();
  // Re-check when DOM changes (SPAs)
  const mo = new MutationObserver(debounce(tryInjectOverlay, 600));
  mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// Detects any fillable inputs — works even when <form> tags are absent (ADP, etc.)
const FILLABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea, [role="combobox"]';

// ── SHADOW-DOM-AWARE QUERIES ──────────────────────────────────────────────────
// Modern ATSs (SmartRecruiters' spl-*/oc-* web components, etc.) render every
// field and button inside *open shadow roots*, so a plain document.querySelectorAll
// returns nothing. These helpers descend through all open shadow roots so field
// discovery, option-matching, validation and button-finding all work there too.
function deepRoots() {
  const roots = [document];
  const visit = root => {
    let els;
    try { els = root.querySelectorAll('*'); } catch { return; }
    for (const el of els) {
      const sr = el.shadowRoot;
      if (sr) { roots.push(sr); visit(sr); }
    }
  };
  visit(document);
  return roots;
}

function deepQueryAll(selector) {
  const out = [], seen = new Set();
  for (const root of deepRoots()) {
    let nodes;
    try { nodes = root.querySelectorAll(selector); } catch { continue; }
    for (const n of nodes) if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function deepQuery(selector) {
  for (const root of deepRoots()) {
    let n;
    try { n = root.querySelector(selector); } catch { continue; }
    if (n) return n;
  }
  return null;
}

// Visibility that also holds for elements inside shadow roots (where offsetParent
// can read null even when the element is rendered).
function isVisible(el) {
  if (!el) return false;
  try {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  } catch { return false; }
}

// Deep query restricted to a subtree (root's light + shadow descendants).
function deepWithin(root, selector) {
  const out = [], seen = new Set();
  const visit = node => {
    let m; try { m = node.querySelectorAll(selector); } catch { m = []; }
    m.forEach(x => { if (!seen.has(x)) { seen.add(x); out.push(x); } });
    let all; try { all = node.querySelectorAll('*'); } catch { all = []; }
    all.forEach(e => { if (e.shadowRoot) visit(e.shadowRoot); });
  };
  visit(root);
  return out;
}

// closest() that crosses shadow boundaries (walks up through host elements).
function closestDeep(el, selector) {
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.matches && node.matches(selector)) return node;
    if (node.parentElement) { node = node.parentElement; continue; }
    const root = node.getRootNode && node.getRootNode();
    node = root && root.host ? root.host : null;
  }
  return null;
}

function pageHasFillableInputs() {
  return deepQueryAll(FILLABLE).some(el => isVisible(el) && !el.disabled);
}

// Does THIS document look like a real job-application form (vs. a search box,
// newsletter, nav, or tracking iframe)? Used to scope the overlay across frames.
function looksLikeApplicationForm() {
  const name   = deepQuery('#first_name, #last_name, [id*="first-name" i], [id*="last-name" i], input[name*="first" i], input[name*="last" i], input[autocomplete*="name" i]');
  const email  = deepQuery('input[type="email"], #email, [id*="email" i], input[name*="email" i], input[autocomplete="email"]');
  const resume = deepQuery('input[type="file"]');
  return (!!name && !!email) || !!resume;
}

// ATS hosts whose forms are commonly embedded in a careers page via <iframe>.
const ATS_IFRAME_RE = /greenhouse|grnh|lever|myworkdayjobs|ashbyhq|icims|jobvite|smartrecruiters|bamboohr|dayforce|workable|job-boards/i;

// On the TOP page, if there's no application form here but an ATS form is embedded
// in an iframe, defer to that iframe (its own content script shows the overlay) —
// otherwise we'd show a useless overlay over the marketing page (e.g. Zoro careers).
function topShouldDeferToIframe() {
  if (window.top !== window) return false;
  if (looksLikeApplicationForm()) return false;
  return Array.from(document.querySelectorAll('iframe')).some(f => ATS_IFRAME_RE.test(f.src || ''));
}

function tryInjectOverlay() {
  if (_overlayBtn) return;
  if (window.top !== window) {
    // Sub-frames only get the overlay if they actually hold an application form
    // (skips tracking/analytics iframes; the ATS form iframe qualifies).
    if (!looksLikeApplicationForm()) return;
  } else {
    if (topShouldDeferToIframe()) return;
    if (!pageHasFillableInputs()) return;
  }
  injectOverlayButton();
}

// ── OVERLAY BUTTON ────────────────────────────────────────────────────────────
function injectOverlayButton() {
  const btn = document.createElement('div');
  btn.id = 'ot-autofill-btn';
  btn.innerHTML = `
    <span class="ot-btn-icon">✨</span>
    <span class="ot-btn-label">Autofill</span>
  `;
  btn.title = 'Autofill with Outreach Tracker AI';
  document.body.appendChild(btn);
  _overlayBtn = btn;

  btn.addEventListener('click', handleAutofillClick);
}

function setOverlayState(state) {
  if (!_overlayBtn) return;
  const icon  = _overlayBtn.querySelector('.ot-btn-icon');
  const label = _overlayBtn.querySelector('.ot-btn-label');
  _overlayBtn.className = '';
  _overlayBtn.id = 'ot-autofill-btn';

  switch (state) {
    case 'loading':
      icon.textContent  = '⏳';
      label.textContent = 'Filling...';
      _overlayBtn.classList.add('ot-loading');
      break;
    case 'claude':
      icon.textContent  = '🤖';
      label.textContent = 'AI answering...';
      _overlayBtn.classList.add('ot-loading');
      break;
    case 'done':
      icon.textContent  = '✅';
      label.textContent = 'Done!';
      _overlayBtn.classList.add('ot-done');
      setTimeout(() => setOverlayState('idle'), 3000);
      break;
    case 'error':
      icon.textContent  = '⚠️';
      label.textContent = 'Partial fill';
      _overlayBtn.classList.add('ot-error');
      setTimeout(() => setOverlayState('idle'), 4000);
      break;
    default: // idle
      icon.textContent  = '✨';
      label.textContent = 'Autofill';
  }
}

// ── MANDATORY FIELD CHECK ─────────────────────────────────────────────────────
// A field is required only when the form itself says so — never assume based on
// the label text. "Gender" might be mandatory on one form and voluntary on another.
function isRequiredField(field) {
  const el = field.el;
  if (!el) return true;

  // HTML required attribute
  if (el.required) return true;

  // ARIA
  if (el.getAttribute('aria-required') === 'true') return true;

  // For radio groups: check if any radio has required
  if (field.type === 'radio' && field.options) {
    if (field.options.some(o => o.el?.required)) return true;
  }

  // Check the RAW surrounding text for * BEFORE cleanLabelText strips it.
  // This catches cases like <span class="req">*</span> inside a label wrapper.
  const surrounding = el.closest('label, fieldset, .field, .form-group, .form-item, li, [class*="field"], [class*="question"]');
  if (surrounding && /[*✱]/.test(surrounding.innerText)) return true;

  // Cleaned label still contains "required" keyword
  if (/\brequired\b/i.test(field.label || '')) return true;

  // Wrapper has a required CSS class or attribute
  const wrap = el.closest('[data-required="true"], [required], .required, .is-required, [class*="required"]');
  if (wrap && wrap !== el) return true;

  // Cross-shadow owner marks it required (SmartRecruiters spl-checkbox: the "*" is
  // in the custom element's shadow, not reachable via closest()).
  if (el.id) {
    for (const root of deepRoots()) {
      if (!root.host) continue;
      let lbl; try { lbl = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch { continue; }
      if (lbl && /[*✱]/.test(root.host.innerText || '')) return true;
    }
  }

  return false;
}

// ── APPLICATION LOG + DEDUPLICATION ──────────────────────────────────────────
function normalizeJobUrl(url) {
  try {
    const u = new URL(url || location.href);
    const h = u.hostname.replace(/^www\./, '');

    if (h.includes('adp.com'))
      return 'adp:' + (u.searchParams.get('jobId') || u.searchParams.get('requisitionId') || u.pathname);

    if (h.includes('linkedin.com')) {
      const m = u.pathname.match(/\/(jobs\/view|apply)\/(\d+)/);
      return m ? 'linkedin:' + m[2] : h + u.pathname;
    }

    if (h.includes('greenhouse.io'))   return 'greenhouse:'   + u.pathname.replace(/\/$/, '');
    if (h.includes('lever.co'))        return 'lever:'        + u.pathname.replace(/\/$/, '');
    if (h.includes('workday'))         return 'workday:'      + (u.searchParams.get('Job_ID') || u.pathname);
    if (h.includes('icims.com'))       return 'icims:'        + (u.searchParams.get('job') || u.pathname);
    if (h.includes('ziprecruiter.com'))return 'zip:'          + u.pathname.replace(/\/$/, '');
    if (h.includes('indeed.com'))      return 'indeed:'       + (u.searchParams.get('jk') || u.pathname);

    // Generic: hostname + pathname, no query string
    return h + u.pathname.replace(/\/$/, '');
  } catch { return url; }
}

async function isAlreadyApplied() {
  const norm = normalizeJobUrl(location.href);
  return new Promise(resolve => {
    chrome.storage.local.get({ applicationLog: [] }, d => {
      // Only warn for successfully submitted applications, not failed attempts
      const dup = d.applicationLog.some(a => a.normalizedUrl === norm && a.status === 'applied');
      resolve(dup);
    });
  });
}

async function logApplication(status) {
  const norm = normalizeJobUrl(location.href);
  chrome.storage.local.get({ applicationLog: [] }, d => {
    const log = d.applicationLog.filter(a => a.normalizedUrl !== norm); // replace if re-applied
    log.unshift({
      id:            Date.now(),
      url:           location.href,
      normalizedUrl: norm,
      title:         document.title.slice(0, 120),
      date:          new Date().toISOString(),
      status,        // 'applied' | 'failed' | 'skipped'
    });
    chrome.storage.local.set({ applicationLog: log.slice(0, 500) }); // cap at 500
  });
}

// ── APPLY / SUBMIT BUTTON HELPERS ────────────────────────────────────────────
function hasVisibleForm() {
  // Check native <form> tags first (shadow-aware)
  const inForm = deepQueryAll('form').some(f => isVisible(f) && f.querySelectorAll(FILLABLE).length > 0);
  if (inForm) return true;
  // Fallback: any visible fillable inputs anywhere on page (ADP, custom portals,
  // and shadow-DOM forms like SmartRecruiters)
  return pageHasFillableInputs();
}

// Selector covering native buttons, ARIA buttons and custom button web components
// (SmartRecruiters spl-button/oc-button, design-system *-button elements, etc.).
const BUTTON_SELECTOR = 'button, input[type="submit"], [role="button"], a[type="submit"], spl-button, oc-button, [class*="-button"], [class*="btn"]';

async function clickApplyButton() {
  const RE = /\b(apply|apply now|apply for this job|quick apply|easy apply|start application|i'?m interested)\b/i;
  const candidates = deepQueryAll(BUTTON_SELECTOR)
    .filter(el => {
      const t = (el.textContent || el.value || '').trim();
      return isVisible(el) && t.length < 40 && RE.test(t);
    });
  if (!candidates.length) return false;
  // Trusted click (some Apply buttons are react-gated, like the dropdowns).
  await trustedClickButton(candidates[0]);
  // Wait for the application form to render (lazy load / SPA / navigation).
  for (let i = 0; i < 14; i++) {
    await sleep(500);
    if (hasVisibleForm()) return true;
  }
  return hasVisibleForm();
}

async function captureValidationErrors() {
  await sleep(1200); // wait for error states to render

  const errorFields = [];
  const seen = new Set();

  // aria-invalid on inputs
  deepQueryAll('[aria-invalid="true"], [aria-invalid="error"]').forEach(el => {
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const label = getLabel(el) || el.name || el.id;
    if (label) errorFields.push({ el, type: getFieldType(el), label, name: el.name || el.id });
  });

  // Inputs inside wrappers with error class names
  deepQueryAll([
    '.field--error input, .field--error select, .field--error textarea',
    '.has-error input, .has-error select',
    '[class*="error"] input, [class*="error"] select',
    '[class*="invalid"] input',
  ].join(',')).forEach(el => {
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const label = getLabel(el) || el.name || el.id;
    if (label) errorFields.push({ el, type: getFieldType(el), label, name: el.name || el.id });
  });

  // Required fields that are still empty
  deepQueryAll('input[required], select[required], textarea[required], [aria-required="true"]').forEach(el => {
    if (seen.has(el) || !isVisible(el)) return;
    const empty = el.tagName === 'SELECT' ? el.value === '' || el.selectedIndex <= 0 : !(el.value || '').trim();
    if (!empty) return;
    seen.add(el);
    const label = getLabel(el) || el.name || el.id;
    if (label) errorFields.push({ el, type: getFieldType(el), label, name: el.name || el.id });
  });

  return errorFields;
}

function highlightFailedFields(errorFields) {
  errorFields.forEach(({ el }) => {
    if (!el) return;
    el.style.outline      = '2.5px solid #ff5566';
    el.style.outlineOffset = '2px';
    // Clear the highlight when the user interacts with the field
    const clear = () => {
      el.style.outline = '';
      el.style.outlineOffset = '';
    };
    el.addEventListener('input',  clear, { once: true });
    el.addEventListener('change', clear, { once: true });
    el.addEventListener('focus',  clear, { once: true });
  });
}

// ── MAIN AUTOFILL HANDLER ─────────────────────────────────────────────────────
async function handleAutofillClick() {
  // With all_frames, this runs in every frame. Only act in the frame that holds
  // (or, on a direct page, will reveal) the application form — so a stray trigger
  // in the top marketing page or a tracking iframe does nothing.
  if (window.top !== window && !looksLikeApplicationForm()) return;
  if (window.top === window && topShouldDeferToIframe()) return;

  setOverlayState('loading');

  const storage = await getStorage();
  const { resumeData, learnedAnswers } = storage;
  if (!resumeData || !Object.keys(resumeData).length) {
    showToast('⚠️ No profile data. Open extension → Settings and fill in your profile first.', 'warn');
    setOverlayState('idle');
    return;
  }

  // Deduplication — warn if already applied to this job
  if (await isAlreadyApplied()) {
    const proceed = confirm('⚠️ You have already applied to this job.\n\nClick OK to apply again, or Cancel to skip.');
    if (!proceed) { setOverlayState('idle'); return; }
  }

  // Ensure an application form is visible — click Apply and wait for it to render.
  if (!hasVisibleForm()) {
    showToast('🔍 No form visible — clicking Apply…', 'info');
    const clicked = await clickApplyButton();
    if (!clicked || !hasVisibleForm()) {
      showToast('⚠️ No form or Apply button found on this page.', 'warn');
      setOverlayState('idle');
      return;
    }
    showToast('✅ Apply clicked — form loaded.', 'info');
  }

  // ── Multi-page loop ─────────────────────────────────────────────────────────
  // Fill the current step, then advance (Next) or submit (last step). Only log
  // "applied" on a real confirmation — never on an intermediate page.
  const MAX_PAGES = 6;
  let totalFilled = 0;

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    if (isConfirmed()) {
      await logApplication('applied');
      setOverlayState('done');
      showToast(`✅ Submitted — application complete.`, 'success');
      return;
    }

    setOverlayState('loading');
    totalFilled += await fillCurrentPage(storage);

    const adv = findAdvanceButton();
    if (!adv) {
      setOverlayState('done');
      showToast(`✅ Filled ${totalFilled} field${totalFilled !== 1 ? 's' : ''}. No Submit/Next button — finish manually.`, 'info');
      return;
    }

    const sigBefore = pageSignature();
    let outcome = 'stuck';            // confirmed | advanced | errors | stuck
    let lastErrors = [];

    // Up to 3 tries on THIS step: top up required-empty fields, click advance, inspect.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const empties = scanAllFields().filter(f =>
        isRequiredField(f) && !isFieldFilled(f) && f.type !== 'file' && f.type !== 'checkbox');
      if (empties.length) await refillFields(empties, resumeData, learnedAnswers);

      const btn = findAdvanceButton();
      if (!btn) break;
      showToast(btn.kind === 'submit'
        ? `✅ Filled ${totalFilled} — submitting…`
        : `➡️ Step ${pageNum} filled — continuing…`, 'info');
      await trustedClickButton(btn.el);
      await sleep(1700); // let navigation / validation render

      if (isConfirmed()) { outcome = 'confirmed'; break; }

      lastErrors = await captureValidationErrors();
      if (lastErrors.length) {
        highlightFailedFields(lastErrors);
        await refillFields(lastErrors, resumeData, learnedAnswers);
        outcome = 'errors';
        await sleep(400);
        continue;
      }

      if (pageSignature() !== sigBefore) { outcome = 'advanced'; break; }
      // No confirmation, no errors, no page change: a Submit likely went through
      // via a quiet redirect; a Next that didn't move is stuck.
      outcome = (btn.kind === 'submit') ? 'confirmed' : 'stuck';
      break;
    }

    if (outcome === 'confirmed') {
      await logApplication('applied');
      setOverlayState('done');
      showToast(`✅ Submitted — application complete (${totalFilled} fields).`, 'success');
      return;
    }
    if (outcome === 'advanced') {
      // Let the next step render. Some ATSs (SmartRecruiters) load a step's
      // question labels asynchronously a beat after the fields appear, so wait for
      // the field set to settle before scanning — otherwise labels read empty and
      // questions get mis-mapped. (The per-step retry loop is a second safety net.)
      await sleep(900);
      let sig = '';
      for (let i = 0; i < 8; i++) {
        const cur = scanAllFields().map(f => f.label || f.name || '').join('|');
        if (cur && cur === sig) break;   // stabilised
        sig = cur;
        await sleep(350);
      }
      continue;
    }
    // Errors that wouldn't clear, or genuinely stuck — hand back to the user.
    const errs = lastErrors.length ? lastErrors : await captureValidationErrors();
    highlightFailedFields(errs);
    if (errs.length) await saveLearnedFields(errs);
    await logApplication('failed');
    setOverlayState('error');
    showToast(errs.length
      ? `⚠️ ${errs.length} field${errs.length !== 1 ? 's' : ''} need attention — highlighted in red.`
      : `⚠️ Couldn't advance past this step — please finish manually.`, 'warn');
    return;
  }

  setOverlayState('done');
  showToast(`Reached the ${MAX_PAGES}-step limit — review & submit the final step manually.`, 'info');
}

// Fill every fillable field currently on the page: consent checkboxes, then
// resume-profile mapping, learned answers, and (optionally) Claude for the rest.
// Returns how many fields were filled. Safe to call once per page in a wizard.
async function fillCurrentPage(storage) {
  const { resumeData, claudeApiKey, claudeEnabled, resumeFile, resumeFilePath, resumeText, learnedAnswers } = storage;
  const fields   = scanAllFields();
  const unmapped = [];
  let   filled   = 0;

  // Pre-pass: auto-check mandatory consent/agreement checkboxes only
  const CONSENT_RE = /\b(agree|consent|certif|acknowledg|confirm|accept|authorize|authoris|attest|declare|understand|warrant)\b|terms|privacy.?polic|background.?check/i;
  for (const field of fields) {
    if (field.type !== 'checkbox') continue;
    if (!isRequiredField(field)) continue;
    const surrounding = field.el?.closest('label, .field, .form-group, li')?.innerText || '';
    if (!CONSENT_RE.test((field.label || '') + ' ' + surrounding)) continue;
    fillCheckbox(field.el, 'yes');
    filled++;
  }

  // Pass 1: fill from resume profile data
  for (const field of fields) {
    if (field.type === 'checkbox') continue;
    if (field.type === 'file') {
      const fel = field.el;
      // getLabel often returns the "Attach" button text for file inputs — detect
      // from id/name/aria + the resume-aware helper instead.
      const hay = `${field.label || ''} ${getFileInputLabel(fel)} ${fel.id || ''} ${fel.name || ''} ${fel.getAttribute('aria-label') || ''}`.toLowerCase();
      // Don't drop the résumé onto a cover-letter/portfolio/photo/etc. uploader.
      const isOther = /cover.?letter|portfolio|transcript|photo|headshot|picture|certificate|diploma|reference/i.test(hay);
      // Resume keywords, OR a generic upload control (SmartRecruiters dropzone:
      // "Choose a file or drop it here") which on application forms is the résumé.
      const isResumeInput = !isOther &&
        (/\b(resume|cv|curriculum.?vitae)\b/i.test(hay) || /attach|upload|drop|choose a file|drag|dropzone/i.test(hay));
      if (isResumeInput) {
        const ok = await attachResume(fel, { resumeFile });
        if (ok) filled++;
        else clickAttachButton(fel) || highlightFileInput(fel);
      }
      continue;
    }

    const value = mapFromResume(field, resumeData);
    if (value !== null && value !== undefined && value !== '') {
      const ok = await fillField(field, value);
      if (ok) { filled++; if (requiresValidation(field) && !validateSelectableField(field)) unmapped.push(field); }
      else unmapped.push(field);
    } else if (isRequiredField(field)) {
      unmapped.push(field);
    }
    await sleep(30);
  }

  // Pass 2: learned answers (user-supplied from previous runs)
  const stillUnmapped = [];
  for (const field of unmapped) {
    const key    = (field.label || field.name || '').trim();
    const entry  = learnedAnswers[key];
    const answer = entry && (typeof entry === 'string' ? entry : entry.answer);
    if (answer) {
      const ok = await fillField(field, answer);
      if (ok) { filled++; if (requiresValidation(field)) validateSelectableField(field); }
      else if (isRequiredField(field)) stillUnmapped.push(field);
    } else if (isRequiredField(field)) {
      stillUnmapped.push(field);
    }
    await sleep(30);
  }

  // Pass 2.5: voluntary demographic/EEO questions (pronouns, gender, sexual
  // orientation, race/ethnicity, veteran, disability) — default to the "decline to
  // self-identify" option. Privacy-preserving: we never fabricate these answers,
  // and this clears the required-field validation that would otherwise block
  // submission. A user-saved answer (Pass 2) always wins over this.
  const demoUnfilled = [];
  for (const field of stillUnmapped) {
    if (!isDemographicField(field) || field.type === 'file' || field.type === 'checkbox') continue;
    const ok = await fillDeclineOption(field);
    if (ok) { filled++; if (requiresValidation(field)) validateSelectableField(field); }
    else demoUnfilled.push(field);
    await sleep(30);
  }

  // Pass 3: Claude for REQUIRED fields still unmapped — excluding demographic fields
  // we just declined (only those with no decline option fall through to Claude).
  const claudeFields = stillUnmapped.filter(f =>
    f.type !== 'file' && f.type !== 'checkbox' && isRequiredField(f) &&
    (!isDemographicField(f) || demoUnfilled.includes(f)));
  if (claudeFields.length && claudeEnabled && claudeApiKey) {
    setOverlayState('claude');
    try {
      const resumeContext = resumeText || buildResumeSummary(resumeData);
      const answers = await askClaude(claudeFields, resumeContext, claudeApiKey);
      const truelyUnfilled = [];
      for (const { field, answer } of answers) {
        if (answer) {
          const ok = await fillField(field, answer);
          if (ok) { filled++; if (requiresValidation(field)) validateSelectableField(field); }
          else truelyUnfilled.push(field);
        } else truelyUnfilled.push(field);
        await sleep(30);
      }
      if (truelyUnfilled.length) await saveLearnedFields(truelyUnfilled);
    } catch (err) {
      showToast(`🤖 Claude error: ${err.message}`, 'warn');
      await saveLearnedFields(claudeFields);
    }
  } else if (claudeFields.length) {
    await saveLearnedFields(claudeFields);
    const reason = !claudeEnabled ? 'Claude AI is disabled' : 'no API key set';
    showToast(`💡 ${claudeFields.length} field${claudeFields.length !== 1 ? 's' : ''} saved to Settings → "Saved Form Answers" (${reason}).`, 'info');
  }

  return filled;
}

// Find the button to move the form forward. Distinguishes a final Submit from an
// intermediate Next/Continue so the multi-page loop knows whether it's done.
function findAdvanceButton() {
  const txt = el => (el.textContent || el.value || '').trim();
  const SUBMIT = /\b(submit application|submit your application|submit|send application|finish|complete application)\b/i;
  const NEXT   = /\b(next|continue|save and continue|save & continue|review|proceed)\b/i;
  const byBottom = (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top;

  // Prefer real button elements / button web components; only fall back to the
  // generic class-based matches so we don't click a non-interactive wrapper.
  const primary = deepQueryAll('button, input[type="submit"], [role="button"], a[type="submit"], spl-button, oc-button').filter(isVisible);
  const fallback = deepQueryAll('[class*="-button"], [class*="btn"]').filter(isVisible);
  const all = primary.length ? primary : fallback;
  const ok = el => !el.disabled && txt(el).length < 40;

  const submitBtns = all.filter(el => ok(el) && SUBMIT.test(txt(el))).sort(byBottom);
  if (submitBtns.length) return { el: submitBtns[0], kind: 'submit' };
  const nextBtns = all.filter(el => ok(el) && NEXT.test(txt(el))).sort(byBottom);
  if (nextBtns.length) return { el: nextBtns[0], kind: 'next' };
  const native = all.find(el => el.type === 'submit');
  if (native) return { el: native, kind: 'submit' };
  const formBtns = all.filter(el => closestDeep(el, 'form') && el.tagName === 'BUTTON' && el.type !== 'reset' && el.type !== 'button');
  if (formBtns.length) return { el: formBtns[formBtns.length - 1], kind: 'submit' };
  return null;
}

// A fingerprint of the current step — changes when the form advances to a new page.
function pageSignature() {
  const labels  = scanAllFields().map(f => (f.label || f.name || '')).filter(Boolean).slice(0, 25).join('|');
  const heading = (deepQuery('h1, h2, [class*="step"], [class*="progress"], [aria-current="step"]') || {}).textContent || '';
  return (location.href + '::' + heading.slice(0, 50) + '::' + labels).slice(0, 600);
}

// Trusted click on a submit/next button (synthetic + requestSubmit fallback).
async function trustedClickButton(el) {
  const ok = await nativeClick(el);
  if (!ok) {
    el.click();
    const form = el.closest('form');
    if (form && form.requestSubmit) { try { form.requestSubmit(el.type === 'submit' ? el : undefined); } catch {} }
  }
}

// True once the page shows a real application-confirmation state — prevents
// logging "applied" on a form that merely had no inline errors.
function isConfirmed() {
  const txt = `${location.href} ${document.title} ${(document.body?.innerText || '').slice(0, 3000)}`;
  return /thank.?you for applying|thank.?you for your (application|interest)|application (was )?(submitted|received|complete)|successfully applied|we.?ve received your application|your application has been (sent|submitted|received)|application[-\s]?confirmation/i.test(txt);
}

// Re-map and re-fill a set of error / still-empty fields (resume + learned answers;
// no Claude call here to avoid repeated API hits on retries).
async function refillFields(targets, r, learnedAnswers) {
  const byEl = new Map(scanAllFields().map(f => [f.el, f]));
  for (const t of targets) {
    const field = byEl.get(t.el) || t;
    if (!field || field.type === 'file' || field.type === 'checkbox') continue;
    let value = mapFromResume(field, r);
    if (!value) {
      const key   = (field.label || field.name || '').trim();
      const entry = learnedAnswers && learnedAnswers[key];
      value = entry && (typeof entry === 'string' ? entry : entry.answer);
    }
    if (value) { await fillField(field, value); await sleep(40); }
  }
}

// ── FIELD SCANNER ─────────────────────────────────────────────────────────────
function scanAllFields() {
  const fields = [];
  const seen   = new Set();

  deepQueryAll('input, select, textarea').forEach(el => {
    // Allow hidden file inputs through — Greenhouse/Lever hide them behind "Attach" buttons
    const isHiddenFile = el.type === 'file' && !isVisible(el);
    if (!isVisible(el) && el.type !== 'hidden' && !isHiddenFile) return;
    if (el.disabled || el.readOnly) return;
    if (seen.has(el)) return;
    seen.add(el);

    const type = getFieldType(el);
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') return;

    // Group radio buttons by name — only add the group once
    if (type === 'radio') {
      const name = el.name || el.id;
      if (!name || seen.has('radio:' + name)) return;
      seen.add('radio:' + name);
      const root = el.getRootNode();
      const group = Array.from((root.querySelectorAll ? root : document).querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
      fields.push({
        el,
        type: 'radio',
        name,
        label: getLabel(el) || getGroupLabel(group) || name,
        options: group.map(r => ({ el: r, value: r.value, text: getLabel(r) || r.value })),
      });
      return;
    }

    // Checkbox
    if (type === 'checkbox') {
      fields.push({
        el,
        type: 'checkbox',
        name: el.name || el.id,
        label: getLabel(el) || el.value,
        value: el.value,
      });
      return;
    }

    // Select
    if (type === 'select') {
      const options = Array.from(el.options)
        .filter(o => o.value !== '')
        .map(o => ({ value: o.value, text: o.text.trim() }));
      fields.push({ el, type: 'select', name: el.name || el.id, label: getLabel(el), options });
      return;
    }

    const label = getLabel(el) || getFileInputLabel(el);
    fields.push({ el, type, name: el.name || el.id, label });
  });

  // ── Custom / ARIA comboboxes (non-native selects) ─────────────────────────
  // Covers Greenhouse, Lever, Workday, React-Select, and any role="combobox"
  const comboSelectors = [
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '[aria-haspopup="true"]',
  ];
  deepQueryAll(comboSelectors.join(',')).forEach(el => {
    if (seen.has(el)) return;
    if (!isVisible(el)) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    seen.add(el);
    fields.push({
      el,
      type:  'combobox',
      name:  el.name || el.id || el.getAttribute('aria-label') || '',
      label: getLabel(el),
    });
  });

  // ── Custom ARIA radio groups (no native <input type="radio">) ─────────────────
  // SmartRecruiters spl-radio-group, design-system radios, etc.: the options are
  // [role="radio"] / spl-radio elements with a `label`/aria-label, not inputs.
  deepQueryAll('spl-radio-group, [role="radiogroup"]').forEach(group => {
    if (seen.has(group) || !isVisible(group)) return;
    const radios = deepWithin(group, '[role="radio"], spl-radio').filter(r => isVisible(r) && !seen.has(r));
    if (radios.length < 2) return;          // need real options; skip empty wrappers
    seen.add(group);
    radios.forEach(r => seen.add(r));
    const slot = group.querySelector?.('[slot*="label"]');
    const label = (slot && slot.innerText.trim()) || getLabel(group) || group.getAttribute('aria-label') || '';
    fields.push({
      el: radios[0],
      type: 'radio',
      name: group.id || group.getAttribute('name') || label,
      label: cleanLabelText(label),
      options: radios.map(r => ({
        el: r,
        value: r.getAttribute('value') || '',
        text: (r.getAttribute('label') || r.getAttribute('aria-label') || r.textContent || '').replace(/\s+/g, ' ').trim()
              || (r.id && (document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.innerText || '')).trim(),
      })),
    });
  });

  return fields;
}

function getFieldType(el) {
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'TEXTAREA') return 'textarea';
  // React-select / ARIA comboboxes are <input role="combobox"> (e.g. Greenhouse's
  // .select__input). Classify them as combobox — NOT text — so they route to the
  // dropdown filler (open → pick option) instead of being typed into like a textbox.
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'combobox';
  return (el.type || 'text').toLowerCase();
}

// ── LABEL EXTRACTION ──────────────────────────────────────────────────────────
function cleanLabelText(text) {
  return (text || '').replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
}

function getLabel(el) {
  const root = el.getRootNode();           // the shadow root (or document) the field lives in
  const scope = root && root.querySelector ? root : document;

  // 1. Explicit <label for="id"> — resolved within the element's own (shadow) root
  if (el.id) {
    let explicit = null;
    try { explicit = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch {}
    if (explicit && cleanLabelText(explicit.innerText)) return cleanLabelText(explicit.innerText);
  }

  // 1b. Cross-shadow <label for>: SmartRecruiters spl-checkbox keeps the real
  //     <input> in light DOM but its <label for> inside the component's shadow,
  //     where the label's own text is just "*" and the real text is the host's
  //     slotted content. Find the owning host and use its rendered innerText.
  if (el.id) {
    for (const root of deepRoots()) {
      if (root === scope || !root.host) continue;
      let lbl; try { lbl = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch { continue; }
      if (lbl) {
        const t = cleanLabelText(root.host.innerText);
        if (t) return t;
      }
    }
  }

  // 2. aria-label / aria-labelledby
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const ariaBy = el.getAttribute('aria-labelledby');
  if (ariaBy) {
    let ref = null;
    try { ref = scope.querySelector(`#${CSS.escape(ariaBy)}`); } catch {}
    if (ref) return cleanLabelText(ref.innerText);
  }

  // 2.5 Web-component question wrappers (SmartRecruiters sr-question-field-*,
  //     spl-form-field, …) render the question text inside shadow DOM, so <label>
  //     and textContent miss it (the field's own shadow only holds the "*"). The
  //     wrapper's rendered innerText holds the real question — climb to it.
  let wnode = el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  for (let i = 0; i < 16 && wnode; i++) {
    const tag = (wnode.tagName || '').toLowerCase();
    // Prefer a real question wrapper; the inner spl-internal-form-field only holds
    // the "*" marker, so an empty/punctuation-only result keeps climbing.
    if (/sr-question|question-field|field-select|form-field/.test(tag)) {
      const t = (wnode.innerText || '')
        .replace(/\bthis field is required\.?/ig, '')
        .replace(/no suggestions?/ig, '')
        .replace(/value is required\.?/ig, '')
        .replace(/select\.\.\.?/ig, '')
        .replace(/[*✱]/g, '')
        .replace(/\brequired\b/ig, '')
        .replace(/\s+/g, ' ').trim();
      if (t && t.length >= 2 && t.length < 140) return t;
    }
    wnode = wnode.parentElement || (wnode.getRootNode() instanceof ShadowRoot ? wnode.getRootNode().host : null);
  }

  // 3. Walk up the DOM, look for a DIRECT CHILD label/legend of each ancestor
  //    Skip labels that themselves wrap an input (option-item pattern)
  let node = el.parentElement;
  while (node && node !== document.body) {
    // Check direct children only (:scope >) so we don't grab nested option labels
    const candidates = node.querySelectorAll(':scope > label, :scope > legend');
    for (const c of candidates) {
      if (c.querySelector('input, select, textarea')) continue; // skip option-item wrappers
      const text = cleanLabelText(c.innerText);
      if (text) return text;
    }
    // Stop searching at common form-group boundaries
    if (node.matches('form, fieldset, [role="group"]') ||
        /\b(field|form.?group|form.?item|question|card|section)\b/i.test(node.className || '')) break;
    node = node.parentElement;
  }

  // 4. Web-component label fallback (SmartRecruiters spl-typography-label, design
  //    systems, etc.): walk up — crossing shadow boundaries — and grab the nearest
  //    label-ish sibling element that holds short text and no form control.
  const labelish = c => (/label|legend/i.test(c.tagName) || /label/i.test(c.className || '') ||
                         /typography-label/i.test(c.tagName)) &&
                        c.innerText && !c.querySelector('input, select, textarea, button');
  node = el.parentElement;
  for (let i = 0; i < 6 && node; i++) {
    const cand = Array.from(node.children).find(labelish);
    if (cand) { const t = cleanLabelText(cand.innerText); if (t) return t; }
    node = node.parentElement || (node.getRootNode() instanceof ShadowRoot ? node.getRootNode().host : null);
  }

  // 5. Fall back to name/id (never use placeholder — it's example data, not a label)
  return el.name || el.id || '';
}

// For hidden file inputs (Greenhouse/Lever "Attach" pattern), look at the
// surrounding section heading since getLabel can't find a visible label.
function getFileInputLabel(el) {
  if (el.type !== 'file') return '';
  const nameAttr = (el.name || el.id || el.getAttribute('aria-label') || '').toLowerCase();
  if (/resume|cv|curriculum/i.test(nameAttr)) return 'Resume/CV';
  if (/cover/i.test(nameAttr)) return 'Cover Letter';
  // Walk up to find a section label
  let node = el.parentElement;
  while (node && node !== document.body) {
    const heading = node.querySelector('h1,h2,h3,h4,label,[class*="label"],[class*="heading"],[class*="title"]');
    if (heading && heading.innerText.trim()) return heading.innerText.replace(/[*✱]/g,'').trim();
    if (/resume|cv|upload|attach/i.test(node.className || '')) return 'Resume/CV';
    node = node.parentElement;
  }
  return '';
}

function getGroupLabel(radioGroup) {
  // Same walk-up approach for radio/checkbox groups
  let node = radioGroup[0]?.parentElement;
  while (node && node !== document.body) {
    const candidates = node.querySelectorAll(':scope > label, :scope > legend');
    for (const c of candidates) {
      if (c.querySelector('input, select, textarea')) continue;
      const text = cleanLabelText(c.innerText);
      if (text) return text;
    }
    if (node.matches('form, fieldset') ||
        /\b(field|form.?group|question|card|section)\b/i.test(node.className || '')) break;
    node = node.parentElement;
  }
  return '';
}

// ── RESUME → FIELD MAPPING ────────────────────────────────────────────────────
const RESUME_MAP = [
  // Personal
  { re: /first.?name|given.?name|fname/i,          key: 'firstName' },
  { re: /last.?name|family.?name|surname|lname/i,  key: 'lastName' },
  { re: /\bfull.?name\b/i,                          key: null, fn: r => `${r.firstName||''} ${r.lastName||''}`.trim() },
  { re: /\bemail\b/i,                               key: 'email' },
  { re: /phone|telephone|mobile|cell/i,             key: 'phone' },
  { re: /\bcity\b|\btown\b/i,                        key: 'city' },   // \b so "Ethnicity" doesn't match "city"
  { re: /zip|postal/i,                              key: 'zip' },
  { re: /\bstate\b|province/i,                      key: 'state' },
  { re: /country/i,                                 key: 'country' },
  { re: /address|street/i,                          key: 'address' },
  // Education
  { re: /school|university|college|institution/i,   key: 'school' },
  { re: /field.?of.?study|major|discipline/i,       key: 'fieldOfStudy' },
  { re: /grad.?year|graduation.?year|class.?of/i,   key: 'gradYear' },
  // Professional
  { re: /current.?title|job.?title|most.?recent.?title|your.?title/i, key: 'title' },
  { re: /current.?employer|current.?company|most.?recent.?employer|employer.?name/i, key: 'employer' },
  { re: /linkedin/i,                                key: 'linkedin' },
  { re: /github/i,                                  key: 'github' },
  { re: /portfolio|personal.?site|website/i,        key: 'website' },
  { re: /salary|compensation|pay|salary.?expect/i,  key: 'salary' },
  { re: /cover.?letter/i,                           key: 'coverLetter' },
  { re: /years?.?of?.?exp|experience.?years|total.?years/i, key: 'yearsExp' },
];

// Radio/select option value mapping
const SELECT_MAP = [
  {
    re: /work.?auth|authorization|visa.?status|us.?status/i,
    key: 'workAuth',
    valueMap: {
      'US Citizen': ['citizen', 'us_citizen'],
      'Green Card': ['green_card', 'greencard', 'pr', 'permanent'],
      'H1B':        ['h1b', 'h-1b', 'h1'],
      'OPT':        ['opt', 'stem_opt', 'cpt'],
      'Other':      ['other_auth', 'other'],
    },
  },
  {
    // "Do you now or in the future require sponsorship?" — default NO.
    // Respects an explicit profile value if set, otherwise answers No.
    re: /sponsor|sponsorship|require.?visa|need.?sponsor|immigration.?support/i,
    key: 'requiresSponsorship',
    value: 'No',
    valueMap: { 'Yes': ['yes', 'true', '1'], 'No': ['no', 'false', '0'] },
  },
  {
    // "Are you authorized to work in the country of the job?" — answer YES.
    // SAFETY: this is a yes/no *eligibility* question, NOT a status question.
    // Never resolve it to "US Citizen"/"Green Card" — that would be a false
    // statement for a work-authorized non-citizen. (See the separate
    // work.?auth|visa.?status rule for explicit status dropdowns.)
    re: /authorized.?to.?work|legally.?authorized|work.?authoriz|eligible.?to.?work|authorized.?to.?be.?employed|legally.?eligible/i,
    value: 'Yes',
    valueMap: { 'Yes': ['yes', 'authorized', 'eligible', 'i am', 'true'], 'No': ['no', 'not', 'false'] },
  },
  {
    // "Are you a current employee / have you previously performed work here?" — No
    re: /previous(ly)?.*(employ|work|perform)|prior.*(employ|work)|current(ly)?.*employ|are you.*current.*employee|perform(ed)?.*work.*for|worked.*(here|for)|former.*employee/i,
    value: 'No',
    valueMap: { 'Yes': ['yes', 'true'], 'No': ['no', 'false'] },
  },
  {
    // "Do you currently hold a visa (incl. student visa) to work in the US?" — No.
    // SAFETY: consistent with the sponsorship=No / authorized=Yes stance (not on a
    // sponsored visa). Never claims citizenship/PR.
    re: /hold a.*visa|currently hold.*visa|do you.*hold.*visa/i,
    value: 'No',
    valueMap: { 'Yes': ['yes', 'true'], 'No': ['no', 'false'] },
  },
  {
    // "Are you bound by confidentiality / non-disclosure / non-compete agreements?" — No
    re: /bound by|non.?compete|non.?disclosure|\bnda\b|restrictive covenant|confidentiality.*(agreement|obligation)/i,
    value: 'No',
    valueMap: { 'Yes': ['yes', 'true'], 'No': ['no', 'false'] },
  },
  {
    // "Select the appropriate visa type" / "What type of visa do you hold?" — for a
    // work-authorized applicant who doesn't need sponsorship, the correct answer is
    // "Not applicable". SAFETY: never selects a specific visa or any citizenship/PR
    // status; consistent with the sponsorship=No / authorized=Yes stance.
    re: /visa.?type|type.?of.?visa|appropriate.?visa|which.?visa|select.*visa/i,
    value: 'Not applicable',
    valueMap: { 'Not applicable': ['not.?applicable', 'n/?a', 'none', 'not.?apply'] },
  },
  {
    // "Are you 18 years of age or older?"
    re: /18.?years|years.?of.?age|legal.?age/i,
    value: 'Yes',
    valueMap: { 'Yes': ['yes', 'true', '1'], 'No': ['no', 'false', '0'] },
  },
  {
    // "I would like to receive updates via SMS"
    re: /sms|text.?message|receive.?update/i,
    value: 'No',
    valueMap: { 'Yes': ['yes'], 'No': ['no'] },
  },
  {
    re: /employment.?type|work.?type|job.?type/i,
    value: 'full-time',
    valueMap: { 'full-time': ['full.?time', 'permanent', 'fulltime'] },
  },
  {
    re: /work.?location|remote.?pref|office.?pref/i,
    value: 'remote',
    valueMap: { 'remote': ['remote', 'wfh'], 'hybrid': ['hybrid'], 'onsite': ['on.?site', 'office'] },
  },
  {
    re: /degree|education.?level|highest.?degree/i,
    key: 'degree',
    valueMap: {
      "Bachelor's": ['bachelor', 'b.s', 'b.a', 'undergraduate'],
      "Master's":   ['master', 'm.s', 'm.a', 'graduate'],
      'PhD':        ['phd', 'doctorate'],
      'MBA':        ['mba'],
    },
  },
  {
    // years of experience select (maps numeric yearsExp to range options)
    re: /years?.?of?.?exp|experience/i,
    key: 'yearsExp',
    valueMap: {
      '0-1':  ['0', '0-1', 'less than 1', 'less than one'],
      '1-2':  ['1', '1-2'],
      '2-4':  ['2', '3', '2-4'],
      '4-6':  ['4', '5', '4-6'],
      '6-10': ['6', '7', '8', '9', '6-10'],
      '10+':  ['10', '11', '12', '15', '20', '10+', '10 plus'],
    },
  },
  {
    re: /willing.?to.?relocate|relocation/i,
    value: 'no',
    valueMap: { 'yes': ['yes', 'true'], 'no': ['no', 'false'], 'maybe': ['open', 'maybe', 'consider'] },
  },
  {
    re: /travel/i,
    value: 'minimal',
    valueMap: { 'yes': ['yes', '25'], 'minimal': ['minimal', 'occasional'], 'no': ['no', 'none'] },
  },
  {
    re: /referral|how.?did.?you.?hear|source/i,
    value: 'linkedin',
    valueMap: { 'linkedin': ['linkedin'], 'indeed': ['indeed'], 'other': ['other'] },
  },
];

function mapFromResume(field, r) {
  const ctx = `${field.label} ${field.name} ${field.el?.id || ''} ${field.el?.getAttribute('autocomplete') || ''}`.toLowerCase();

  // Text/regex map — also the fallback for comboboxes like Country.
  const fromResumeMap = () => {
    for (const { re, key, fn } of RESUME_MAP) {
      if (re.test(ctx)) return fn ? fn(r) : (r[key] || null);
    }
    return null;
  };

  // select, radio AND combobox (react-select) all resolve via the selectable
  // logic first, then the text map (Country etc.), then an exact label lookup.
  if (field.type === 'select' || field.type === 'radio' || field.type === 'combobox') {
    return mapSelectableFromResume(field, r, ctx) || fromResumeMap() || exactLabelLookup(field.label, r);
  }

  if (field.type === 'checkbox') return null;

  // Text fields — regex pattern matching first, then exact label match.
  return fromResumeMap() || exactLabelLookup(field.label, r);
}

function exactLabelLookup(label, r) {
  if (!label) return null;
  // Direct key match (e.g. r["Veteran Status"] = "Not a veteran")
  if (r[label]) return r[label];
  // Case-insensitive match
  const lower = label.toLowerCase();
  const key = Object.keys(r).find(k => k.toLowerCase() === lower);
  return key ? r[key] : null;
}

function mapSelectableFromResume(field, r, ctx) {
  for (const mapping of SELECT_MAP) {
    if (!mapping.re.test(ctx)) continue;

    // Prefer the profile value; fall back to the rule's safe default when unset.
    let rawValue = mapping.key ? r[mapping.key] : mapping.value;
    if (rawValue === undefined || rawValue === null || rawValue === '') rawValue = mapping.value;
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;

    const options = field.type === 'radio'
      ? field.options.map(o => ({ value: o.value, text: o.text }))
      : (field.options || []);

    // Try to match rawValue against available options
    for (const [canonical, patterns] of Object.entries(mapping.valueMap || {})) {
      const isMatch = patterns.some(p => new RegExp(p, 'i').test(rawValue));
      if (!isMatch) continue;

      // Combobox (react-select): its options aren't in the DOM until it's opened,
      // so return the canonical answer and let fillCombobox find it live.
      if (!options.length) return canonical;

      // Find the actual option with that value/text
      const match = options.find(o =>
        patterns.some(p => new RegExp(p, 'i').test(o.value) || new RegExp(p, 'i').test(o.text))
      );
      if (match) return match.value;
    }

    // Combobox with no valueMap hit — hand the raw value to fillCombobox to search.
    if (!options.length) return rawValue;

    // Direct match fallback
    const direct = options.find(o =>
      o.value.toLowerCase().includes(rawValue.toLowerCase()) ||
      o.text.toLowerCase().includes(rawValue.toLowerCase())
    );
    if (direct) return direct.value;
  }

  return null;
}

// ── FIELD FILLER ──────────────────────────────────────────────────────────────
async function fillField(field, value) {
  try {
    switch (field.type) {
      case 'radio':     return fillRadio(field, value);
      case 'select':    return fillSelect(field.el, value);
      case 'combobox':  return fillCombobox(field, value);
      case 'checkbox':  return fillCheckbox(field.el, value);
      case 'file':      return false;
      case 'textarea':
      case 'text':
      case 'email':
      case 'tel':
      case 'url':
      case 'number':
      case 'date':
      default:
        return fillText(field.el, value);
    }
  } catch { return false; }
}

function fillText(el, value) {
  if (el.value === String(value)) return true;
  el.focus();
  el.dispatchEvent(new Event('focus', { bubbles: true }));
  // Use native prototype setter to bypass React's read-only value trap
  triggerReactSetter(el, 'value', value);
  el.value = value;
  // InputEvent with inputType is required for React 17+ controlled inputs
  el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: true, inputType: 'insertText', data: String(value) }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
  el.classList.add('ot-filled');
  return true;
}

function fillSelect(el, value) {
  let opt = Array.from(el.options).find(o => o.value === value);
  if (!opt) opt = Array.from(el.options).find(o =>
    o.value.toLowerCase().includes(value.toLowerCase()) ||
    o.text.toLowerCase().includes(value.toLowerCase())
  );
  if (!opt) return false;

  // Trigger React/Vue internal setter before setting value
  triggerReactSetter(el, 'value', opt.value);
  el.value = opt.value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
  el.classList.add('ot-filled');
  return true;
}

// ── COUNTRY ALIAS MAP ─────────────────────────────────────────────────────────
// Maps any stored country value to the canonical text most forms show.
const COUNTRY_ALIASES = {
  'united states': ['united states', 'united states of america', 'usa', 'us'],
  'canada':        ['canada', 'ca'],
  'united kingdom':['united kingdom', 'uk', 'great britain', 'gb', 'england'],
  'australia':     ['australia', 'au'],
  'india':         ['india', 'in'],
  'germany':       ['germany', 'de', 'deutschland'],
  'france':        ['france', 'fr'],
  'singapore':     ['singapore', 'sg'],
  'ireland':       ['ireland', 'ie'],
  'netherlands':   ['netherlands', 'nl', 'holland'],
  'new zealand':   ['new zealand', 'nz'],
  'brazil':        ['brazil', 'br', 'brasil'],
  'mexico':        ['mexico', 'mx', 'méxico'],
  'japan':         ['japan', 'jp'],
  'china':         ['china', 'cn'],
  'south korea':   ['south korea', 'kr', 'korea'],
};

function normaliseCountry(raw) {
  const lower = (raw || '').toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.includes(lower)) return canonical;
  }
  return lower; // pass through as-is for unlisted countries
}

// Activate an element with a full synthetic pointer+mouse sequence. React
// components (react-select, etc.) gate on POINTER events — a bare MouseEvent
// won't open them, but pointerdown→mousedown→pointerup→mouseup→click does.
// Pure DOM, so it works in any frame (incl. cross-origin iframes) with no
// special permission and no "debugging this browser" banner.
async function nativeClick(el) {
  try {
    if (!el) return false;
    let r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    // Only scroll when off-screen (react-select closes its menu on scroll, which
    // would detach an already-visible option).
    if (r.top < 4 || r.bottom > window.innerHeight - 4) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      await sleep(120);
      r = el.getBoundingClientRect();
    }
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const pe = { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y };
    const me = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerover',  pe));
    el.dispatchEvent(new PointerEvent('pointerenter', pe));
    el.dispatchEvent(new PointerEvent('pointerdown',  { ...pe, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown',      { ...me, buttons: 1 }));
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(new PointerEvent('pointerup',    { ...pe, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup',        me));
    el.dispatchEvent(new MouseEvent('click',          me));
    return true;
  } catch { return false; }
}

// Type into a field character-by-character with real keyboard events. Async
// autocompletes (SmartRecruiters' city/location lookup, etc.) only fire their
// search on keydown/keyup — a single programmatic 'input' event isn't enough.
async function typeWithKeys(el, text) {
  try {
    el.focus();
    triggerReactSetter(el, 'value', '');
    el.value = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    let acc = '';
    for (const ch of String(text)) {
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, key: ch }));
      acc += ch;
      triggerReactSetter(el, 'value', acc);
      el.value = acc;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, composed: true, key: ch }));
      await sleep(55);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /* ignore */ }
}

function pressKey(el, key, keyCode) {
  ['keydown', 'keyup'].forEach(t =>
    el.dispatchEvent(new KeyboardEvent(t, { bubbles: true, cancelable: true, composed: true, key, code: key, keyCode, which: keyCode })));
}

// ── DEMOGRAPHIC / EEO QUESTIONS ───────────────────────────────────────────────
// Voluntary self-identification questions. When the user hasn't supplied an answer
// we select the "decline to self-identify" option — we never fabricate these, and
// declining is the option the form itself offers for exactly this case.
const DEMOGRAPHIC_RE = /pronoun|gender|sexual.?orientation|\borientation\b|transgender|\brace\b|ethnic|hispanic|latin[oax]|veteran|disab|lgbt|self.?identif|identify.?with|demographic|national.?origin/i;
const DECLINE_RE     = /decline|prefer.?not|don.?t.?wish|do.?not.?wish|don.?t.?want|do.?not.?want|not.?to.?(?:answer|say|disclose|identify|specify)|choose.?not|rather.?not|wish.?not|i.?prefer.?not|unspecified|not.?listed|no.?response/i;
const DECLINE_TOKEN  = ' decline';

function isDemographicField(field) {
  return DEMOGRAPHIC_RE.test(`${field.label || ''} ${field.name || ''}`);
}

// Choose the "decline to self-identify / prefer not to answer" option on a
// demographic combobox, native <select>, or radio group. Returns true if found.
async function fillDeclineOption(field) {
  if (field.type === 'combobox') return fillCombobox(field, DECLINE_TOKEN);
  const opts = field.options || [];
  const hit = opts.find(o => DECLINE_RE.test(o.text || '') || DECLINE_RE.test(o.value || ''));
  if (!hit) return false;
  return field.type === 'radio' ? fillRadio(field, hit.value) : fillSelect(field.el, hit.value);
}

// ── CUSTOM COMBOBOX FILLER ────────────────────────────────────────────────────
async function fillCombobox(field, value) {
  const el = field.el;
  const isDecline = value === DECLINE_TOKEN;

  // Normalise country values before trying to match
  const isCountry = /country|nation/i.test(field.label + field.name);
  const searchVal = isDecline ? '' : (isCountry ? normaliseCountry(value) : String(value).toLowerCase());

  // The clickable "control": react-select wrappers first, then the combobox role
  // (SmartRecruiters autocomplete inputs are themselves role=combobox), then a
  // button (SR phone country-code select), else the element itself.
  const control =
    closestDeep(el, '[class*="select__control"], [class*="-control"], [class*="combo"]') ||
    (el.getAttribute('role') === 'combobox' ? el : null) ||
    (el.tagName === 'BUTTON' ? el : null) ||
    el.parentElement || el;
  const readCur = () => (control.querySelector?.('[class*="single-value"], [class*="singleValue"]')?.textContent || el.value || '').trim().toLowerCase();

  // Skip if this combobox already shows the target value (no re-typing / doubling)
  const cur0 = readCur();
  if (cur0 && (cur0 === searchVal || cur0.includes(searchVal))) { el.classList.add('ot-filled'); return true; }

  // Try up to twice: open → find option → select → VERIFY the committed value.
  // Verification is the safety net — we never leave a wrong value (e.g. answering
  // "authorized to work?" with "No" because a click drifted to the adjacent option).
  for (let attempt = 1; attempt <= 2; attempt++) {
    let opened = await nativeClick(control);
    await sleep(450);
    let matched = findDropdownOption(searchVal, value);
    let didType = false;

    // Type to filter if needed (long lists / async autocompletes), then look again.
    // Use real keystrokes (autocompletes like SmartRecruiters' city lookup only
    // search on keydown/keyup), and poll for a few seconds since results are
    // fetched asynchronously. Never type the decline sentinel, and don't type a
    // money value into a salary-range list (it would filter out every bracket —
    // findDropdownOption's numeric matcher needs the full list visible).
    const isMoney = MONEY_RE.test(String(value).trim());
    if (!matched && !isDecline && !isMoney && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      didType = true;
      await typeWithKeys(el, value);
      for (let i = 0; i < 14 && !matched; i++) { await sleep(300); matched = findDropdownOption(searchVal, value); }
    }
    // Synthetic open fallback (non-react custom dropdowns)
    if (!matched && !opened) {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.click();
      await sleep(350);
      matched = findDropdownOption(searchVal, value);
    }
    if (!matched) { await sleep(150); continue; }

    const wantText = (matched.textContent || '').trim().toLowerCase();
    // Whether an option menu is still open anywhere (a real selection closes it).
    const menuOpen = () => deepQueryAll('spl-select-option, [role="option"], [role="listbox"] li, .select__option, [class*="__option"]').some(isVisible);
    // VERIFY helper: a commit means the value matches AND the menu has closed —
    // otherwise typed-but-unselected text (autocompletes) reads as a false success.
    const committed = () => {
      const cur = readCur();
      const valOk = isDecline
        ? DECLINE_RE.test(cur)
        : cur && (cur === searchVal || cur.includes(searchVal) ||
                  (wantText && (cur === wantText || cur.includes(wantText) || wantText.includes(cur))));
      return valOk && !menuOpen();
    };

    // Keyboard selection for keyboard-nav widgets (SmartRecruiters
    // spl-keyboard-list-navigator) where a synthetic click doesn't commit. Settle
    // first so any late auto-highlight has landed, then arrow `downs` times and
    // Enter. committed() guards against landing on the wrong value.
    const pickByArrows = async (downs) => {
      await sleep(420);
      for (let k = 0; k < downs; k++) { pressKey(el, 'ArrowDown', 40); await sleep(150); }
      pressKey(el, 'Enter', 13);
      await sleep(550);
      return committed();
    };

    // Autocomplete (we typed a query): results are ranked, so the TOP one is the
    // best match for the typed value — one ArrowDown lands on it. Counting to a
    // specific index races the widget's own highlight, so don't. Runs BEFORE any
    // click (a stray click pre-highlights an option and offsets the arrow count).
    if (didType) {
      if (await pickByArrows(1)) { el.classList.add('ot-filled'); return true; }
    }

    // Click the option (works for react-select, Lever, native-ish menus).
    await nativeClick(matched);
    await sleep(300);
    if (committed()) { el.classList.add('ot-filled'); return true; }

    // Click didn't commit (keyboard-nav typeable combobox, e.g. SmartRecruiters):
    // filter to the option by typing its exact text, then ArrowDown+Enter takes the
    // now-top match. Robust — no index counting that races the widget's highlight.
    if (!didType && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && wantText) {
      const optText = (matched.textContent || '').trim();
      await typeWithKeys(el, optText);
      for (let i = 0; i < 12; i++) { await sleep(250); if (findDropdownOption(wantText, optText)) break; }
      if (await pickByArrows(1)) { el.classList.add('ot-filled'); return true; }
    }

    // Wrong/blank — close any open menu and retry once.
    await nativeClick(control).catch(() => {});
    await sleep(150);
  }
  return false; // never leaves a wrong selection
}

// Money parsing for salary-range dropdowns. Bare small numbers are treated as
// thousands ("150" → 150000); a k/m suffix anywhere in a range applies to both ends.
const MONEY_RE = /^\$?\s*[\d][\d,.\s]*[kKmM]?\+?$/;
function moneyToNum(numStr, suffix) {
  let n = parseFloat(String(numStr).replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return null;
  const s = (suffix || '').toLowerCase();
  if (s === 'k') n *= 1e3; else if (s === 'm') n *= 1e6; else if (n < 1000) n *= 1e3;
  return n;
}
function parseMoney(str) {
  const m = String(str).match(/([\d][\d,.]*)\s*([kKmM])?/);
  return m ? moneyToNum(m[1], m[2]) : null;
}
function parseMoneyRange(str) {
  const nums = [...String(str).matchAll(/([\d][\d,.]*)\s*([kKmM])?/g)];
  if (nums.length < 2) return null;
  const suffix = (String(str).match(/[kKmM]/) || [])[0];
  const lo = moneyToNum(nums[0][1], nums[0][2] || suffix);
  const hi = moneyToNum(nums[1][1], nums[1][2] || suffix);
  if (lo == null || hi == null) return null;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

function findDropdownOption(searchVal, rawValue) {
  // All common option selectors across ATS platforms
  const OPTION_SELECTORS = [
    '[role="option"]',
    '[role="listbox"] li',
    '[role="listbox"] [role="option"]',
    '.select__option',
    '.Select__option',
    '[class*="option--"]',
    '[class*="__option"]',
    '[class*="dropdown-item"]',
    '[class*="menu-item"]',
    '[class*="list-item"]',
    'li[class*="select"]',
    'li[class*="result"]',
    'spl-select-option',                 // SmartRecruiters web-component options
    '[class*="select-option"]',
    '[class*="autocomplete-option"]',
    '[data-sr-id*="option"]',
  ];

  const lower = (searchVal || '').toLowerCase();
  const tgt   = String(rawValue != null ? rawValue : searchVal).toLowerCase();
  const isYes = /^(yes|true|1)$/.test(tgt);
  const isNo  = /^(no|false|0)$/.test(tgt);
  const esc   = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Gather all *visible* options across every selector once, deduped.
  // (Phone-number country pickers etc. inject hundreds of hidden [role=option]
  //  lis — the offsetParent filter drops those so they can't cause false hits.)
  const seen = new Set();
  const opts = [];
  for (const selector of OPTION_SELECTORS) {
    deepQueryAll(selector).forEach(o => {
      if (!isVisible(o) || seen.has(o)) return;
      seen.add(o);
      const t = (o.textContent || '').trim();
      if (t) opts.push({ o, l: t.toLowerCase() });
    });
  }
  if (!opts.length) return null;

  // Demographic decline sentinel — match the "prefer not / decline" option only.
  if (rawValue === DECLINE_TOKEN) {
    const d = opts.find(x => DECLINE_RE.test(x.l));
    return d ? d.o : null;
  }

  const placeholder = l => /^select|^choose|^--|^please|no options|no results/.test(l);

  // Bot's pickBest ladder: exact → starts-with → yes/no semantic → contains
  let m = opts.find(x => x.l === lower);                                   if (m) return m.o;
  m = opts.find(x => new RegExp('^' + esc(lower)).test(x.l));              if (m) return m.o;
  if (isYes) { m = opts.find(x => /\byes\b|^i am\b|^authorized\b|^eligible\b/.test(x.l) && !/\bno\b/.test(x.l)); if (m) return m.o; }
  if (isNo)  { m = opts.find(x => /\bno\b|^i do not\b|^i am not\b|^not\b|^does not/.test(x.l)            && !/\byes\b/.test(x.l)); if (m) return m.o; }
  m = opts.find(x => !placeholder(x.l) && lower && x.l.includes(lower));   if (m) return m.o;

  // Salary / numeric-range fallback: a money value (e.g. expected salary) → the
  // bracket option that contains it ("$150-$174K"). Gated to money-shaped values
  // so it never fires on codes like "H1B".
  if (MONEY_RE.test(String(rawValue != null ? rawValue : searchVal).trim())) {
    const want = parseMoney(tgt);
    if (want != null) {
      for (const x of opts) {
        if (placeholder(x.l)) continue;
        const rng = parseMoneyRange(x.l);
        if (rng && want >= rng.lo && want <= rng.hi) return x.o;
      }
      // open-ended top bracket ("$250K+")
      const open = opts.map(x => ({ x, mm: x.l.match(/([\d.,]+)\s*([km]?)\s*\+/i) })).find(o => o.mm);
      if (open && want >= moneyToNum(open.mm[1], open.mm[2])) return open.x.o;
    }
  }
  return null;
}

// Trigger React's internal synthetic event system so React-controlled
// inputs/selects recognise the programmatic value change.
function triggerReactSetter(el, prop, value) {
  try {
    const proto = el.tagName === 'SELECT'
      ? HTMLSelectElement.prototype
      : (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (descriptor?.set) descriptor.set.call(el, value);
  } catch { /* non-React page, ignore */ }
}

async function fillRadio(field, value) {
  const v = String(value).toLowerCase();
  const opt = o => (o.text || '').toLowerCase();
  const target =
    field.options.find(o => o.value.toLowerCase() === v || opt(o) === v) ||
    field.options.find(o => opt(o).includes(v) || (o.value && o.value.toLowerCase().includes(v)));
  if (!target) return false;

  if (target.el.tagName === 'INPUT') {
    target.el.checked = true;
    target.el.dispatchEvent(new Event('change', { bubbles: true }));
    target.el.dispatchEvent(new Event('click',  { bubbles: true }));
  } else {
    // Custom role="radio" web component (SmartRecruiters spl-radio) — select by click.
    await nativeClick(target.el);
  }
  target.el.classList && target.el.classList.add('ot-filled');
  return true;
}

function fillCheckbox(el, value) {
  const shouldCheck = /true|yes|1/i.test(String(value));
  if (el.checked !== shouldCheck) {
    el.checked = shouldCheck;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

// Attach the resume via DataTransfer + change event. React file inputs read
// input.files on change, so this registers (verified on Greenhouse) — no disk
// path or debugger needed, and it works inside cross-origin iframes too.
async function attachResume(el, { resumeFile }) {
  if (!resumeFile?.base64) return false;
  // Set the file via DataTransfer + change event (synthetic). React file inputs
  // read input.files on change, so this registers — verified on Greenhouse.
  const ok = await fillFileInput(el, resumeFile.base64, resumeFile.name);
  await sleep(700);
  // Success = the form accepted it: the input still has a file, or it re-rendered
  // away (detached from the DOM). Works for shadow-DOM inputs (we hold el directly).
  const stillThere = el.isConnected ? el : null;
  return ok && (!stillThere || (el.files && el.files.length > 0));
}

async function fillFileInput(el, base64, fileName) {
  try {
    // base64 may be a data URL ("data:mime;base64,xxx") or raw base64
    let mimeType = 'application/octet-stream';
    let rawB64   = base64;
    if (base64.includes(',')) {
      const [meta, data] = base64.split(',');
      rawB64   = data;
      const m  = meta.match(/:(.*?);/);
      if (m) mimeType = m[1];
    }
    const binary = atob(rawB64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], fileName || 'resume.pdf', { type: mimeType });
    const dt   = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.classList.add('ot-filled');
    return el.files.length > 0; // verify it actually stuck
  } catch { return false; }
}

function clickAttachButton(fileEl) {
  // Walk up from the hidden file input to find the Attach/Upload button
  let node = fileEl.parentElement;
  for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
    const btn = Array.from(node.querySelectorAll('button, a, [role="button"]'))
      .find(el => el.offsetParent && /\b(attach|upload|choose|browse|select file)\b/i.test(el.textContent.trim()));
    if (btn) {
      btn.style.outline = '3px solid #7c4dff';
      btn.style.outlineOffset = '3px';
      btn.title = '📎 Click here to attach your resume';
      showToast('📎 Click the highlighted "Attach" button to upload your resume.', 'info');
      return true;
    }
  }
  return false;
}

function highlightFileInput(el) {
  el.style.outline = '3px solid #7c4dff';
  el.style.borderRadius = '4px';
  const parent = el.closest('.file-upload-area, .field, .form-group') || el.parentElement;
  if (parent) {
    parent.title = '📎 Please select your resume file here';
    parent.style.boxShadow = '0 0 0 3px #7c4dff44';
  }
  showToast('📎 Please select your resume file manually — browsers block automatic file upload.', 'info');
}

// ── VALIDATION ────────────────────────────────────────────────────────────────
function requiresValidation(field) {
  return field.type === 'radio' || field.type === 'select' || field.type === 'combobox';
}

// A react-select commits its chosen value to a sibling `.select__single-value`
// element — the <input> itself is left EMPTY. Reading el.value therefore reports
// a filled dropdown as empty, which made the retry loop re-touch every dropdown
// ("revisited") and never see the form as complete. Read the committed display.
function comboCommittedValue(field) {
  const el = field.el;
  if (!el) return '';
  const control = closestDeep(el, '[class*="select__control"], [class*="-control"], [class*="combo"]');
  const sv = control && control.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multiValue"]');
  const shown = (sv && sv.textContent.trim()) || (el.value || '').trim();
  // Ignore placeholder text
  return /^(select\.\.\.|select|choose|--)/i.test(shown) ? '' : shown;
}

function validateSelectableField(field) {
  if (field.type === 'radio') {
    // Custom role="radio" groups (spl-radio): check the options' state directly.
    if (field.options && field.options.length) {
      return field.options.some(o => o.el && (o.el.tagName === 'INPUT'
        ? o.el.checked
        : o.el.getAttribute('aria-checked') === 'true'));
    }
    const root = field.el?.getRootNode?.();
    const scope = root && root.querySelector ? root : document;
    return !!scope.querySelector(`input[type="radio"][name="${CSS.escape(field.name)}"]:checked`);
  }
  if (field.type === 'select') {
    return field.el.value !== '' && field.el.selectedIndex > 0;
  }
  if (field.type === 'combobox') {
    return comboCommittedValue(field).length > 0 && field.el?.getAttribute('aria-invalid') !== 'true';
  }
  return true;
}

function isFieldFilled(field) {
  if (field.type === 'radio')    return validateSelectableField(field);
  if (field.type === 'select')   return validateSelectableField(field);
  if (field.type === 'combobox') return comboCommittedValue(field).length > 0;
  if (field.type === 'checkbox') return true;
  if (field.type === 'file')     return true;
  return (field.el?.value || '').trim().length > 0;
}

// ── CLAUDE FALLBACK ───────────────────────────────────────────────────────────
async function askClaude(fields, resumeContext, apiKey) {
  const fieldDescriptions = fields.map(f => {
    const base = { label: f.label || f.name, type: f.type };
    if (f.options?.length) base.options = f.options.map(o => o.text || o.value);
    return base;
  });

  const prompt = `You are filling out a job application form on behalf of the applicant.

APPLICANT PROFILE:
${resumeContext}

Fill the following form fields. For each field, return the best answer based on the applicant's profile.
- For radio/select fields, return EXACTLY one of the listed option values/texts.
- For text/textarea fields, give a concise, professional answer (1–3 sentences for short answer, full paragraph for essays).
- For checkboxes asking consent (background check, terms), return "yes".
- For EEO voluntary fields, return "prefer_not" unless you have clear data.

FIELDS TO FILL (JSON array):
${JSON.stringify(fieldDescriptions, null, 2)}

Respond ONLY with a valid JSON array matching the same order as input:
[{"label": "...", "answer": "..."}]`;

  // Route through background service worker to handle CORS
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'CLAUDE_COMPLETE', prompt, apiKey },
      response => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response) return reject(new Error('No response from background — try reloading the extension'));
        if (response.error) return reject(new Error(response.error));

        try {
          let raw = response.text.trim();
          // Strip markdown code fences if present
          raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
          const answers = JSON.parse(raw);
          // Zip answers back to fields
          const result = fields.map((field, i) => ({
            field,
            answer: answers[i]?.answer || null,
          }));
          resolve(result);
        } catch (e) {
          reject(new Error('Claude returned invalid JSON: ' + e.message));
        }
      }
    );
  });
}

function buildResumeSummary(r) {
  const lines = [];
  if (r.firstName || r.lastName) lines.push(`Name: ${r.firstName || ''} ${r.lastName || ''}`.trim());
  if (r.email)     lines.push(`Email: ${r.email}`);
  if (r.phone)     lines.push(`Phone: ${r.phone}`);
  if (r.city)      lines.push(`Location: ${r.city}${r.zip ? ', ' + r.zip : ''}${r.country ? ', ' + r.country : ''}`);
  if (r.title)     lines.push(`Current Title: ${r.title}`);
  if (r.yearsExp)  lines.push(`Years of Experience: ${r.yearsExp}`);
  if (r.workAuth)  lines.push(`Work Authorization: ${r.workAuth}`);
  if (r.requiresSponsorship !== undefined) lines.push(`Requires Sponsorship: ${r.requiresSponsorship}`);
  if (r.linkedin)  lines.push(`LinkedIn: ${r.linkedin}`);
  if (r.github)    lines.push(`GitHub: ${r.github}`);
  if (r.website)   lines.push(`Portfolio: ${r.website}`);
  if (r.salary)    lines.push(`Expected Salary: ${r.salary}`);
  if (r.degree)    lines.push(`Highest Degree: ${r.degree}`);
  if (r.school)    lines.push(`School: ${r.school}`);
  if (r.coverLetter) lines.push(`\nCover Letter / Bio:\n${r.coverLetter}`);
  return lines.join('\n');
}

// ── PAGE DATA SCRAPING (for popup "Add from page" button) ─────────────────────
function scrapePageData() {
  const domain = location.hostname.replace('www.', '');
  const host   = location.hostname;

  if (host.includes('linkedin.com')) return scrapeLinkedIn(domain);
  return { domain, company: document.title, name: '', email: '' };
}

function scrapeLinkedIn(domain) {
  const data = { domain, company: '', name: '', email: '' };
  const nameEl = document.querySelector('h1.text-heading-xlarge, .pv-text-details__left-panel h1');
  if (nameEl) data.name = nameEl.textContent.trim();
  const compEl = document.querySelector('.pv-text-details__right-panel .hoverable-link-text');
  if (compEl) data.company = compEl.textContent.trim();
  const orgEl  = document.querySelector('.org-top-card-summary__title');
  if (orgEl && !data.company) data.company = orgEl.textContent.trim();
  return data;
}

// ── MESSAGE LISTENER ──────────────────────────────────────────────────────────
// ── UTILITIES ─────────────────────────────────────────────────────────────────
async function getStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get({
      resumeData:     {},
      claudeApiKey:   '',
      claudeEnabled:  true,
      resumeFile:     null,
      resumeFilePath: '',
      resumeText:     '',
      learnedAnswers: {},
    }, resolve);
  });
}

// Open a combobox (trusted click) just long enough to read its options, then close.
// react-select renders options only while open, so this is how we capture the real
// choices for the "needs answers" section.
async function harvestComboOptions(field) {
  try {
    const el = field.el; if (!el) return [];
    const control = closestDeep(el, '[class*="select__control"], [class*="-control"]') ||
                    (el.getAttribute('role') === 'combobox' ? el : null) ||
                    (el.tagName === 'BUTTON' ? el : null) || el;
    await nativeClick(control);
    await sleep(450);
    const opts = deepQueryAll('[role="option"], .select__option, [class*="__option"]')
      .filter(isVisible)
      .map(o => o.textContent.trim())
      .filter(t => t && !/^select|^choose|^--|no options|no results/i.test(t));
    await nativeClick(control); // toggle closed so it doesn't block the next field
    await sleep(120);
    return [...new Set(opts)];
  } catch { return []; }
}

async function saveLearnedFields(fields) {
  // Gather options up front so the "needs answers" section shows real dropdown
  // choices — comboboxes only expose their options while open.
  const prepared = [];
  for (const f of fields) {
    let options = (f.options || []).map(o => o.text || o.value || o);
    if (f.type === 'combobox' && !options.length) options = await harvestComboOptions(f);
    prepared.push({ key: (f.label || f.name || '').trim(), type: f.type || 'text', options });
  }
  return new Promise(resolve => {
    chrome.storage.local.get({ learnedAnswers: {} }, d => {
      const updated = { ...d.learnedAnswers };
      prepared.forEach(({ key, type, options }) => {
        if (!key) return;
        const existing = updated[key];
        const alreadyAnswered = existing && (typeof existing === 'string' ? existing : existing.answer);
        if (!alreadyAnswered) {
          updated[key] = { answer: '', type, options };
        } else if (existing && typeof existing === 'object' && options.length && !(existing.options || []).length) {
          existing.options = options; // backfill options onto a previously-saved entry
        }
      });
      chrome.storage.local.set({ learnedAnswers: updated }, resolve);
    });
  });
}

function showToast(msg, type = 'info') {
  const old = document.getElementById('ot-toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.id = 'ot-toast';
  toast.className = `ot-toast ot-toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('ot-toast-show'));
  setTimeout(() => {
    toast.classList.remove('ot-toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── INIT ──────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})(); // end IIFE guard
