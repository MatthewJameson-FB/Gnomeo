const PASSWORD_HEADER = 'x-admin-password';
const ADMIN_PASSWORD = '***';

const submissionStatuses = ['received', 'processing', 'report_ready', 'report_sent', 'follow_up', 'converted', 'lost'];
const customerStatuses = ['lead', 'qualified', 'active_trial', 'paid', 'lost'];

const els = {
  banner: document.getElementById('banner'),
  summary: document.getElementById('summary'),
  search: document.getElementById('searchInput'),
  statusFilter: document.getElementById('statusFilter'),
  customerStatusFilter: document.getElementById('customerStatusFilter'),
  reloadBtn: document.getElementById('reloadBtn'),
  tableBody: document.getElementById('tableBody'),
  emptyState: document.getElementById('emptyState'),
  detailHint: document.getElementById('detailHint'),
  detailContent: document.getElementById('detailContent'),
  manualForm: document.getElementById('manualSubmissionForm'),
  manualEmail: document.getElementById('manualEmail'),
  manualCompany: document.getElementById('manualCompany'),
  manualFilename: document.getElementById('manualFilename'),
  manualNotes: document.getElementById('manualNotes'),
  manualStatus: document.getElementById('manualStatus'),
};

const state = {
  rows: [],
  selectedId: null,
  detail: null,
};

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
  return `<span class="badge ${String(status || 'received').toLowerCase()}">${esc(status || 'received')}</span>`;
}

function customerBadge(status) {
  return `<span class="badge ${String(status || 'lead').toLowerCase()}">${esc(status || 'lead')}</span>`;
}

function setBanner(message, type = 'error') {
  if (!message) {
    els.banner.textContent = '';
    els.banner.className = 'banner hidden';
    return;
  }
  els.banner.textContent = message;
  els.banner.className = `banner ${type}`;
}

function matches(row, query) {
  if (!query) return true;
  const haystack = [
    row.customer_email,
    row.original_filename,
    row.notes,
    row.customer_status,
    row.status,
    row.customer?.company,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
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
  const currentSubmission = els.statusFilter.value || 'all';
  const currentCustomer = els.customerStatusFilter.value || 'all';
  const statuses = ['all', ...submissionStatuses.filter((value) => state.rows.some((row) => row.status === value))];
  const custStatuses = ['all', ...customerStatuses.filter((value) => state.rows.some((row) => row.customer_status === value))];

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

  els.emptyState.classList.toggle('hidden', state.rows.length !== 0);

  els.tableBody.innerHTML = filtered.map((row) => `
    <tr data-id="${esc(row.id)}" class="row-link">
      <td>${esc(row.customer_email || '—')}<div class="small">${customerBadge(row.customer_status)}</div></td>
      <td>${esc(row.original_filename || '—')}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${esc(fmtDate(row.created_at))}</td>
      <td>${esc(row.notes || '—')}</td>
    </tr>
  `).join('');

  if (state.rows.length && !filtered.length) {
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
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error || text || `Request failed (${response.status})`);
  }
  return data;
}

function reportStateLabel(report) {
  if (!report) return 'No report uploaded yet.';
  return `${fmtDate(report.created_at)} · ${report.sent_at ? `sent ${fmtDate(report.sent_at)}` : 'not yet sent'}`;
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
      <p class="small">Use the quick buttons to move submissions through the report workflow.</p>
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
        <select id="submissionStatus">${submissionStatuses.map((value) => `<option value="${value}" ${submission.status === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>
      </div>
      <div>
        <label>Customer status</label>
        <select id="customerStatus">${customerStatuses.map((value) => `<option value="${value}" ${customer.status === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>
      </div>
      <div class="full">
        <label>Submission notes</label>
        <textarea id="submissionNotes" placeholder="Internal submission notes">${esc(submission.notes || '')}</textarea>
      </div>
      <div class="full">
        <label>Customer notes</label>
        <textarea id="customerNotes" placeholder="Notes about the customer">${esc(customer.notes || '')}</textarea>
      </div>
      <div>
        <label>CSV download</label>
        <div class="actions-row">
          <button id="downloadCsvBtn" class="secondary" type="button" ${submission.csv_file_url ? '' : 'disabled'}>Download CSV</button>
        </div>
        ${submission.csv_file_url ? '' : '<p class="small">CSV not available here — use admin email attachment.</p>'}
      </div>
      <div>
        <label>Report preview</label>
        <div class="actions-row"><button id="previewReportBtn" class="secondary" type="button" ${latestReport ? '' : 'disabled'}>Preview latest report</button></div>
      </div>
      <div class="full">
        <label>Upload generated report</label>
        <input id="reportFile" type="file" accept=".html,.pdf" />
      </div>
      <div class="full">
        <label>Report summary</label>
        <textarea id="reportSummary" placeholder="Short summary for the report record">${esc(latestReport?.summary || '')}</textarea>
      </div>
      <div class="full actions-row">
        <button id="saveStatusBtn" class="secondary" type="button">Save</button>
        <button id="followUpBtn" class="secondary" type="button">Mark follow-up needed</button>
        <button id="convertedBtn" class="secondary" type="button">Mark converted</button>
        <button id="uploadReportBtn" class="primary" type="button">Upload report</button>
        <button id="sendReportBtn" class="primary" type="button" ${latestReport ? '' : 'disabled'}>Send report email</button>
      </div>
    </div>

    <div class="note-box">
      <strong>Latest report</strong>
      <p class="small">${reportStateLabel(latestReport)}</p>
    </div>
  `;
}

async function updateDetailStatus(id, submissionStatus, customerStatus) {
  const submissionNotes = document.getElementById('submissionNotes').value;
  const customerNotes = document.getElementById('customerNotes').value;

  await apiFetch('/api/admin/crm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'update-status',
      submission_id: id,
      submission_status: submissionStatus,
      customer_status: customerStatus,
      submission_notes: submissionNotes,
      customer_notes: customerNotes,
    }),
  });
}

async function openDetail(id) {
  if (!id) return;
  state.selectedId = id;
  const data = await apiFetch(`/api/admin/crm?view=detail&id=${encodeURIComponent(id)}`);
  state.detail = data;
  els.detailHint.classList.add('hidden');
  els.detailContent.classList.remove('hidden');
  els.detailContent.innerHTML = detailTemplate(data);

  const latestReport = data.reports?.[0] || null;
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const previewReportBtn = document.getElementById('previewReportBtn');
  const saveStatusBtn = document.getElementById('saveStatusBtn');
  const followUpBtn = document.getElementById('followUpBtn');
  const convertedBtn = document.getElementById('convertedBtn');
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
    if (!latestReport) return;
    const res = await fetch(`/api/admin/file?kind=report&report_id=${encodeURIComponent(latestReport.id)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Report preview failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  const saveCurrent = async () => {
    await updateDetailStatus(
      id,
      document.getElementById('submissionStatus').value,
      document.getElementById('customerStatus').value,
    );
    await loadRows();
    await openDetail(id);
  };

  saveStatusBtn?.addEventListener('click', saveCurrent);
  followUpBtn?.addEventListener('click', async () => {
    document.getElementById('submissionStatus').value = 'follow_up';
    if (document.getElementById('customerStatus').value === 'lead') {
      document.getElementById('customerStatus').value = 'qualified';
    }
    await saveCurrent();
  });
  convertedBtn?.addEventListener('click', async () => {
    document.getElementById('submissionStatus').value = 'converted';
    document.getElementById('customerStatus').value = 'paid';
    await saveCurrent();
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
    await openDetail(id);
  });

  sendReportBtn?.addEventListener('click', async () => {
    await apiFetch('/api/admin/crm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-report', submission_id: id }),
    });
    await loadRows();
    await openDetail(id);
  });
}

async function loadRows() {
  setBanner('');
  els.reloadBtn.disabled = true;
  try {
    const data = await apiFetch('/api/admin/crm?view=list');
    state.rows = Array.isArray(data.submissions) ? data.submissions : [];
    renderSummary();
    renderFilters();
    renderTable();
    if (state.selectedId) {
      try {
        await openDetail(state.selectedId);
      } catch (error) {
        setBanner(error.message, 'error');
      }
    }
    if (!state.rows.length) {
      els.detailHint.classList.remove('hidden');
      els.detailHint.textContent = 'No submissions yet. Submit a test CSV from the homepage or add one manually.';
      els.detailContent.classList.add('hidden');
    }
  } catch (error) {
    setBanner(error.message, 'error');
    els.summary.innerHTML = '<div><span>Error</span><strong>—</strong></div>';
    els.tableBody.innerHTML = '';
    els.emptyState.classList.remove('hidden');
  } finally {
    els.reloadBtn.disabled = false;
  }
}

els.search.addEventListener('input', renderTable);
els.statusFilter.addEventListener('change', renderTable);
els.customerStatusFilter.addEventListener('change', renderTable);
els.reloadBtn.addEventListener('click', () => loadRows());

els.manualForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBanner('');
  try {
    const response = await apiFetch('/api/admin/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: els.manualEmail.value,
        company: els.manualCompany.value,
        original_filename: els.manualFilename.value,
        notes: els.manualNotes.value,
        status: els.manualStatus.value,
      }),
    });
    els.manualForm.reset();
    els.manualStatus.value = 'received';
    setBanner(`Manual submission created for ${response.customer?.email || 'customer'}.`, 'good');
    await loadRows();
    await openDetail(response.submission.id);
  } catch (error) {
    setBanner(error.message, 'error');
  }
});

loadRows().catch((error) => setBanner(error.message, 'error'));
