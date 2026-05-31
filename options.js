// options.js — load/save extension settings

const RESUME_FIELDS = [
  'firstName','lastName','email','phone','city','zip',
  'title','yearsExp','linkedin','github','website','salary',
  'country','workAuth','requiresSponsorship','coverLetter',
  'degree','school','address',
];

function $(id) { return document.getElementById(id); }

// Load saved settings on open
chrome.storage.sync.get(['backendUrl'], syncData => {
  if (syncData.backendUrl) $('backendUrl').value = syncData.backendUrl;
});

chrome.storage.local.get(['resumeData', 'claudeApiKey'], localData => {
  const r = localData.resumeData || {};
  RESUME_FIELDS.forEach(f => {
    const el = $(f);
    if (el && r[f] !== undefined) el.value = r[f];
  });
  if (localData.claudeApiKey) $('claudeApiKey').value = localData.claudeApiKey;
});

// Save on button click
$('btn-save').addEventListener('click', () => {
  const resumeData = {};
  RESUME_FIELDS.forEach(f => {
    const el = $(f);
    if (el) resumeData[f] = el.value;
  });

  const claudeApiKey = $('claudeApiKey').value.trim();

  chrome.storage.sync.set({ backendUrl: $('backendUrl').value.trim() });
  chrome.storage.local.set({ resumeData, claudeApiKey }, () => {
    const toast = $('toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
});
