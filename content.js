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

function pageHasFillableInputs() {
  return Array.from(document.querySelectorAll(FILLABLE))
    .some(el => el.offsetParent !== null && !el.disabled);
}

function tryInjectOverlay() {
  if (_overlayBtn) return;
  if (!pageHasFillableInputs()) return;
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

  // HTML required attribute (works for text, select, checkbox, etc.)
  if (el.required) return true;

  // ARIA
  if (el.getAttribute('aria-required') === 'true') return true;

  // For radio groups: check if any radio in the group has required
  if (field.type === 'radio' && field.options) {
    if (field.options.some(o => o.el?.required)) return true;
  }

  // Label contains an asterisk or the word "required" — visual indicator
  const labelText = field.label || '';
  if (/\*|✱|\brequired\b/i.test(labelText)) return true;

  // Wrapper element has a required indicator (common in custom form libraries)
  const wrap = el.closest('[data-required="true"], [required], .required, .is-required, [class*="required"]');
  if (wrap && wrap !== el) return true;

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
  // Check native <form> tags first
  const inForm = Array.from(document.querySelectorAll('form')).some(f => {
    return f.offsetParent !== null &&
      f.querySelectorAll(FILLABLE).length > 0;
  });
  if (inForm) return true;
  // Fallback: any visible fillable inputs anywhere on page (ADP, custom portals)
  return pageHasFillableInputs();
}

async function clickApplyButton() {
  const RE = /\b(apply|apply now|apply for this job|quick apply|start application)\b/i;
  const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
    .filter(el => el.offsetParent && RE.test(el.textContent.trim() || el.value || ''));
  if (!candidates.length) return false;
  candidates[0].click();
  await sleep(2000);
  return true;
}

async function clickSubmitButton() {
  const RE = /\b(submit|submit application|send application|next|continue|save and continue|apply now)\b/i;

  // Strategy 1: native type="submit"
  const natives = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'))
    .filter(el => el.offsetParent && !el.disabled);
  if (natives.length) {
    natives[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(300);
    natives[0].click();
    return true;
  }

  // Strategy 2: text-matching button, prefer lowest on page (closest to submit)
  const byText = Array.from(document.querySelectorAll('button, [role="button"], a[type="submit"]'))
    .filter(el => el.offsetParent && !el.disabled && RE.test((el.textContent || el.value || '').trim()))
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  if (byText.length) {
    byText[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(300);
    byText[0].click();
    return true;
  }

  // Strategy 3: last button inside a <form>
  const formBtns = Array.from(document.querySelectorAll('form button:not([type="reset"]):not([type="button"])'))
    .filter(el => el.offsetParent && !el.disabled);
  if (formBtns.length) {
    const last = formBtns[formBtns.length - 1];
    last.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(300);
    last.click();
    return true;
  }

  return false;
}

async function captureValidationErrors() {
  await sleep(1200); // wait for error states to render

  const errorFields = [];
  const seen = new Set();

  // aria-invalid on inputs
  document.querySelectorAll('[aria-invalid="true"], [aria-invalid="error"]').forEach(el => {
    if (seen.has(el) || !el.offsetParent) return;
    seen.add(el);
    const label = getLabel(el) || el.name || el.id;
    if (label) errorFields.push({ el, type: getFieldType(el), label, name: el.name || el.id });
  });

  // Inputs inside wrappers with error class names
  document.querySelectorAll([
    '.field--error input, .field--error select, .field--error textarea',
    '.has-error input, .has-error select',
    '[class*="error"] input, [class*="error"] select',
    '[class*="invalid"] input',
  ].join(',')).forEach(el => {
    if (seen.has(el) || !el.offsetParent) return;
    seen.add(el);
    const label = getLabel(el) || el.name || el.id;
    if (label) errorFields.push({ el, type: getFieldType(el), label, name: el.name || el.id });
  });

  // Required fields that are still empty
  document.querySelectorAll('input[required], select[required], textarea[required]').forEach(el => {
    if (seen.has(el) || !el.offsetParent) return;
    const empty = el.tagName === 'SELECT' ? el.value === '' || el.selectedIndex <= 0 : !el.value.trim();
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
  setOverlayState('loading');

  const { resumeData, claudeApiKey, claudeEnabled, resumeFile, resumeText, learnedAnswers } = await getStorage();
  if (!resumeData || !Object.keys(resumeData).length) {
    showToast('⚠️ No profile data. Open extension → Settings and fill in your profile first.', 'warn');
    setOverlayState('idle');
    return;
  }

  // Step 0: deduplication — warn if already applied to this job
  if (await isAlreadyApplied()) {
    const proceed = confirm('⚠️ You have already applied to this job.\n\nClick OK to apply again, or Cancel to skip.');
    if (!proceed) { setOverlayState('idle'); return; }
  }

  // Step 0b: if no form is visible, try clicking an Apply button first
  if (!hasVisibleForm()) {
    showToast('🔍 No form visible — looking for Apply button...', 'info');
    const clicked = await clickApplyButton();
    if (!clicked) {
      showToast('⚠️ No form or Apply button found on this page.', 'warn');
      setOverlayState('idle');
      return;
    }
    showToast('✅ Clicked Apply — form loading...', 'info');
    await sleep(500);
  }

  const fields   = scanAllFields();
  const unmapped = [];
  let   filled   = 0;

  // Pre-pass: auto-check mandatory consent/agreement checkboxes only
  const CONSENT_RE = /\b(agree|consent|certif|acknowledg|confirm|accept|authorize|authoris|attest|declare|understand|warrant)\b|terms|privacy.?polic|background.?check/i;
  for (const field of fields) {
    if (field.type !== 'checkbox') continue;
    if (!isRequiredField(field)) continue; // mandatory only
    // Check label AND full surrounding text (label may not be extracted for nested checkboxes)
    const surrounding = field.el?.closest('label, .field, .form-group, li')?.innerText || '';
    const text = (field.label || '') + ' ' + surrounding;
    if (!CONSENT_RE.test(text)) continue;
    fillCheckbox(field.el, 'yes');
    filled++;
  }

  // Pass 1: fill from resume profile data
  for (const field of fields) {
    if (field.type === 'checkbox') continue; // already handled above
    // File inputs — whitelist: only fill inputs explicitly labeled resume/CV.
    // Everything else (cover letter, portfolio, other docs) is left untouched.
    if (field.type === 'file') {
      const lbl = (field.label || '').toLowerCase();
      const isResumeInput = /\b(resume|cv|curriculum.?vitae)\b/i.test(lbl) || lbl === '';
      const isCoverLetter = /cover.?letter/i.test(lbl);
      if (isResumeInput && !isCoverLetter && resumeFile?.base64) {
        const ok = await fillFileInput(field.el, resumeFile.base64, resumeFile.name);
        if (ok) filled++;
        else highlightFileInput(field.el);
      } else if (isResumeInput && !isCoverLetter) {
        highlightFileInput(field.el);
      }
      // All other file inputs intentionally skipped
      continue;
    }

    const value = mapFromResume(field, resumeData);
    if (value !== null && value !== undefined && value !== '') {
      const ok = await fillField(field, value);
      if (ok) {
        filled++;
        if (requiresValidation(field) && !validateSelectableField(field)) unmapped.push(field);
      } else {
        unmapped.push(field);
      }
    } else {
      // Only queue optional fields for further passes if user has explicit answer
      if (isRequiredField(field)) unmapped.push(field);
    }
    await sleep(30);
  }

  // Pass 2: check learned answers (user-supplied answers from previous runs)
  const stillUnmapped = [];
  for (const field of unmapped) {
    const key   = (field.label || field.name || '').trim();
    const entry = learnedAnswers[key];
    const answer = entry && (typeof entry === 'string' ? entry : entry.answer);
    if (answer) {
      const ok = await fillField(field, answer);
      if (ok) {
        filled++;
        if (requiresValidation(field)) validateSelectableField(field);
      } else {
        if (isRequiredField(field)) stillUnmapped.push(field);
      }
    } else {
      if (isRequiredField(field)) stillUnmapped.push(field);
    }
    await sleep(30);
  }

  // Pass 3: Claude only for REQUIRED fields still unmapped
  const claudeFields = stillUnmapped.filter(f =>
    f.type !== 'file' && f.type !== 'checkbox' && isRequiredField(f)
  );
  if (claudeFields.length && claudeEnabled && claudeApiKey) {
    setOverlayState('claude');
    try {
      const resumeContext = resumeText || buildResumeSummary(resumeData);
      const answers = await askClaude(claudeFields, resumeContext, claudeApiKey);
      const truelyUnfilled = [];
      for (const { field, answer } of answers) {
        if (answer) {
          const ok = await fillField(field, answer);
          if (ok) {
            filled++;
            if (requiresValidation(field)) validateSelectableField(field);
          } else {
            truelyUnfilled.push(field);
          }
        } else {
          truelyUnfilled.push(field);
        }
        await sleep(30);
      }
      // Save any fields Claude couldn't answer for user to fill in Settings
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

  // Step 4: click Submit and capture any validation errors
  setOverlayState('loading');
  showToast(`✅ Filled ${filled} fields — submitting...`, 'info');

  const submitted = await clickSubmitButton();
  if (submitted) {
    const errorFields = await captureValidationErrors();
    if (errorFields.length) {
      highlightFailedFields(errorFields);
      await saveLearnedFields(errorFields);
      await logApplication('failed');
      setOverlayState('error');
      showToast(`⚠️ ${errorFields.length} field${errorFields.length !== 1 ? 's' : ''} failed — highlighted in red. Saved to Needs Answers.`, 'warn');
    } else {
      await logApplication('applied');
      setOverlayState('done');
      showToast(`✅ Submitted! ${filled} fields filled. Logged to Applications.`, 'success');
    }
  } else {
    const leftover = scanAllFields().filter(f => !isFieldFilled(f) && f.type !== 'file');
    const status = leftover.length === 0 ? 'applied' : 'failed';
    await logApplication(status);
    setOverlayState(leftover.length === 0 ? 'done' : 'error');
    showToast(`✅ Filled ${filled} field${filled !== 1 ? 's' : ''}${leftover.length ? ` · ${leftover.length} need review` : ''}. Logged to Applications.`, 'success');
  }
}

// ── FIELD SCANNER ─────────────────────────────────────────────────────────────
function scanAllFields() {
  const fields = [];
  const seen   = new Set();

  document.querySelectorAll('input, select, textarea').forEach(el => {
    if (!el.offsetParent && el.type !== 'hidden') return; // invisible
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
      const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`));
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

    fields.push({ el, type, name: el.name || el.id, label: getLabel(el) });
  });

  // ── Custom / ARIA comboboxes (non-native selects) ─────────────────────────
  // Covers Greenhouse, Lever, Workday, React-Select, and any role="combobox"
  const comboSelectors = [
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '[aria-haspopup="true"]',
  ];
  document.querySelectorAll(comboSelectors.join(',')).forEach(el => {
    if (seen.has(el)) return;
    if (!el.offsetParent) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    seen.add(el);
    fields.push({
      el,
      type:  'combobox',
      name:  el.name || el.id || el.getAttribute('aria-label') || '',
      label: getLabel(el),
    });
  });

  return fields;
}

function getFieldType(el) {
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'TEXTAREA') return 'textarea';
  return (el.type || 'text').toLowerCase();
}

// ── LABEL EXTRACTION ──────────────────────────────────────────────────────────
function cleanLabelText(text) {
  return (text || '').replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
}

function getLabel(el) {
  // 1. Explicit <label for="id">
  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit) return cleanLabelText(explicit.innerText);
  }

  // 2. aria-label / aria-labelledby
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const ariaBy = el.getAttribute('aria-labelledby');
  if (ariaBy) {
    const ref = document.getElementById(ariaBy);
    if (ref) return cleanLabelText(ref.innerText);
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

  // 4. Fall back to name/id (never use placeholder — it's example data, not a label)
  return el.name || el.id || '';
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
  { re: /city|town/i,                               key: 'city' },
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
  { re: /salary|compensation|pay/i,                 key: 'salary' },
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
    re: /sponsor|sponsorship/i,
    key: 'requiresSponsorship',
    valueMap: { 'true': ['yes', 'true', '1'], 'false': ['no', 'false', '0'] },
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

  if (field.type === 'select' || field.type === 'radio') {
    return mapSelectableFromResume(field, r, ctx) || exactLabelLookup(field.label, r);
  }

  if (field.type === 'checkbox') return null;

  // Text fields — regex pattern matching first
  for (const { re, key, fn } of RESUME_MAP) {
    if (re.test(ctx)) {
      return fn ? fn(r) : (r[key] || null);
    }
  }

  // Exact label match — catches any previously answered field stored by label key
  return exactLabelLookup(field.label, r);
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

    const rawValue = mapping.key ? r[mapping.key] : mapping.value;
    if (!rawValue) continue;

    const options = field.type === 'radio'
      ? field.options.map(o => ({ value: o.value, text: o.text }))
      : (field.options || []);

    // Try to match rawValue against available options
    for (const [canonical, patterns] of Object.entries(mapping.valueMap || {})) {
      const isMatch = patterns.some(p => new RegExp(p, 'i').test(rawValue));
      if (!isMatch) continue;

      // Find the actual option with that value/text
      const match = options.find(o =>
        patterns.some(p => new RegExp(p, 'i').test(o.value) || new RegExp(p, 'i').test(o.text))
      );
      if (match) return match.value;
    }

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
  triggerReactSetter(el, 'value', value);
  el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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

// ── CUSTOM COMBOBOX FILLER ────────────────────────────────────────────────────
async function fillCombobox(field, value) {
  const el = field.el;

  // Normalise country values before trying to match
  const isCountry = /country|nation/i.test(field.label + field.name);
  const searchVal = isCountry ? normaliseCountry(value) : value.toLowerCase();

  // Step 1: open the dropdown
  el.focus();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.click();
  await sleep(200);

  // Step 2: type to filter options
  triggerReactSetter(el, 'value', value);
  el.value = value;
  el.dispatchEvent(new Event('input',   { bubbles: true }));
  el.dispatchEvent(new Event('change',  { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: value[0], bubbles: true }));
  await sleep(400); // wait for options to render

  // Step 3: find matching option in any visible listbox
  let matched = findDropdownOption(searchVal);

  // Step 4: if no match yet, try clearing and retyping just first word
  if (!matched) {
    const firstWord = value.split(/\s+/)[0];
    triggerReactSetter(el, 'value', firstWord);
    el.value = firstWord;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(350);
    matched = findDropdownOption(searchVal);
  }

  if (!matched) return false;

  // Step 5: click the matched option
  matched.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  matched.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
  matched.click();
  await sleep(150);

  el.classList.add('ot-filled');
  return true;
}

function findDropdownOption(searchVal) {
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
  ];

  const lower = searchVal.toLowerCase();

  for (const selector of OPTION_SELECTORS) {
    const options = Array.from(document.querySelectorAll(selector))
      .filter(o => o.offsetParent !== null); // visible only
    if (!options.length) continue;

    // Exact text match first
    const exact = options.find(o => o.textContent.trim().toLowerCase() === lower);
    if (exact) return exact;

    // Contains match
    const contains = options.find(o => o.textContent.trim().toLowerCase().includes(lower));
    if (contains) return contains;
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

function fillRadio(field, value) {
  const target = field.options.find(o =>
    o.value === value ||
    o.value.toLowerCase().includes(value.toLowerCase()) ||
    o.text.toLowerCase().includes(value.toLowerCase())
  );
  if (!target) return false;

  target.el.checked = true;
  target.el.dispatchEvent(new Event('change', { bubbles: true }));
  target.el.dispatchEvent(new Event('click',  { bubbles: true }));
  target.el.classList.add('ot-filled');
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

function validateSelectableField(field) {
  if (field.type === 'radio') {
    return !!document.querySelector(`input[type="radio"][name="${field.name}"]:checked`);
  }
  if (field.type === 'select') {
    return field.el.value !== '' && field.el.selectedIndex > 0;
  }
  if (field.type === 'combobox') {
    const val = (field.el?.value || '').trim();
    // Consider filled if the input has a value and no error indicators nearby
    return val.length > 0 && !field.el?.getAttribute('aria-invalid');
  }
  return true;
}

function isFieldFilled(field) {
  if (field.type === 'radio')    return validateSelectableField(field);
  if (field.type === 'select')   return validateSelectableField(field);
  if (field.type === 'combobox') return (field.el?.value || '').trim().length > 0;
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
      resumeText:     '',
      learnedAnswers: {},
    }, resolve);
  });
}

async function saveLearnedFields(fields) {
  return new Promise(resolve => {
    chrome.storage.local.get({ learnedAnswers: {} }, d => {
      const updated = { ...d.learnedAnswers };
      fields.forEach(f => {
        const key = (f.label || f.name || '').trim();
        if (!key) return;
        // Only add if not already answered
        const existing = updated[key];
        const alreadyAnswered = existing && (typeof existing === 'string' ? existing : existing.answer);
        if (!alreadyAnswered) {
          updated[key] = {
            answer:  '',
            type:    f.type || 'text',
            options: (f.options || []).map(o => o.text || o.value || o),
          };
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
