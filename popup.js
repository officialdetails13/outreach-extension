// popup.js — Outreach Tracker + Job Applier extension popup

const DEFAULT_BACKEND = 'https://outreach-tracker-j73i.onrender.com';

// ── STORAGE HELPERS ────────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND, resumeData: {} }, resolve);
  });
}

async function getJobs() {
  return new Promise(resolve => {
    chrome.storage.local.get({ jobs: [] }, data => resolve(data.jobs));
  });
}

async function saveJobs(jobs) {
  return new Promise(resolve => {
    chrome.storage.local.set({ jobs }, resolve);
  });
}

// ── API HELPERS ────────────────────────────────────────────────────────────────
async function apiGet(path) {
  const { backendUrl } = await getSettings();
  const res = await fetch(`${backendUrl}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const { backendUrl } = await getSettings();
  const res = await fetch(`${backendUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ── TAB SWITCHING ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => {
      t.classList.add('hidden');
      t.classList.remove('active');
    });
    btn.classList.add('active');
    const target = document.getElementById(`tab-${btn.dataset.tab}`);
    target.classList.remove('hidden');
    target.classList.add('active');
    if (btn.dataset.tab === 'outreach') loadOutreach();
    if (btn.dataset.tab === 'jobs') loadJobs();
  });
});

// ── OUTREACH TAB ───────────────────────────────────────────────────────────────
let allOutreach = [];

async function loadOutreach(filter = '') {
  const list = document.getElementById('outreach-list');
  list.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const data = await apiGet('/api/outreach');
    allOutreach = data;
    renderOutreach(filter);
  } catch {
    list.innerHTML = '<div class="empty-state">Cannot reach backend.<br><span class="hint">Check Settings → Backend URL</span></div>';
  }
}

function renderOutreach(filter = '') {
  const list = document.getElementById('outreach-list');
  const q = filter.toLowerCase();
  const filtered = q
    ? allOutreach.filter(r =>
        (r.domain || '').toLowerCase().includes(q) ||
        (r.company || '').toLowerCase().includes(q) ||
        (r.name || '').toLowerCase().includes(q)
      )
    : allOutreach;

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No records found.</div>';
    return;
  }

  list.innerHTML = filtered.map(r => `
    <div class="outreach-card" data-id="${r.id}">
      <div class="card-top">
        <span class="card-company">${r.company || r.domain}</span>
        <span class="stage-badge stage-${r.stage || 'identified'}">${r.stage || 'identified'}</span>
      </div>
      <div class="card-domain">${r.domain || ''} ${r.name ? '· ' + r.name : ''}</div>
    </div>
  `).join('');
}

document.getElementById('search-input').addEventListener('input', e => {
  renderOutreach(e.target.value);
});

document.getElementById('btn-refresh').addEventListener('click', () => loadOutreach());

// Add form
document.getElementById('btn-show-add').addEventListener('click', () => {
  document.getElementById('add-form').classList.remove('hidden');
  document.getElementById('btn-show-add').classList.add('hidden');
});

document.getElementById('btn-cancel').addEventListener('click', () => {
  document.getElementById('add-form').classList.add('hidden');
  document.getElementById('btn-show-add').classList.remove('hidden');
});

document.getElementById('btn-save').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  try {
    await apiPost('/api/outreach', {
      domain:  document.getElementById('f-domain').value.trim(),
      company: document.getElementById('f-company').value.trim(),
      name:    document.getElementById('f-name').value.trim(),
      email:   document.getElementById('f-email').value.trim(),
      stage:   document.getElementById('f-stage').value,
    });
    document.getElementById('add-form').classList.add('hidden');
    document.getElementById('btn-show-add').classList.remove('hidden');
    ['f-domain','f-company','f-name','f-email'].forEach(id => document.getElementById(id).value = '');
    loadOutreach();
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
});

// "Add from page" button — populated by content script via message
document.getElementById('btn-add-from-page').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_DATA' });
  if (response) {
    document.getElementById('f-domain').value  = response.domain  || '';
    document.getElementById('f-company').value = response.company || '';
    document.getElementById('f-name').value    = response.name    || '';
    document.getElementById('f-email').value   = response.email   || '';
    document.getElementById('add-form').classList.remove('hidden');
    document.getElementById('btn-show-add').classList.add('hidden');
  }
});

// ── DETECT CURRENT PAGE ────────────────────────────────────────────────────────
async function detectCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    const domain = url.hostname.replace('www.', '');
    const isLinkedIn = url.hostname.includes('linkedin.com');
    const isJobSite = ['indeed.com','greenhouse.io','lever.co','ziprecruiter.com','myworkdayjobs.com','icims.com']
      .some(d => url.hostname.includes(d));

    if (isLinkedIn || isJobSite) {
      const banner = document.getElementById('page-context');
      const label = document.getElementById('context-label');
      banner.classList.remove('hidden');
      label.textContent = `On: ${domain}`;
    }
  } catch {
    // not a supported page
  }
}

// ── JOBS TAB ───────────────────────────────────────────────────────────────────
let allJobs = [];

async function loadJobs() {
  allJobs = await getJobs();
  renderJobs();
}

function renderJobs() {
  const list   = document.getElementById('jobs-list');
  const search = document.getElementById('jobs-search').value.toLowerCase();
  const status = document.getElementById('jobs-status-filter').value;
  const badge  = document.getElementById('jobs-count');

  let filtered = allJobs;
  if (search) filtered = filtered.filter(j =>
    (j.title || '').toLowerCase().includes(search) ||
    (j.company || '').toLowerCase().includes(search)
  );
  if (status) filtered = filtered.filter(j => j.status === status);

  badge.textContent = allJobs.length;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">
      <p>${allJobs.length === 0 ? 'No jobs yet.' : 'No matching jobs.'}</p>
      <p class="hint">${allJobs.length === 0 ? 'Phase 2: your job scraper will populate this list.' : ''}</p>
    </div>`;
    return;
  }

  list.innerHTML = filtered.map((j, i) => `
    <div class="job-card" data-index="${i}">
      <div class="job-info">
        <div class="job-title">${j.title || 'Untitled'}</div>
        <div class="job-company">${j.company || ''} ${j.location ? '· ' + j.location : ''}</div>
      </div>
      <div class="job-actions">
        <button class="btn-apply-now" data-url="${j.url}" data-index="${i}">Apply</button>
        <button class="btn-skip" data-index="${i}">Skip</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-apply-now').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = +btn.dataset.index;
      await chrome.tabs.create({ url: allJobs[idx].url });
      allJobs[idx].status = 'applied';
      await saveJobs(allJobs);
      renderJobs();
    });
  });

  list.querySelectorAll('.btn-skip').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = +btn.dataset.index;
      allJobs[idx].status = 'skipped';
      await saveJobs(allJobs);
      renderJobs();
    });
  });
}

document.getElementById('jobs-search').addEventListener('input', renderJobs);
document.getElementById('jobs-status-filter').addEventListener('change', renderJobs);

// ── AUTO-APPLY TAB ─────────────────────────────────────────────────────────────
let applyRunning = false;
let applySession = { applied: 0, total: 0 };

function setApplyStatus(icon, text) {
  document.getElementById('status-icon').textContent = icon;
  document.getElementById('status-text').textContent = text;
}

function addLog(msg, cls = '') {
  const log = document.getElementById('apply-log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.prepend(line);
}

function updateProgress() {
  const { applied, total } = applySession;
  const pct = total ? Math.round((applied / total) * 100) : 0;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = `${applied} / ${total} applied`;
}

document.getElementById('btn-start-apply').addEventListener('click', async () => {
  const jobs = await getJobs();
  const skipApplied = document.getElementById('apply-skip-applied').checked;
  const maxApply = +document.getElementById('apply-max').value || 10;
  const delaySec  = +document.getElementById('apply-delay').value || 5;

  const pending = jobs.filter(j => !skipApplied || j.status !== 'applied').slice(0, maxApply);

  if (!pending.length) {
    alert('No pending jobs to apply to. Add jobs in the Jobs tab first.');
    return;
  }

  applyRunning = true;
  applySession = { applied: 0, total: pending.length };
  document.getElementById('btn-start-apply').classList.add('hidden');
  document.getElementById('btn-stop-apply').classList.remove('hidden');
  document.getElementById('apply-progress').classList.remove('hidden');
  setApplyStatus('⏳', 'Running...');
  updateProgress();

  // Send to background service worker to manage across tabs
  chrome.runtime.sendMessage({
    type: 'START_AUTO_APPLY',
    jobs: pending,
    delaySec,
  });
});

document.getElementById('btn-stop-apply').addEventListener('click', () => {
  applyRunning = false;
  chrome.runtime.sendMessage({ type: 'STOP_AUTO_APPLY' });
  setApplyStatus('⏹', 'Stopped');
  document.getElementById('btn-start-apply').classList.remove('hidden');
  document.getElementById('btn-stop-apply').classList.add('hidden');
  addLog('Stopped by user.', 'log-info');
});

// Listen for progress updates from background
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'APPLY_PROGRESS') {
    applySession.applied = msg.applied;
    applySession.total   = msg.total;
    updateProgress();
    addLog(msg.log, msg.success ? 'log-success' : 'log-error');
  }
  if (msg.type === 'APPLY_DONE') {
    setApplyStatus('✅', `Done — ${msg.applied} applied`);
    document.getElementById('btn-start-apply').classList.remove('hidden');
    document.getElementById('btn-stop-apply').classList.add('hidden');
    addLog(`Auto-apply session complete: ${msg.applied}/${msg.total}`, 'log-success');
    saveJobs(msg.updatedJobs);
  }
});

// ── FILL CURRENT PAGE ─────────────────────────────────────────────────────────
async function initFillNow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  // Show the URL
  try {
    const url = new URL(tab.url);
    document.getElementById('current-page-url').textContent = url.hostname + url.pathname;
  } catch {
    document.getElementById('current-page-url').textContent = tab.url;
  }

  // Disable on chrome:// pages where content scripts can't run
  const restricted = tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:');
  if (restricted) {
    document.getElementById('btn-fill-now').disabled = true;
    document.getElementById('current-page-url').textContent = 'Not available on this page';
  }
}

document.getElementById('btn-fill-now').addEventListener('click', async () => {
  const btn    = document.getElementById('btn-fill-now');
  const status = document.getElementById('fill-now-status');

  btn.disabled     = true;
  btn.textContent  = '⏳ Filling...';
  status.className = 'fill-now-status';
  status.classList.remove('hidden');
  status.textContent = 'Injecting autofill...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject content script + CSS into pages that were open before the extension loaded
    await Promise.all([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {}),
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }).catch(() => {}),
    ]);

    // Wait for the injected script to register its message listener
    await new Promise(r => setTimeout(r, 200));

    const response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { type: 'AUTO_APPLY' }, res => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res || { success: true });
      });
    });

    status.textContent = response?.success ? '✅ Done!' : '⚠️ Partial — check the page';
    status.className   = 'fill-now-status ' + (response?.success ? 'ok' : 'warn');
  } catch (err) {
    status.textContent = '⚠️ ' + (err.message.includes('Cannot access') ? 'Cannot run on this page type' : err.message);
    status.className   = 'fill-now-status warn';
  } finally {
    btn.disabled    = false;
    btn.textContent = '✨ Autofill This Page';
  }
});

// ── SETTINGS LINK ──────────────────────────────────────────────────────────────
document.getElementById('openOptions').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── INIT ───────────────────────────────────────────────────────────────────────
detectCurrentPage();
loadOutreach();
initFillNow();
