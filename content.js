// content.js — Runs on LinkedIn + job sites. Scrapes data and handles auto-apply.

const SITE = detectSite();

// ── SITE DETECTION ─────────────────────────────────────────────────────────────
function detectSite() {
  const host = location.hostname;
  if (host.includes('linkedin.com'))           return 'linkedin';
  if (host.includes('indeed.com'))             return 'indeed';
  if (host.includes('greenhouse.io'))          return 'greenhouse';
  if (host.includes('lever.co'))               return 'lever';
  if (host.includes('ziprecruiter.com'))       return 'ziprecruiter';
  if (host.includes('myworkdayjobs.com'))      return 'workday';
  if (host.includes('icims.com'))              return 'icims';
  return 'unknown';
}

// ── MESSAGE LISTENER ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_DATA') {
    sendResponse(scrapePageData());
    return true;
  }
  if (msg.type === 'AUTO_APPLY') {
    autoApply(msg.job, msg.resumeData).then(result => sendResponse(result));
    return true; // async response
  }
});

// ── SCRAPE PAGE DATA ───────────────────────────────────────────────────────────
function scrapePageData() {
  const domain = location.hostname.replace('www.', '');

  switch (SITE) {
    case 'linkedin': return scrapeLinkedIn(domain);
    default: return { domain, company: document.title, name: '', email: '' };
  }
}

function scrapeLinkedIn(domain) {
  const data = { domain, company: '', name: '', email: '' };

  // Profile page
  const nameEl = document.querySelector('h1.text-heading-xlarge, .pv-text-details__left-panel h1');
  if (nameEl) data.name = nameEl.textContent.trim();

  // Company name on profile
  const compEl = document.querySelector('.pv-text-details__right-panel .hoverable-link-text, .pv-entity__secondary-title');
  if (compEl) data.company = compEl.textContent.trim();

  // Company page
  const orgEl = document.querySelector('.org-top-card-summary__title, h1.ember-view');
  if (orgEl && !data.company) data.company = orgEl.textContent.trim();

  // Try to extract domain from company website link
  const websiteEl = document.querySelector('a[data-control-name="contact_see_more"]');
  if (websiteEl) {
    try { data.domain = new URL(websiteEl.href).hostname.replace('www.', ''); } catch {}
  }

  return data;
}

// ── AUTO-APPLY ─────────────────────────────────────────────────────────────────
async function autoApply(job, resumeData) {
  await sleep(1500); // let the page settle

  try {
    switch (SITE) {
      case 'linkedin':    return await applyLinkedIn(job, resumeData);
      case 'indeed':      return await applyIndeed(job, resumeData);
      case 'greenhouse':  return await applyGreenhouse(job, resumeData);
      case 'lever':       return await applyLever(job, resumeData);
      case 'workday':     return await applyWorkday(job, resumeData);
      default:            return await applyGeneric(job, resumeData);
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── LINKEDIN EASY APPLY ────────────────────────────────────────────────────────
async function applyLinkedIn(job, resumeData) {
  const easyApplyBtn = document.querySelector(
    'button.jobs-apply-button, .jobs-s-apply button, button[aria-label*="Easy Apply"]'
  );
  if (!easyApplyBtn) return { success: false, error: 'No Easy Apply button found' };

  easyApplyBtn.click();
  await sleep(2000);

  // Step through the Easy Apply modal
  let steps = 0;
  while (steps < 10) {
    const modal = document.querySelector('.jobs-easy-apply-modal, [data-test-modal]');
    if (!modal) break;

    fillForm(modal, resumeData);
    await sleep(500);

    // Click Next or Submit
    const nextBtn = modal.querySelector('button[aria-label*="Continue"], button[aria-label*="Next"], button[aria-label*="Review"]');
    const submitBtn = modal.querySelector('button[aria-label*="Submit application"]');

    if (submitBtn) {
      submitBtn.click();
      await sleep(1500);
      return { success: true };
    } else if (nextBtn) {
      nextBtn.click();
      await sleep(1500);
    } else {
      break;
    }
    steps++;
  }

  return { success: false, error: 'Could not complete Easy Apply flow' };
}

// ── INDEED ────────────────────────────────────────────────────────────────────
async function applyIndeed(job, resumeData) {
  const applyBtn = document.querySelector('.ia-IndeedApplyButton, button[data-tn-element="apply-button"]');
  if (!applyBtn) return { success: false, error: 'No Indeed Apply button found' };

  applyBtn.click();
  await sleep(2000);

  const form = document.querySelector('form.ia-Questions-form, form[data-qa="apply-form"]');
  if (form) fillForm(form, resumeData);

  await sleep(500);
  const submitBtn = document.querySelector('button[data-tn-element="apply-button"][type="submit"], .ia-continueButton');
  if (submitBtn) {
    submitBtn.click();
    return { success: true };
  }

  return { success: false, error: 'Could not find Indeed submit button' };
}

// ── GREENHOUSE ────────────────────────────────────────────────────────────────
async function applyGreenhouse(job, resumeData) {
  const form = document.querySelector('#application-form, form#application');
  if (!form) return { success: false, error: 'No Greenhouse form found' };

  fillForm(form, resumeData);
  await sleep(500);

  const submitBtn = form.querySelector('input[type="submit"], button[type="submit"]');
  if (submitBtn) {
    submitBtn.click();
    return { success: true };
  }
  return { success: false, error: 'No Greenhouse submit button' };
}

// ── LEVER ─────────────────────────────────────────────────────────────────────
async function applyLever(job, resumeData) {
  const form = document.querySelector('form.application-form, #application-form');
  if (!form) return { success: false, error: 'No Lever form found' };

  fillForm(form, resumeData);
  await sleep(500);

  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.click();
    return { success: true };
  }
  return { success: false, error: 'No Lever submit button' };
}

// ── WORKDAY ───────────────────────────────────────────────────────────────────
async function applyWorkday(job, resumeData) {
  // Workday is heavily JS-driven — click Apply button
  const applyBtn = document.querySelector('a[data-automation-id="applyNowButton"], button[data-automation-id="applyNowButton"]');
  if (!applyBtn) return { success: false, error: 'No Workday Apply button' };
  applyBtn.click();
  return { success: false, error: 'Workday requires manual steps after opening' };
}

// ── GENERIC ───────────────────────────────────────────────────────────────────
async function applyGeneric(job, resumeData) {
  const form = document.querySelector('form');
  if (!form) return { success: false, error: 'No form found on page' };
  fillForm(form, resumeData);
  return { success: false, error: 'Generic site — review form before submitting' };
}

// ── FORM FILLER ────────────────────────────────────────────────────────────────
function fillForm(container, data = {}) {
  if (!data || !Object.keys(data).length) return;

  const fieldMap = {
    // Name fields
    'first.?name|firstname|first_name':    data.firstName || (data.name || '').split(' ')[0] || '',
    'last.?name|lastname|last_name':       data.lastName  || (data.name || '').split(' ').slice(1).join(' ') || '',
    'full.?name|name':                     data.name      || '',
    // Contact
    'email':                               data.email     || '',
    'phone|telephone|mobile':              data.phone     || '',
    // Location
    'city|location':                       data.city      || '',
    'zip|postal':                          data.zip       || '',
    // Links
    'linkedin|linkedin.?url':              data.linkedin  || '',
    'github|github.?url':                  data.github    || '',
    'portfolio|website|personal.?url':     data.website   || '',
    // Professional
    'headline|title|current.?title':       data.title     || '',
    'years.?of.?experience|experience':    data.yearsExp  || '',
    'salary|compensation':                 data.salary    || '',
    // Cover letter
    'cover.?letter|message|additional':    data.coverLetter || '',
  };

  container.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], textarea').forEach(el => {
    const label = getLabel(el).toLowerCase();
    const name  = (el.name  || '').toLowerCase();
    const id    = (el.id    || '').toLowerCase();
    const key   = `${label} ${name} ${id}`;

    for (const [pattern, value] of Object.entries(fieldMap)) {
      if (!value) continue;
      if (new RegExp(pattern, 'i').test(key)) {
        if (!el.value) {
          setNativeValue(el, value);
          break;
        }
      }
    }
  });

  // Fill select dropdowns (country, work auth, etc.)
  container.querySelectorAll('select').forEach(el => {
    const label = getLabel(el).toLowerCase();
    if (/country/.test(label) && data.country) selectOption(el, data.country);
    if (/work.?auth|authorized|eligible/.test(label) && data.workAuth) selectOption(el, data.workAuth);
    if (/sponsorship|visa/.test(label) && data.requiresSponsorship !== undefined) {
      selectOption(el, data.requiresSponsorship ? 'Yes' : 'No');
    }
  });
}

function getLabel(el) {
  if (el.labels && el.labels[0]) return el.labels[0].textContent;
  const id = el.id;
  if (id) {
    const lbl = document.querySelector(`label[for="${id}"]`);
    if (lbl) return lbl.textContent;
  }
  const wrap = el.closest('.field, .form-group, [class*="field"]');
  if (wrap) {
    const lbl = wrap.querySelector('label, [class*="label"]');
    if (lbl) return lbl.textContent;
  }
  return '';
}

function setNativeValue(el, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectOption(selectEl, text) {
  const opt = Array.from(selectEl.options).find(o =>
    o.text.toLowerCase().includes(text.toLowerCase())
  );
  if (opt) {
    selectEl.value = opt.value;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
