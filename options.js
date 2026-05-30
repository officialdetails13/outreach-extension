// options.js — load/save extension settings

const FIELDS = [
  'backendUrl',
  'firstName','lastName','email','phone','city','zip',
  'title','yearsExp','linkedin','github','website','salary',
  'country','workAuth','requiresSponsorship','coverLetter',
];

function $(id) { return document.getElementById(id); }

// Load saved settings on open
chrome.storage.sync.get(['backendUrl'], syncData => {
  if (syncData.backendUrl) $('backendUrl').value = syncData.backendUrl;
});

chrome.storage.local.get(['resumeData'], localData => {
  const r = localData.resumeData || {};
  FIELDS.filter(f => f !== 'backendUrl').forEach(f => {
    const el = $(f);
    if (el && r[f] !== undefined) el.value = r[f];
  });
});

// Save on button click
$('btn-save').addEventListener('click', () => {
  const resumeData = {};
  FIELDS.filter(f => f !== 'backendUrl').forEach(f => {
    const el = $(f);
    if (el) resumeData[f] = el.value;
  });

  chrome.storage.sync.set({ backendUrl: $('backendUrl').value.trim() });
  chrome.storage.local.set({ resumeData }, () => {
    const toast = $('toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
});
