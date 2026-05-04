const PASSWORD_HEADER = 'x-admin-password';
const ADMIN_PASSWORD = 'gnomeo-admin';

function authHeaders() {
  return { [PASSWORD_HEADER]: ADMIN_PASSWORD };
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSubmissionId() {
  const url = new URL(window.location.href);
  return url.searchParams.get('id');
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function badge(status) {
  return `<span class="badge ${String(status || 'received').toLowerCase()}">${status || 'received'}</span>`;
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || text || `Request failed (${response.status})`);
  return data;
}

function render(detail) {
  const customer = detail.customer || {};
  const submission = detail.submission || {};
  const report = detail.reports?.[0] || null;
  const detailEl = document.getElementById('detail');
  detailEl.innerHTML = `
    <div class="badges">${badge(submission.status)} ${badge(customer.status)}</div>
    <div class="detail-grid">
      <div><label>Customer email</label><div>${esc(customer.email || '—')}</div></div>
      <div><label>Company</label><div>${esc(customer.company || '—')}</div></div>
      <div><label>Created</label><div>${esc(fmtDate(submission.created_at))}</div></div>
      <div><label>Submission file</label><div>${esc(submission.original_filename || '—')}</div></div>
      <div class="full"><label>Notes</label><textarea id="notes">${esc(submission.notes || '')}</textarea></div>
      <div><label>Submission status</label><select id="submissionStatus">${['received','processing','report_ready','report_sent','follow_up','converted','lost'].map((s) => `<option value="${s}" ${submission.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Customer status</label><select id="customerStatus">${['lead','qualified','active_trial','paid','lost'].map((s) => `<option value="${s}" ${customer.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="full"><label>CSV download</label><div class="actions-row"><button id="downloadCsv" type="button">Download CSV</button></div></div>
      <div class="full"><label>Upload generated report</label><input id="reportFile" type="file" accept=".html,.pdf" /></div>
      <div class="full"><label>Report summary</label><textarea id="reportSummary">${esc(report?.summary || '')}</textarea></div>
      <div class="full actions-row">
        <button id="saveBtn" type="button">Save status</button>
        <button id="uploadBtn" type="button">Upload report</button>
        <button id="sendBtn" type="button">Send report</button>
      </div>
    </div>
    <div class="note-box">
      <strong>Latest report</strong>
      <p class="small">${report ? `${esc(report.report_file_url)} · created ${esc(fmtDate(report.created_at))}${report.sent_at ? ` · sent ${esc(fmtDate(report.sent_at))}` : ''}` : 'No report uploaded yet.'}</p>
      <p class="small">Report previews happen locally in the browser via the admin API.</p>
    </div>
  `;

  document.getElementById('downloadCsv').addEventListener('click', async () => {
    const res = await fetch(`/api/admin/file?kind=csv&submission_id=${encodeURIComponent(submission.id)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('CSV download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = submission.original_filename || 'submission.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('saveBtn').addEventListener('click', async () => {
    await apiFetch('/api/admin/crm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update-status',
        submission_id: submission.id,
        submission_status: document.getElementById('submissionStatus').value,
        customer_status: document.getElementById('customerStatus').value,
        submission_notes: document.getElementById('notes').value,
      }),
    });
    window.location.reload();
  });

  document.getElementById('uploadBtn').addEventListener('click', async () => {
    const file = document.getElementById('reportFile').files?.[0];
    if (!file) throw new Error('Choose a report file first.');
    const form = new FormData();
    form.append('action', 'upload-report');
    form.append('submission_id', submission.id);
    form.append('summary', document.getElementById('reportSummary').value || '');
    form.append('report_file', file, file.name);
    await apiFetch('/api/admin/crm', { method: 'POST', body: form });
    window.location.reload();
  });

  document.getElementById('sendBtn').addEventListener('click', async () => {
    await apiFetch('/api/admin/crm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-report', submission_id: submission.id }),
    });
    window.location.reload();
  });
}

(async () => {
  const id = getSubmissionId();
  if (!id) {
    document.getElementById('detail').innerHTML = '<p class="small">Missing submission id.</p>';
    return;
  }
  const data = await apiFetch(`/api/admin/crm?view=detail&id=${encodeURIComponent(id)}`);
  render(data);
})().catch((error) => {
  document.getElementById('detail').innerHTML = `<p class="small">${error.message}</p>`;
});
