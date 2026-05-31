// options.js — load/save extension settings

const RESUME_FIELDS = [
  'firstName','lastName','email','phone',
  'address','city','state','zip','country',
  'title','employer','yearsExp',
  'school','fieldOfStudy','gradYear',
  'linkedin','github','website','salary',
  'workAuth','requiresSponsorship','coverLetter','degree',
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
$('resume-upload-box').addEventListener('click', function (e) {
  // Don't open file dialog when clicking the Remove button
  if (e.target.closest('#btn-clear-resume')) return;
  $('resumeFileInput').click();
});

$('btn-clear-resume').addEventListener('click', function (e) {
  e.stopPropagation();
  chrome.storage.local.remove('resumeFile');
  $('resume-upload-box').classList.remove('has-file');
  $('resume-filename').textContent = '';
  $('resumeFileInput').value = '';
});

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

// ── FILL LEARNED FIELDS WITH AI ───────────────────────────────────────────────
$('btn-fill-ai').addEventListener('click', async () => {
  const btn    = $('btn-fill-ai');
  const status = $('ai-fill-status');

  // Collect empty labels from current DOM (includes unsaved ones)
  const emptyFields = [];
  document.querySelectorAll('.learned-answer').forEach(ta => {
    if (!ta.value.trim()) emptyFields.push(ta.dataset.label);
  });

  // Also include any stored empty fields not yet rendered
  const stored = await new Promise(r => chrome.storage.local.get(['learnedAnswers'], d => r(d.learnedAnswers || {})));
  Object.entries(stored).forEach(([label, val]) => {
    if (!val && !emptyFields.includes(label)) emptyFields.push(label);
  });

  if (!emptyFields.length) {
    status.textContent = '✅ All fields already have answers!';
    status.style.display = 'block';
    return;
  }

  const apiKey = $('claudeApiKey').value.trim();
  if (!apiKey) {
    status.textContent = '⚠️ Add your Claude API key above first.';
    status.style.display = 'block';
    return;
  }

  btn.disabled    = true;
  btn.textContent = '⏳ Asking Claude...';
  status.textContent = `Filling ${emptyFields.length} field${emptyFields.length !== 1 ? 's' : ''}...`;
  status.style.display = 'block';

  // Build resume context from stored data
  const local = await new Promise(r => chrome.storage.local.get(['resumeText','resumeData'], r));
  const resumeContext = local.resumeText || buildResumeContext(local.resumeData || {});

  const fieldList = emptyFields.map(label => ({ label, type: 'textarea' }));
  const prompt = `You are helping pre-fill a job application answer bank for an applicant.

APPLICANT PROFILE:
${resumeContext}

For each question below, provide a concise, professional answer the applicant can use on job applications.
- Short factual fields (salary, city, etc): just the value
- Essay/behavioral questions: 2-4 professional sentences using STAR method where relevant
- For option fields with listed choices: pick the most appropriate option text exactly

FIELDS (respond as JSON array in same order):
${JSON.stringify(fieldList)}

Respond ONLY with valid JSON: [{"label":"...","answer":"..."}]`;

  chrome.runtime.sendMessage({ type: 'CLAUDE_COMPLETE', prompt, apiKey }, response => {
    btn.disabled    = false;
    btn.textContent = '🤖 Fill All with AI';

    if (response.error) {
      status.textContent = '❌ Claude error: ' + response.error;
      return;
    }

    try {
      let raw = response.text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
      const answers = JSON.parse(raw);
      let filled = 0;

      answers.forEach(({ label, answer }) => {
        if (!answer) return;
        // Fill rendered textareas
        const ta = document.querySelector(`.learned-answer[data-label="${label.replace(/"/g,'&quot;')}"]`);
        if (ta) { ta.value = answer; filled++; }
        // Also update stored object so it persists even if not rendered
        if (stored[label] !== undefined) stored[label] = answer;
      });

      // Save Claude answers to storage immediately
      chrome.storage.local.set({ learnedAnswers: stored });
      // Re-render with filled values
      renderLearnedFields(stored);
      status.textContent = `✅ Filled ${filled} field${filled !== 1 ? 's' : ''} — review and click Save All Settings.`;
    } catch (e) {
      status.textContent = '❌ Could not parse Claude response. Try again.';
    }
  });
});

function buildResumeContext(r) {
  const parts = [];
  if (r.firstName || r.lastName) parts.push(`Name: ${(r.firstName||'')} ${(r.lastName||'')}`.trim());
  if (r.email)     parts.push(`Email: ${r.email}`);
  if (r.phone)     parts.push(`Phone: ${r.phone}`);
  if (r.title)     parts.push(`Current Title: ${r.title}`);
  if (r.employer)  parts.push(`Current Employer: ${r.employer}`);
  if (r.yearsExp)  parts.push(`Years of Experience: ${r.yearsExp}`);
  if (r.city)      parts.push(`Location: ${r.city}${r.state ? ', '+r.state : ''}${r.country ? ', '+r.country : ''}`);
  if (r.degree)    parts.push(`Education: ${r.degree}${r.fieldOfStudy ? ' in '+r.fieldOfStudy : ''}${r.school ? ' from '+r.school : ''}`);
  if (r.workAuth)  parts.push(`Work Authorization: ${r.workAuth}`);
  if (r.linkedin)  parts.push(`LinkedIn: ${r.linkedin}`);
  if (r.salary)    parts.push(`Expected Salary: ${r.salary}`);
  if (r.coverLetter) parts.push(`\nBackground:\n${r.coverLetter}`);
  return parts.join('\n') || 'No profile data available.';
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
