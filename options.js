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

  // Normalise: support both old string format and new {answer,type,options} format
  const normalised = entries.map(([label, val]) => {
    if (typeof val === 'string') return { label, answer: val, type: 'textarea', options: [] };
    return { label, answer: val.answer || '', type: val.type || 'textarea', options: val.options || [] };
  });

  const unanswered = normalised.filter(e => !e.answer).length;
  badge.textContent   = unanswered ? unanswered + ' new' : '';
  badge.style.display = unanswered ? 'inline-block' : 'none';

  container.innerHTML = normalised.map(({ label, answer, type, options }) => {
    const labelHtml = `
      <div class="learned-field-label">
        ${escHtml(label)}
        ${!answer ? '<span class="badge-new">needs answer</span>' : ''}
        <button class="btn-clear-learned" data-label="${escHtml(label)}" title="Remove">✕</button>
      </div>`;

    let inputHtml = '';

    if ((type === 'select') && options.length) {
      inputHtml = `<select class="learned-answer" data-label="${escHtml(label)}">
        <option value="">Select an answer...</option>
        ${options.map(o => `<option value="${escHtml(o)}" ${answer === o ? 'selected' : ''}>${escHtml(o)}</option>`).join('')}
      </select>`;
    } else if ((type === 'radio') && options.length) {
      inputHtml = `<div class="learned-radio-group">
        ${options.map(o => `
          <label class="learned-radio-item">
            <input type="radio" class="learned-answer" name="lr_${escHtml(label).replace(/\s/g,'_')}" data-label="${escHtml(label)}" value="${escHtml(o)}" ${answer === o ? 'checked' : ''} />
            <span>${escHtml(o)}</span>
          </label>`).join('')}
      </div>`;
    } else {
      // text / textarea / unknown
      const isLong = type === 'textarea' || (answer && answer.length > 80);
      if (isLong) {
        inputHtml = `<textarea class="learned-answer" data-label="${escHtml(label)}" placeholder="Type your answer...">${escHtml(answer)}</textarea>`;
      } else {
        inputHtml = `<input type="text" class="learned-answer" data-label="${escHtml(label)}" placeholder="Type your answer..." value="${escHtml(answer)}" />`;
      }
    }

    return `<div class="learned-field">${labelHtml}${inputHtml}<div class="learned-field-meta">Used automatically on future forms</div></div>`;
  }).join('');

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

// ── CLEAR ALL LEARNED FIELDS ──────────────────────────────────────────────────
$('btn-clear-all-learned').addEventListener('click', () => {
  if (!confirm('Clear all saved form answers? This cannot be undone.')) return;
  chrome.storage.local.set({ learnedAnswers: {} }, () => {
    renderLearnedFields({});
    const status = $('ai-fill-status');
    status.textContent = '🗑 Cleared all saved answers.';
    status.style.display = 'block';
    setTimeout(() => { status.style.display = 'none'; }, 3000);
  });
});

// ── FILL WITH AI (profile + learned answers in one call) ──────────────────────
$('btn-fill-ai').addEventListener('click', async () => {
  const btn    = $('btn-fill-ai');
  const status = $('ai-fill-status');

  const apiKey = $('claudeApiKey').value.trim();
  if (!apiKey) {
    status.textContent = '⚠️ Add your Claude API key in the Claude AI section above first.';
    status.style.display = 'block';
    return;
  }

  const local = await new Promise(r => chrome.storage.local.get(['resumeText','resumeData','learnedAnswers'], r));
  const resumeContext = local.resumeText || buildResumeContext(local.resumeData || {});

  if (!resumeContext || resumeContext === 'No profile data available.') {
    status.textContent = '⚠️ Upload your resume or paste resume text in the Resume section first.';
    status.style.display = 'block';
    return;
  }

  // Collect empty learned fields (from DOM + stored)
  const stored = local.learnedAnswers || {};
  const emptyLearnedFields = [];
  const seenLabels = new Set();

  document.querySelectorAll('.learned-answer').forEach(el => {
    const lbl = el.dataset.label;
    if (!lbl || seenLabels.has(lbl)) return;
    seenLabels.add(lbl);
    const val = el.type === 'radio'
      ? (document.querySelector(`.learned-answer[data-label="${CSS.escape(lbl)}"]:checked`)?.value || '')
      : el.value.trim();
    if (!val) {
      const entry = stored[lbl];
      emptyLearnedFields.push({
        label:   lbl,
        type:    entry?.type || 'textarea',
        options: entry?.options || [],
      });
    }
  });

  Object.entries(stored).forEach(([label, val]) => {
    const answer = typeof val === 'string' ? val : val?.answer;
    if (!answer && !seenLabels.has(label)) {
      emptyLearnedFields.push({ label, type: val?.type || 'textarea', options: val?.options || [] });
    }
  });

  btn.disabled    = true;
  btn.textContent = '⏳ Asking Claude...';
  status.textContent = `Parsing resume + filling ${emptyLearnedFields.length} answer${emptyLearnedFields.length !== 1 ? 's' : ''}...`;
  status.style.display = 'block';

  const prompt = `You are setting up a job application autofill system. Parse the applicant's resume and fill in their profile.

RESUME / PROFILE TEXT:
${resumeContext}

TASK 1 — Extract structured profile data from the resume. Return exact values (empty string if not found):
Fields: firstName, lastName, email, phone, address, city, state, zip, country,
title, employer, yearsExp, school, fieldOfStudy, gradYear,
linkedin, github, website, salary, workAuth, degree

TASK 2 — Answer these job application fields based on the resume:
${JSON.stringify(emptyLearnedFields.map(f => ({
  label: f.label,
  type: f.type,
  ...(f.options?.length ? { options: f.options } : {}),
})))}

For TASK 2:
- Short factual fields: just the value
- Essay/behavioral: 2-4 professional sentences
- Radio/select with options listed: return EXACTLY one of the listed option values
- Consent checkboxes: return "yes"

Respond ONLY with this exact JSON structure:
{
  "profile": { "firstName": "", "lastName": "", ... },
  "answers": [{ "label": "...", "answer": "..." }]
}`;

  chrome.runtime.sendMessage({ type: 'CLAUDE_COMPLETE', prompt, apiKey }, response => {
    btn.disabled    = false;
    btn.textContent = '🤖 Fill All with AI';

    if (response?.error) {
      status.textContent = '❌ Claude error: ' + response.error;
      return;
    }

    try {
      let raw = (response.text || '').trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
      const result = JSON.parse(raw);

      // ── Apply profile fields (only overwrite empty ones) ──
      let profileFilled = 0;
      if (result.profile) {
        Object.entries(result.profile).forEach(([key, val]) => {
          if (!val) return;
          const el = $(key);
          if (!el) return;
          if (el.value.trim()) return; // don't overwrite existing data
          el.value = val;
          el.style.borderColor = '#7c4dff';
          profileFilled++;
        });
      }

      // ── Apply learned answers ──
      let answersFilled = 0;
      if (result.answers) {
        result.answers.forEach(({ label, answer }) => {
          if (!answer) return;
          // Update stored object
          if (stored[label] !== undefined) {
            if (typeof stored[label] === 'string') stored[label] = answer;
            else stored[label] = { ...stored[label], answer };
          } else {
            stored[label] = { answer, type: 'textarea', options: [] };
          }
          answersFilled++;
        });
        chrome.storage.local.set({ learnedAnswers: stored });
        renderLearnedFields(stored);
      }

      status.textContent = `✅ Profile: ${profileFilled} field${profileFilled !== 1 ? 's' : ''} filled · Answers: ${answersFilled} filled — click Save All Settings to keep.`;
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

  // Collect learned answers — handle textarea, input, select, and radio
  const learnedAnswers = {};
  const seen = new Set();
  document.querySelectorAll('.learned-answer').forEach(el => {
    const lbl = el.dataset.label;
    if (!lbl || seen.has(lbl)) return;
    if (el.type === 'radio') {
      // Collect all radios for this group; only mark seen after processing all
      const checked = document.querySelector(`.learned-answer[data-label="${CSS.escape(lbl)}"]:checked`);
      learnedAnswers[lbl] = checked ? { answer: checked.value, type: 'radio', options: Array.from(document.querySelectorAll(`.learned-answer[data-label="${CSS.escape(lbl)}"]`)).map(r => r.value) } : { answer: '', type: 'radio', options: [] };
      seen.add(lbl);
    } else {
      learnedAnswers[lbl] = { answer: el.value.trim(), type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : 'text', options: el.tagName === 'SELECT' ? Array.from(el.options).filter(o=>o.value).map(o=>o.text) : [] };
      seen.add(lbl);
    }
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
