// options.js — load/save extension settings

const RESUME_FIELDS = [
  'firstName','lastName','email','phone','city','zip','address',
  'title','yearsExp','linkedin','github','website','salary',
  'country','workAuth','requiresSponsorship','coverLetter',
  'degree','school',
];

function $(id) { return document.getElementById(id); }

// ── LOAD ──────────────────────────────────────────────────────────────────────
chrome.storage.sync.get(['backendUrl'], d => {
  if (d.backendUrl) $('backendUrl').value = d.backendUrl;
});

chrome.storage.local.get(['resumeData', 'claudeApiKey', 'resumeFile', 'resumeText', 'learnedAnswers'], d => {
  // Profile fields
  const r = d.resumeData || {};
  RESUME_FIELDS.forEach(f => {
    const el = $(f);
    if (el && r[f] !== undefined) el.value = r[f];
  });

  // Claude key
  if (d.claudeApiKey) $('claudeApiKey').value = d.claudeApiKey;

  // Resume file
  if (d.resumeFile) {
    $('resume-filename').textContent = '📎 ' + (d.resumeFile.name || 'resume');
    $('resume-upload-box').classList.add('has-file');
  }

  // Resume text
  if (d.resumeText) $('resumeText').value = d.resumeText;

  // Learned answers
  renderLearnedFields(d.learnedAnswers || {});
});

// ── RESUME FILE UPLOAD ────────────────────────────────────────────────────────
$('resumeFileInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    const base64 = e.target.result; // data:...,base64data

    // Also try to extract text for plain text files
    if (file.type === 'text/plain') {
      const textReader = new FileReader();
      textReader.onload = te => {
        $('resumeText').value = te.target.result;
      };
      textReader.readAsText(file);
    }

    chrome.storage.local.set({
      resumeFile: { name: file.name, type: file.type, base64 }
    });

    $('resume-filename').textContent = '📎 ' + file.name;
    $('resume-upload-box').classList.add('has-file');
  };
  reader.readAsDataURL(file);
});

function clearResume(e) {
  e.stopPropagation();
  chrome.storage.local.remove('resumeFile');
  $('resume-upload-box').classList.remove('has-file');
  $('resume-filename').textContent = '';
  $('resumeFileInput').value = '';
}
window.clearResume = clearResume;

// ── LEARNED FIELDS ────────────────────────────────────────────────────────────
function renderLearnedFields(learned) {
  const container = $('learned-fields-list');
  const badge     = $('learned-badge');
  const entries   = Object.entries(learned);

  if (!entries.length) {
    container.innerHTML = '<div class="no-learned">No unanswered fields yet. Run autofill on a form to populate this list.</div>';
    badge.style.display = 'none';
    return;
  }

  const unanswered = entries.filter(([, v]) => !v).length;
  if (unanswered > 0) {
    badge.textContent    = unanswered + ' new';
    badge.style.display  = 'inline-block';
  } else {
    badge.style.display  = 'none';
  }

  container.innerHTML = entries.map(([label, answer]) => `
    <div class="learned-field">
      <div class="learned-field-label">
        ${escHtml(label)}
        ${!answer ? '<span class="badge-new">needs answer</span>' : ''}
        <button class="btn-clear-learned" data-label="${escHtml(label)}" title="Remove this field">✕</button>
      </div>
      <textarea class="learned-answer" data-label="${escHtml(label)}" placeholder="Type your answer here...">${escHtml(answer)}</textarea>
      <div class="learned-field-meta">Saved answer — used automatically on future forms</div>
    </div>
  `).join('');

  // Remove individual field
  container.querySelectorAll('.btn-clear-learned').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const lbl = btn.dataset.label;
      chrome.storage.local.get(['learnedAnswers'], d => {
        const updated = d.learnedAnswers || {};
        delete updated[lbl];
        chrome.storage.local.set({ learnedAnswers: updated }, () => renderLearnedFields(updated));
      });
    });
  });
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── SAVE ──────────────────────────────────────────────────────────────────────
$('btn-save').addEventListener('click', () => {
  // Profile data
  const resumeData = {};
  RESUME_FIELDS.forEach(f => {
    const el = $(f);
    if (el) resumeData[f] = el.value;
  });

  // Collect learned answers from textareas
  const learnedAnswers = {};
  document.querySelectorAll('.learned-answer').forEach(ta => {
    if (ta.dataset.label) learnedAnswers[ta.dataset.label] = ta.value.trim();
  });

  const claudeApiKey = $('claudeApiKey').value.trim();
  const resumeText   = $('resumeText').value.trim();

  chrome.storage.sync.set({ backendUrl: $('backendUrl').value.trim() });
  chrome.storage.local.set({ resumeData, claudeApiKey, resumeText, learnedAnswers }, () => {
    const toast = $('toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
    // Re-render learned fields to update badges
    renderLearnedFields(learnedAnswers);
  });
});
