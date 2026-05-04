const PASSWORD_HEADER = 'x-admin-password';
const ADMIN_PASSWORD = 'gnomeo-admin';

const els = {
  summary: document.getElementById('summary'),
  search: document.getElementById('searchInput'),
  statusFilter: document.getElementById('statusFilter'),
  customerStatusFilter: document.getElementById('customerStatusFilter'),
  reloadBtn: document.getElementById('reloadBtn'),
  tableBody: document.getElementById('tableBody'),
  detailHint: document.getElementById('detailHint'),
  detailContent: document.getElementById('detailContent'),
};

const state = {
  rows: [],
  selectedId: null,
  detail: null,
};

const customerStatuses = ['lead', 'qualified', 'active_trial', 'paid', 'lost'];
const submissionStatuses = ['received', 'processing', 'report_ready', 'report_sent', 'follow_up', 'converted', 'lost'];

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

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusBadge(status) {
  return `<span class="badge ${String(status || 'received').toLowerCase()}">${status || 'received'}</span>`;
}

function customerBadge(status) {
  return `<span class="badge ${String(status || 'lead').toLowerCase()}">${status || 'lead'}</span>`;
}

function matches(item, query) {
  if (!query) return true;
  const haystack = [item.customer_email, item.original_filename, item.notes, item.customer_status, item.status].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function renderSummary() {
  const total = state.rows.length;
  const byStatus = state.rows.reduce((acc, row) => {
    acc[row.status || 'received'] = (acc[row.status || 'received'] || 0) + 1;
    return acc;
  }, {});
  els.summary.innerHTML = `
    <div><span>Total submissions</span><strong>${esc(total)}</strong></div>
    <div><span>Received</span><strong>${esc(byStatus.received || 0)}</strong></div>
    <div><span>Report ready</span><strong>${esc(byStatus.report_ready || 0)}</strong></div>
    <div><span>Report sent</span><strong>${esc(byStatus.report_sent || 0)}</strong></div>
  `;
}

function renderFilters() {
  const currentSubmission = els.statusFilter.value;
  const currentCustomer = els.customerStatusFilter.value;
  const statuses = ['all', ...submissionStatuses.filter((v) => state.rows.some((row) => row.status === v))];
  const custStatuses = ['all', ...customerStatuses.filter((v) => state.rows.some((row) => row.customer_status === v))];

  els.statusFilter.innerHTML = statuses.map((status) => `<option value="${status}">${status === 'all' ? 'All' : status}</option>`).join('');
  els.customerStatusFilter.innerHTML = custStatuses.map((status) => `<option value="${status}">${status === 'all' ? 'All' : status}</option>`).join('');
  els.statusFilter.value = statuses.includes(currentSubmission) ? currentSubmission : 'all';
  els.customerStatusFilter.value = custStatuses.includes(currentCustomer) ? currentCustomer : 'all';
}

function renderTable() {
  const query = els.search.value.trim();
  const status = els.statusFilter.value;
  const customerStatus = els.customerStatusFilter.value;
  const filtered = state.rows.filter((row) => {
    if (!matches(row, query)) return false;
    if (status !== 'all' && row.status !== status) return false;
    if (customerStatus !== 'all' && row.customer_status !== customerStatus) return false;
    return true;
  });

  els.tableBody.innerHTML = filtered.map((row) => `
    <tr data-id="${row.id}" class="row-link">
      <td>${esc(row.customer_email || '—')}<div class="small">${customerBadge(row.customer_status)}</div></td>
      <td>${esc(row.original_filename || '—')}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${esc(fmtDate(row.created_at))}</td>
      <td>${esc(row.notes ? row.notes : '—')}</td>
    </tr>
  `).join('');

  if (!filtered.length) {
    els.tableBody.innerHTML = '<tr><td colspan="5" class="small">No submissions match the filters.</td></tr>';
  }

  els.tableBody.querySelectorAll('tr[data-id]').forEach((row) => {
    row.addEventListener('click', () => openDetail(row.getAttribute('data-id')));
  });
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
  if (!response.ok) {
    throw new Error(data?.error || text || `Request failed (${response.status})`);
  }
  return data;
}

async function loadRows() {
  const data = await apiFetch('/api/admin/crm?view=list');
  state.rows = Array.isArray(data.submissions) ? data.submissions : [];
  renderSummary();
  renderFilters();
  renderTable();
  if (state.selectedId) await openDetail(state.selectedId, { quiet: true });
}

function detailTemplate(detail) {
  const customer = detail.customer || {};
  const submission = detail.submission || {};
  const latestReport = detail.reports?.[0] || null;
  return `
    <div class="status-box">
      <div class="badges">
        ${statusBadge(submission.status)}
        ${customerBadge(customer.status)}
      </div>
      <p class="small">Customer status and submission status can both be updated.</p>
    </div>

    <div class="detail-grid">
      <div>
        <label>Customer email</label>
        <div>${esc(customer.email || '—')}</div>
      </div>
      <div>
        <label>Company</label>
        <div>${esc(customer.company || '—')}</div>
      </div>
      <div>
        <label>Submission status</label>
        <select id="submissionStatus">${submissionStatuses.map((s) => `<option value="${s}" ${submission.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      </div>
      <div>
        <label>Customer status</label>
        <select id="customerStatus">${customerStatuses.map((s) => `<option value="${s}" ${customer.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      </div>
      <div class="full">
        <label>Submission notes</label>
        <textarea id="submissionNotes">${esc(submission.notes || '')}</textarea>
      </div>
      <div class="full">
        <label>Customer notes</label>
        <textarea id="customerNotes">${esc(customer.notes || '')}</textarea>
      </div>
      <div>
        <label>CSV download</label>
        <div class="actions-row"><button id="downloadCsvBtn" type="button">Download CSV</button></div>
      </div>
      <div>
        <label>Report preview</label>
        <div class="actions-row"><button id="previewReportBtn" type="button" ${latestReport ? '' : 'disabled'}>Preview latest report</button></div>
      </div>
      <div class="full">
        <label>Upload generated report</label>
        <input id="reportFile" type="file" accept=".html,.pdf" />
      </div>
      <div class="full">
        <label>Report summary</label>
        <textarea id="reportSummary" placeholder="Short summary for the report record">${latestReport?.summary || ''}</textarea>
      </div>
      <div class="full actions-row">
        <button id="saveStatusBtn" type="button">Save status</button>
        <button id="uploadReportBtn" type="button">Upload report</button>
        <button id="sendReportBtn" type="button">Send report</button>
      </div>
    </div>

    <div class="note-box">
      <strong>Workflow note</strong>
      <p class="small">Download or access the CSV, run the local report tool, upload the report here, then send it from the CRM.</p>
    </div>

    <div class="note-box">
      <strong>Latest report</strong>
      <p class="small">${latestReport ? `${esc(fmtDate(latestReport.created_at))} · sent ${latestReport.sent_at ? esc(fmtDate(latestReport.sent_at)) : 'not yet sent'}` : 'No report uploaded yet.'}</p>
    </div>
  `;
}

async function openDetail(id, options = {}) {
  if (!id) return;
  state.selectedId = id;
  const data = await apiFetch(`/api/admin/crm?view=detail&id=${encodeURIComponent(id)}`);
  state.detail = data;
  els.detailHint.classList.add('hidden');
  els.detailContent.classList.remove('hidden');
  els.detailContent.innerHTML = detailTemplate(data);

  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const previewReportBtn = document.getElementById('previewReportBtn');
  const saveStatusBtn = document.getElementById('saveStatusBtn');
  const uploadReportBtn = document.getElementById('uploadReportBtn');
  const sendReportBtn = document.getElementById('sendReportBtn');
  const reportFile = document.getElementById('reportFile');

  downloadCsvBtn?.addEventListener('click', async () => {
    const res = await fetch(`/api/admin/file?kind=csv&submission_id=${encodeURIComponent(id)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('CSV download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.submission.original_filename || 'submission'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  previewReportBtn?.addEventListener('click', async () => {
    const latestReport = data.reports?.[0];
    if (!latestReport) return;
    const res = await fetch(`/api/admin/file?kind=report&report_id=${encodeURIComponent(latestReport.id)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Report preview failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  saveStatusBtn?.addEventListener('click', async () => {
    await apiFetch('/api/admin/crm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update-status',
        submission_id: id,
        submission_status: document.getElementById('submissionStatus').value,
        customer_status: document.getElementById('customerStatus').value,
        submission_notes: document.getElementById('submissionNotes').value,
        customer_notes: document.getElementById('customerNotes').value,
      }),
    });
    await loadRows();
    await openDetail(id, { quiet: true });
  });

  uploadReportBtn?.addEventListener('click', async () => {
    const file = reportFile?.files?.[0];
    if (!file) throw new Error('Choose a report file first.');
    const form = new FormData();
    form.append('action', 'upload-report');
    form.append('submission_id', id);
    form.append('summary', document.getElementById('reportSummary').value || '');
    form.append('report_file', file, file.name);
    await apiFetch('/api/admin/crm', { method: 'POST', body: form });
    await loadRows();
    await openDetail(id, { quiet: true });
  });

  sendReportBtn?.addEventListener('click', async () => {
    await apiFetch('/api/admin/crm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-report', submission_id: id }),
    });
    await loadRows();
    await openDetail(id, { quiet: true });
  });

  if (!options.quiet) {
    els.detailHint.textContent = `${data.customer.email || 'Unknown customer'} · ${data.submission.original_filename || 'untitled'}`;
  }
}

els.search.addEventListener('input', renderTable);
els.statusFilter.addEventListener('change', renderTable);
els.customerStatusFilter.addEventListener('change', renderTable);
els.reloadBtn.addEventListener('click', () => loadRows().catch((error) => { els.detailHint.textContent = error.message; }));

loadRows().catch((error) => {
  els.summary.innerHTML = `<div><span>Error</span><strong>—</strong></div>`;
  els.tableBody.innerHTML = `<tr><td colspan="5">${error.message}</td></tr>`;
});
