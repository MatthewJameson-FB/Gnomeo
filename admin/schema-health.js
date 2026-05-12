const els = {
  reloadBtn: document.getElementById('reloadBtn'),
  overallStatus: document.getElementById('overallStatus'),
  overallNote: document.getElementById('overallNote'),
  dbStatus: document.getElementById('dbStatus'),
  missingList: document.getElementById('missingList'),
  envList: document.getElementById('envList'),
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function labelFor(value) {
  return value ? '<span style="color:#12b76a;font-weight:700;">Ready</span>' : '<span style="color:#f04438;font-weight:700;">Missing</span>';
}

function renderEnv(env = {}) {
  const rows = [
    ['Supabase URL', env.supabase_url],
    ['Supabase service role key', env.service_role],
    ['Admin secret', env.admin_secret],
    ['Resend API key', env.resend_api_key],
    ['Admin email', env.admin_email],
  ];
  els.envList.innerHTML = rows.map(([name, ok]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);"><span>${esc(name)}</span>${labelFor(ok)}</div>`).join('');
}

function renderMissing(missing = []) {
  if (!missing.length) {
    els.missingList.innerHTML = '<div class="notice" style="display:inline-flex;">No missing schema detected.</div>';
    return;
  }
  els.missingList.innerHTML = missing.map((item) => {
    const kind = item.kind || 'column';
    const column = item.column ? String(item.column) : '—';
    return `<div style="padding:10px 0;border-bottom:1px solid var(--border);"><strong>${esc(item.table || 'unknown')}</strong><div class="subtle">Missing ${esc(kind)}: ${esc(column)}</div></div>`;
  }).join('');
}

async function loadSchemaHealth() {
  els.overallStatus.textContent = 'Checking schema…';
  els.overallNote.textContent = 'Loading required table and column checks.';
  els.dbStatus.textContent = 'Loading…';
  els.missingList.innerHTML = '';
  els.envList.textContent = 'Loading…';

  try {
    const response = await fetch('/api/admin?action=schema-health', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || 'Schema health check failed.');

    const ok = Boolean(payload.ok);
    els.overallStatus.innerHTML = ok ? 'Beta readiness: Ready' : 'Beta readiness: Missing schema';
    els.overallNote.textContent = payload.schema_checks_skipped
      ? 'Schema checks were skipped because Supabase env vars are missing.'
      : (ok ? 'Required schema and env vars are present.' : 'Apply the latest migration before testing customer portals.');
    els.dbStatus.innerHTML = payload.schema_checks_skipped
      ? '<span style="color:#f79009;font-weight:700;">Checks skipped</span>'
      : (ok ? '<span style="color:#12b76a;font-weight:700;">Ready</span>' : '<span style="color:#f04438;font-weight:700;">Missing schema</span>');
    renderMissing(Array.isArray(payload.missing) ? payload.missing : []);
    renderEnv(payload.env || {});
  } catch (error) {
    els.overallStatus.textContent = 'Beta readiness: Unable to check';
    els.overallNote.textContent = error?.message || 'Failed to load schema health.';
    els.dbStatus.innerHTML = '<span style="color:#f04438;font-weight:700;">Unavailable</span>';
    els.missingList.innerHTML = '<div class="subtle">Unable to load schema data.</div>';
    els.envList.innerHTML = '<div class="subtle">Unable to load env status.</div>';
  }
}

els.reloadBtn.addEventListener('click', () => {
  loadSchemaHealth();
});

loadSchemaHealth();
