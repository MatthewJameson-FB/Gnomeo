const statusOptions = ['new', 'contacted', 'workspace_created', 'declined'];

const els = {
  summary: document.getElementById('summary'),
  list: document.getElementById('list'),
  portalReviews: document.getElementById('portalReviews'),
  reloadBtn: document.getElementById('reloadBtn'),
};

const state = {
  requests: [],
  portalReviews: [],
  portalById: {},
  busyById: {},
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

function copyToClipboard(text) {
  if (!text) return Promise.reject(new Error('No portal link available.'));
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  return ok ? Promise.resolve() : Promise.reject(new Error('Copy failed.'));
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
    `<span class="summary-chip">Portal reviews: ${esc(state.portalReviews.length)}</span>`,
  ].join('');
}

function renderPortalReviews() {
  if (!state.portalReviews.length) {
    els.portalReviews.innerHTML = '<div class="empty-state">No portal reviews yet.</div>';
    return;
  }
  els.portalReviews.innerHTML = state.portalReviews.map((review) => `
    <div class="portal-box" style="margin-bottom: 10px;">
      <div><strong>${esc(review.status || 'received')}</strong> · ${esc(fmtDate(review.created_at))}</div>
      <div class="portal-note" style="margin-top: 6px;">Workspace: ${esc(review.workspace_id || '—')} · Files: ${esc((Array.isArray(review.filenames) ? review.filenames : []).join(', ') || '—')} · Platforms: ${esc((Array.isArray(review.platforms) ? review.platforms : []).join(' · ') || '—')}</div>
      <div class="portal-note">${review.report_run_id ? 'Report ready' : 'Waiting for processing'}</div>
    </div>
  `).join('');
}

function portalPanel(request) {
  const portal = state.portalById[request.id];
  const link = portal?.url || portal?.portal_url || '';
  if (!link) return '';
  return `
    <div class="portal-box">
      <div><strong>Private portal link</strong></div>
      <a class="portal-link" href="${esc(link)}" target="_blank" rel="noreferrer">${esc(link)}</a>
      <div class="portal-actions">
        <button class="secondary" type="button" data-copy-portal="${esc(request.id)}">Copy portal link</button>
        <span class="portal-note">Send this private link to the customer. Do not publish it.</span>
      </div>
    </div>
  `;
}

function render() {
  renderSummary();
  renderPortalReviews();
  if (!state.requests.length) {
    els.list.innerHTML = '<div class="empty-state">No beta requests yet.</div>';
    return;
  }

  els.list.innerHTML = state.requests.map((request) => {
    const actionLabel = request.status === 'workspace_created' || request.workspace_id
      ? 'Regenerate portal link'
      : 'Create workspace + portal link';
    const isBusy = Boolean(state.busyById[request.id]);
    const createdWorkspaceNote = request.status === 'workspace_created'
      ? '<div class="portal-note" style="margin-top:10px;">Workspace created. Use regenerate only if you need a fresh portal link, or check the workspace manually.</div>'
      : '';
    return `
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
          ${request.workspace_id ? `<div><strong>Workspace:</strong> ${esc(request.workspace_id)}</div>` : ''}
        </div>
        ${request.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(request.notes)}</div>` : ''}
        ${portalPanel(request)}
        ${createdWorkspaceNote}
        <div class="status-row">
          <label>
            Update status
            <select data-status-for="${esc(request.id)}" ${isBusy ? 'disabled' : ''}>
              ${statusOptions.map((status) => `<option value="${status}" ${status === request.status ? 'selected' : ''}>${status}</option>`).join('')}
            </select>
          </label>
          <button class="secondary" type="button" data-save-status="${esc(request.id)}" ${isBusy ? 'disabled' : ''}>Save status</button>
          <button class="secondary" type="button" data-create-workspace="${esc(request.id)}" ${isBusy ? 'disabled' : ''}>${esc(actionLabel)}</button>
        </div>
        <div class="portal-note">Create the workspace manually, then send the private link.</div>
      </article>
    `;
  }).join('');

  els.list.querySelectorAll('[data-save-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const requestId = button.getAttribute('data-save-status');
      const select = Array.from(els.list.querySelectorAll('[data-status-for]')).find((el) => el.getAttribute('data-status-for') === requestId);
      if (!requestId || !select) return;
      state.busyById[requestId] = true;
      render();
      try {
        const response = await fetch('/api/admin/beta-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update-status', id: requestId, status: select.value }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to update status.');
        state.requests = state.requests.map((item) => (item.id === requestId ? payload.request : item));
        state.portalReviews = Array.isArray(payload.portal_reviews) ? payload.portal_reviews : state.portalReviews;
        render();
      } catch (error) {
        alert(error?.message || 'Failed to update status.');
      } finally {
        delete state.busyById[requestId];
        render();
      }
    });
  });

  els.list.querySelectorAll('[data-create-workspace]').forEach((button) => {
    button.addEventListener('click', async () => {
      const requestId = button.getAttribute('data-create-workspace');
      if (!requestId) return;
      const request = state.requests.find((item) => item.id === requestId);
      const confirmed = request?.workspace_id
        ? window.confirm('This will regenerate the portal link for this beta request. Continue?')
        : window.confirm('Create a workspace and private portal link for this beta request?');
      if (!confirmed) return;

      state.busyById[requestId] = true;
      render();
      try {
        const response = await fetch('/api/admin/beta-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create-workspace', id: requestId }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to create workspace.');
        state.requests = state.requests.map((item) => (item.id === requestId ? payload.request : item));
        state.portalById[requestId] = payload.portal;
        await loadRequests(false);
        state.portalById[requestId] = payload.portal;
        render();
      } catch (error) {
        alert(error?.message || 'Failed to create workspace.');
      } finally {
        delete state.busyById[requestId];
        render();
      }
    });
  });

  els.list.querySelectorAll('[data-copy-portal]').forEach((button) => {
    button.addEventListener('click', async () => {
      const requestId = button.getAttribute('data-copy-portal');
      const portal = state.portalById[requestId];
      try {
        await copyToClipboard(portal?.url || portal?.portal_url || '');
        button.textContent = 'Copied';
        setTimeout(() => render(), 700);
      } catch (error) {
        alert(error?.message || 'Copy failed.');
      }
    });
  });
}

async function loadRequests(renderNow = true) {
  const response = await fetch('/api/admin/beta-requests');
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || 'Failed to load beta requests.');
  }
  state.requests = Array.isArray(payload.requests) ? payload.requests : [];
  state.portalReviews = Array.isArray(payload.portal_reviews) ? payload.portal_reviews : [];
  if (renderNow) render();
}

els.reloadBtn.addEventListener('click', () => {
  loadRequests().catch((error) => alert(error?.message || 'Failed to reload beta requests.'));
});

loadRequests().catch((error) => {
  els.list.innerHTML = `<div class="empty-state">${esc(error?.message || 'Failed to load beta requests.')}</div>`;
  if (els.portalReviews) els.portalReviews.innerHTML = '<div class="empty-state">Failed to load portal reviews.</div>';
});
