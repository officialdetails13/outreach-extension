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
});

async function callClaude(prompt, apiKey) {
  if (!apiKey) throw new Error('No Claude API key. Add it in extension Settings.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
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
