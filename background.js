// background.js — Service worker: Claude API proxy + auto-apply orchestration

// ── CLAUDE API PROXY ──────────────────────────────────────────────────────────
// Content scripts can't call api.anthropic.com due to CORS — route through here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CLAUDE_COMPLETE') {
    callClaude(msg.prompt, msg.apiKey)
      .then(text => sendResponse({ text }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'START_AUTO_APPLY') {
    startAutoApply(msg.jobs, msg.delaySec);
    return false;
  }

  if (msg.type === 'STOP_AUTO_APPLY') {
    applyState.running = false;
    return false;
  }

  // Trusted input — react-select & similar ignore synthetic content-script events,
  // so the content script delegates dropdown open/select clicks to here, where the
  // chrome.debugger API can dispatch real (isTrusted) mouse events via CDP.
  if (msg.type === 'TRUSTED_CLICK') {
    const tabId = sender.tab && sender.tab.id;
    trustedClick(tabId, msg.x, msg.y)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'DEBUGGER_DETACH') {
    detachDebugger(sender.tab && sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Trusted file attach — react file inputs ignore a synthetically-set FileList,
  // so set it via CDP DOM.setFileInputFiles (the trusted path, like Playwright).
  // Requires a real on-disk path (browsers hide real paths from file pickers).
  if (msg.type === 'TRUSTED_SET_FILE') {
    const tabId = sender.tab && sender.tab.id;
    trustedSetFile(tabId, msg.selector, msg.paths)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function trustedSetFile(tabId, selector, paths) {
  if (tabId == null) throw new Error('no tab');
  await ensureAttached(tabId);
  // The DOM domain must be explicitly enabled before DOM.getDocument/querySelector
  // work over chrome.debugger (Playwright enables it for us; we must do it ourselves).
  await dbg('sendCommand', { tabId }, ['DOM.enable', {}]).catch(() => {});
  await new Promise(r => setTimeout(r, 150));
  const doc = await dbg('sendCommand', { tabId }, ['DOM.getDocument', { depth: 0 }]);
  const rootId = doc && doc.root && doc.root.nodeId;
  if (!rootId) throw new Error('no document root');
  const q = await dbg('sendCommand', { tabId }, ['DOM.querySelector', { nodeId: rootId, selector }]);
  if (!q || !q.nodeId) throw new Error('file input not found: ' + selector);
  await dbg('sendCommand', { tabId }, ['DOM.setFileInputFiles', { files: paths, nodeId: q.nodeId }]);
}

// ── TRUSTED CLICK via chrome.debugger (CDP Input domain) ──────────────────────
const _attached = new Set();

function dbg(method, target, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](target, ...(params || []), (...args) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(args[0]);
    });
  });
}

async function ensureAttached(tabId) {
  if (_attached.has(tabId)) return;
  await dbg('attach', { tabId }, ['1.3']);
  _attached.add(tabId);
}

async function detachDebugger(tabId) {
  if (tabId == null || !_attached.has(tabId)) return;
  _attached.delete(tabId);
  await dbg('detach', { tabId }, []).catch(() => {});
}

async function trustedClick(tabId, x, y) {
  if (tabId == null) throw new Error('no tab');
  await ensureAttached(tabId);
  const send = (params) => dbg('sendCommand', { tabId }, ['Input.dispatchMouseEvent', params]);
  await send({ type: 'mouseMoved',    x, y });
  await send({ type: 'mousePressed',  x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

// Clean up bookkeeping if the debugger detaches for any reason (tab closed, devtools opened, …).
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) _attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => _attached.delete(tabId));

async function callClaude(prompt, apiKey) {
  if (!apiKey) throw new Error('No Claude API key. Add it in extension Settings.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':                               apiKey,
      'anthropic-version':                       '2023-06-01',
      'content-type':                            'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── AUTO-APPLY ORCHESTRATION ──────────────────────────────────────────────────
let applyState = { running: false, jobs: [], current: 0, applied: 0, delaySec: 5 };

async function startAutoApply(jobs, delaySec) {
  applyState = { running: true, jobs, current: 0, applied: 0, delaySec };
  processNextJob();
}

async function processNextJob() {
  if (!applyState.running || applyState.current >= applyState.jobs.length) {
    broadcastDone();
    return;
  }

  const job = applyState.jobs[applyState.current++];

  try {
    const tab = await chrome.tabs.create({ url: job.url, active: true });

    const onUpdated = (tabId, info) => {
      if (tabId !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);

      chrome.tabs.sendMessage(tab.id, { type: 'AUTO_APPLY', job }, response => {
        const success = response?.success || false;
        if (success) applyState.applied++;
        broadcastProgress(job, success);

        setTimeout(() => {
          chrome.tabs.remove(tab.id).catch(() => {});
          scheduleNext();
        }, 2000);
      });
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    // 30s timeout safety
    setTimeout(() => {
      if (applyState.running) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        broadcastProgress(job, false, 'Timed out');
        chrome.tabs.remove(tab.id).catch(() => {});
        scheduleNext();
      }
    }, 30000);

  } catch (err) {
    broadcastProgress(job, false, err.message);
    scheduleNext();
  }
}

function scheduleNext() {
  if (!applyState.running) { broadcastDone(); return; }
  setTimeout(processNextJob, applyState.delaySec * 1000);
}

function broadcastProgress(job, success, note = '') {
  const log = success
    ? `✓ Applied: ${job.title} @ ${job.company}`
    : `✗ Failed: ${job.title} @ ${job.company}${note ? ' — ' + note : ''}`;
  chrome.runtime.sendMessage({ type: 'APPLY_PROGRESS', applied: applyState.applied, total: applyState.jobs.length, log, success }).catch(() => {});
}

function broadcastDone() {
  applyState.running = false;
  const updatedJobs = applyState.jobs.map((j, i) => ({
    ...j,
    status: i < applyState.current ? 'applied' : j.status,
  }));
  chrome.runtime.sendMessage({ type: 'APPLY_DONE', applied: applyState.applied, total: applyState.jobs.length, updatedJobs }).catch(() => {});
}
