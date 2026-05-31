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

function tryInjectOverlay() {
  if (_overlayBtn) return;
  const forms = document.querySelectorAll('form');
  if (!forms.length) return;
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
// Optional/voluntary fields are never auto-filled unless the user has explicitly
// set a value for them. Prevents EEO, diversity, and voluntary fields from being
// touched by guessing or Claude.
const OPTIONAL_LABEL_RE = /voluntary|optional|\(optional\)|prefer.?not|gender|pronouns|race|ethnicity|disability|veteran|eeo|equal.?opportun|diversity/i;

function isRequiredField(field) {
  const el = field.el;
  if (!el) return true; // assume required if we can't check
  if (el.required || el.getAttribute('aria-required') === 'true') return true;
  // Check if the label contains a required indicator (*, ✱, "required")
  const label = (field.label || '').toLowerCase();
  if (/\*|required/.test(label)) return true;
  // Explicitly optional/voluntary → not required
  if (OPTIONAL_LABEL_RE.test(label)) return false;
  // No explicit required marker → treat as required (most form fields are)
  return true;
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

  const fields   = scanAllFields();
  const unmapped = [];
  let   filled   = 0;

  // Pass 1: fill from resume profile data
  for (const field of fields) {
    // File inputs — try stored resume, else highlight
    if (field.type === 'file') {
      if (resumeFile?.base64) {
        const ok = await fillFileInput(field.el, resumeFile.base64, resumeFile.name);
        if (ok) filled++;
        else highlightFileInput(field.el);
      } else {
        highlightFileInput(field.el);
      }
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

  const leftover = scanAllFields().filter(f => !isFieldFilled(f) && f.type !== 'file');
  setOverlayState(leftover.length === 0 ? 'done' : 'error');
  showToast(`✅ Filled ${filled} field${filled !== 1 ? 's' : ''}${leftover.length ? ` · ${leftover.length} saved to Settings` : ''}`, 'success');
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
      case 'radio':    return fillRadio(field, value);
      case 'select':   return fillSelect(field.el, value);
      case 'checkbox': return fillCheckbox(field.el, value);
      case 'file':     return false; // can't programmatically set file inputs
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
  const setter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value'
  )?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
  el.classList.add('ot-filled');
  return true;
}

function fillSelect(el, value) {
  // Try exact value match first
  let opt = Array.from(el.options).find(o => o.value === value);
  // Fuzzy match on text or value
  if (!opt) opt = Array.from(el.options).find(o =>
    o.value.toLowerCase().includes(value.toLowerCase()) ||
    o.text.toLowerCase().includes(value.toLowerCase())
  );
  if (!opt) return false;

  el.value = opt.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.classList.add('ot-filled');
  return true;
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
  return field.type === 'radio' || field.type === 'select';
}

function validateSelectableField(field) {
  if (field.type === 'radio') {
    const name = field.name;
    return !!document.querySelector(`input[type="radio"][name="${name}"]:checked`);
  }
  if (field.type === 'select') {
    return field.el.value !== '' && field.el.selectedIndex > 0;
  }
  return true;
}

function isFieldFilled(field) {
  if (field.type === 'radio')    return validateSelectableField(field);
  if (field.type === 'select')   return validateSelectableField(field);
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
