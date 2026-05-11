const statusOptions = ['new', 'contacted', 'workspace_created', 'declined'];

const els = {
  summary: document.getElementById('summary'),
  list: document.getElementById('list'),
  reloadBtn: document.getElementById('reloadBtn'),
};

const state = {
  requests: [],
};

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

function badge(value) {
  return `<span class="badge ${esc(String(value || 'new').toLowerCase())}">${esc(value || 'new')}</span>`;
}

function spendLabel(value) {
  const map = {
    'under-5k': 'Under 5k',
    '5k-20k': '5k–20k',
    '20k-50k': '20k–50k',
    '50k-plus': '50k+',
    'prefer-not-to-say': 'Prefer not to say',
  };
  return map[value] || value || '—';
}

function renderSummary() {
  const counts = state.requests.reduce((acc, row) => {
    acc[row.status || 'new'] = (acc[row.status || 'new'] || 0) + 1;
    return acc;
  }, {});
  els.summary.innerHTML = [
    `<span class="summary-chip">Total: ${esc(state.requests.length)}</span>`,
    `<span class="summary-chip">New: ${esc(counts.new || 0)}</span>`,
    `<span class="summary-chip">Contacted: ${esc(counts.contacted || 0)}</span>`,
    `<span class="summary-chip">Workspace created: ${esc(counts.workspace_created || 0)}</span>`,
    `<span class="summary-chip">Declined: ${esc(counts.declined || 0)}</span>`,
  ].join('');
}

function render() {
  renderSummary();
  if (!state.requests.length) {
    els.list.innerHTML = '<div class="empty-state">No beta requests yet.</div>';
    return;
  }

  els.list.innerHTML = state.requests.map((request) => `
    <article class="card beta-card">
      <h3>${esc(request.name || 'Unnamed request')}</h3>
      <div class="meta-row">
        <span class="meta-pill">${esc(fmtDate(request.created_at))}</span>
        <span class="meta-pill">${esc(request.company || '—')}</span>
        <span class="meta-pill">${esc(request.website || '—')}</span>
        <span class="meta-pill">${esc((Array.isArray(request.platforms) ? request.platforms : []).join(' · ') || '—')}</span>
        <span class="meta-pill">${esc(spendLabel(request.monthly_spend_range))}</span>
        <span class="meta-pill">Agency: ${request.is_agency ? 'Yes' : 'No'}</span>
      </div>
      <div class="detail">
        <div><strong>Email:</strong> ${esc(request.email || '—')}</div>
        <div><strong>Review goal:</strong> ${esc(request.review_goal || '—')}</div>
        <div><strong>Consent:</strong> ${esc(fmtDate(request.consent_at))}</div>
        <div><strong>Status:</strong> ${badge(request.status)}</div>
      </div>
      ${request.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(request.notes)}</div>` : ''}
      <div class="status-row">
        <label>
          Update status
          <select data-status-for="${esc(request.id)}">
            ${statusOptions.map((status) => `<option value="${status}" ${status === request.status ? 'selected' : ''}>${status}</option>`).join('')}
          </select>
        </label>
        <button class="secondary" type="button" data-save-status="${esc(request.id)}">Save status</button>
        <span class="subtle">Create workspace manually, then send the portal link.</span>
      </div>
    </article>
  `).join('');

  els.list.querySelectorAll('[data-save-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const requestId = button.getAttribute('data-save-status');
      const select = Array.from(els.list.querySelectorAll('[data-status-for]')).find((el) => el.getAttribute('data-status-for') === requestId);
      if (!requestId || !select) return;
      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = 'Saving…';
      try {
        const response = await fetch('/api/admin/beta-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update-status', id: requestId, status: select.value }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || 'Failed to update status.');
        }
        await loadRequests();
      } catch (error) {
        alert(error?.message || 'Failed to update status.');
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
  });
}

async function loadRequests() {
  const response = await fetch('/api/admin/beta-requests');
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || 'Failed to load beta requests.');
  }
  state.requests = Array.isArray(payload.requests) ? payload.requests : [];
  render();
}

els.reloadBtn.addEventListener('click', () => {
  loadRequests().catch((error) => alert(error?.message || 'Failed to reload beta requests.'));
});

loadRequests().catch((error) => {
  els.list.innerHTML = `<div class="empty-state">${esc(error?.message || 'Failed to load beta requests.')}</div>`;
});
