// background.js — Service worker for auto-apply orchestration

let applyState = {
  running: false,
  jobs: [],
  current: 0,
  applied: 0,
  delaySec: 5,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_AUTO_APPLY') {
    startAutoApply(msg.jobs, msg.delaySec);
  }
  if (msg.type === 'STOP_AUTO_APPLY') {
    applyState.running = false;
  }
  if (msg.type === 'JOB_APPLIED') {
    handleJobApplied(msg);
  }
});

async function startAutoApply(jobs, delaySec) {
  applyState = { running: true, jobs, current: 0, applied: 0, delaySec };
  processNextJob();
}

async function processNextJob() {
  if (!applyState.running || applyState.current >= applyState.jobs.length) {
    broadcastDone();
    return;
  }

  const job = applyState.jobs[applyState.current];
  applyState.current++;

  try {
    // Open the job URL in a new tab
    const tab = await chrome.tabs.create({ url: job.url, active: true });

    // Wait for the tab to load, then inject the apply script
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Inject content script to fill and attempt apply
        chrome.tabs.sendMessage(tab.id, {
          type: 'AUTO_APPLY',
          job,
          resumeData: applyState.resumeData || {},
        }, response => {
          const success = response?.success || false;
          if (success) applyState.applied++;

          broadcastProgress(job, success);

          // Close tab after attempting apply, then move to next
          setTimeout(() => {
            chrome.tabs.remove(tab.id).catch(() => {});
            scheduleNext();
          }, 2000);
        });
      }
    });

    // Timeout safety: if tab never loads, skip after 30s
    setTimeout(() => {
      if (applyState.running) {
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

  chrome.runtime.sendMessage({
    type: 'APPLY_PROGRESS',
    applied: applyState.applied,
    total: applyState.jobs.length,
    log,
    success,
  }).catch(() => {}); // popup may be closed
}

function broadcastDone() {
  applyState.running = false;
  const updatedJobs = applyState.jobs.map((j, i) => ({
    ...j,
    status: i < applyState.current ? 'applied' : j.status,
  }));
  chrome.runtime.sendMessage({
    type: 'APPLY_DONE',
    applied: applyState.applied,
    total: applyState.jobs.length,
    updatedJobs,
  }).catch(() => {});
}
