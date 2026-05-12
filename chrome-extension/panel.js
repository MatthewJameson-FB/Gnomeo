(() => {
  const $ = (id) => document.getElementById(id);

  const EMPTY_STATE = {
    success: false,
    platform: 'Local only',
    tableKind: 'none',
    rowsDetected: 0,
    columnsDetected: 0,
    metricColumns: [],
    reviewConfidence: 'Limited — visible rows only',
    previewRows: [],
    summary: {
      executiveFinding: 'Open a visible campaign table, then click Review visible table.',
      keySignals: [],
      attention: [
        'Gnomeo only reads the visible page after you ask.',
        'Nothing is sent or stored yet.',
        'Try opening a campaign table, changing the date range, or using paste/upload.',
      ],
      comparison: ['No visible review has been captured yet in this panel session.'],
      privacyNote: 'This prototype only reads the visible page after you click Review visible table. Nothing is sent or stored yet.',
    },
    snapshot: null,
  };

  let pendingRequestId = null;
  let lastSnapshot = null;
  let currentReview = EMPTY_STATE;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const formatNumber = (value, digits = 0) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(num);
  };

  const renderLines = (items, emptyLabel, kind = 'bullet') => {
    if (!items || !items.length) {
      return `<div class="${kind}-item"><strong>${escapeHtml(emptyLabel)}</strong><span>Keep the table visible and try again.</span></div>`;
    }
    return items.map((item) => {
      if (typeof item === 'string') {
        return `<div class="${kind}-item"><strong>${escapeHtml(item)}</strong></div>`;
      }
      return `<div class="${kind}-item"><strong>${escapeHtml(item.label || item.title || '')}</strong>${item.details ? `<span>${escapeHtml(item.details)}</span>` : ''}</div>`;
    }).join('');
  };

  const renderPreview = (rows) => {
    if (!rows || !rows.length) {
      return '<div class="preview-item"><strong>No safe preview yet</strong><span>Open a visible campaign table and click Review visible table.</span></div>';
    }
    return rows.map((row) => `
      <div class="preview-item">
        <strong>${escapeHtml(row.label || 'Row')}</strong>
        ${Array.isArray(row.metrics) && row.metrics.length ? `<span>${escapeHtml(row.metrics.join(' · '))}</span>` : ''}
        ${Array.isArray(row.cells) && row.cells.length ? `<div class="row-metrics">${row.cells.slice(0, 3).map((cell) => `<span class="mini-chip">${escapeHtml(cell)}</span>`).join('')}</div>` : ''}
      </div>
    `).join('');
  };

  const renderComparison = (review, previousSnapshot) => {
    const snapshot = review?.snapshot || null;
    const previous = previousSnapshot || null;
    if (!previous) return review?.summary?.comparison || ['This is the first visible-page review in this panel session.'];

    const lines = [];
    const rowsDelta = Number.isFinite(snapshot?.rowsDetected) && Number.isFinite(previous?.rowsDetected) ? snapshot.rowsDetected - previous.rowsDetected : null;
    const spendDelta = Number.isFinite(snapshot?.spendValue) && Number.isFinite(previous?.spendValue) ? snapshot.spendValue - previous.spendValue : null;
    const conversionDelta = Number.isFinite(snapshot?.conversionValue) && Number.isFinite(previous?.conversionValue) ? snapshot.conversionValue - previous.conversionValue : null;

    if (Number.isFinite(rowsDelta) && rowsDelta !== 0) lines.push(`Visible rows ${rowsDelta > 0 ? 'increased' : 'decreased'} by ${Math.abs(rowsDelta)}.`);
    if (Number.isFinite(spendDelta) && spendDelta !== 0) lines.push(`Highest visible spend moved ${spendDelta > 0 ? 'up' : 'down'} by ${formatNumber(Math.abs(spendDelta), 2)}.`);
    if (Number.isFinite(conversionDelta) && conversionDelta !== 0) lines.push(`Strongest visible conversion signal changed by ${formatNumber(Math.abs(conversionDelta), 0)}.`);
    if (!lines.length) lines.push('The visible-page pattern looks similar to the last review in this panel session.');
    return lines.slice(0, 3);
  };

  const setReviewState = (review, previousSnapshot = lastSnapshot) => {
    currentReview = review || EMPTY_STATE;
    const summary = currentReview.summary || EMPTY_STATE.summary;
    $('sourceChip').textContent = currentReview.success ? (currentReview.platform || 'Local only') : 'Local only';

    const meta = [];
    if (currentReview.success) {
      meta.push(`<span class="chip">${escapeHtml(currentReview.platform || 'Unknown platform')}</span>`);
      meta.push(`<span class="chip">Rows detected: ${escapeHtml(formatNumber(currentReview.rowsDetected || 0))}</span>`);
      meta.push(`<span class="chip">Columns detected: ${escapeHtml(formatNumber(currentReview.columnsDetected || 0))}</span>`);
      if (Array.isArray(currentReview.metricColumns) && currentReview.metricColumns.length) meta.push(`<span class="chip">Metric columns: ${escapeHtml(currentReview.metricColumns.join(', '))}</span>`);
      meta.push(`<span class="chip">${escapeHtml(currentReview.reviewConfidence || 'Limited — visible rows only')}</span>`);
    } else {
      meta.push(`<span class="chip">Local only</span>`);
      meta.push(`<span class="chip">Visible rows only</span>`);
    }
    $('metaRow').innerHTML = meta.join('');
    $('topFinding').textContent = summary.executiveFinding || EMPTY_STATE.summary.executiveFinding;
    $('keySignals').innerHTML = renderLines(summary.keySignals, 'No visible signals found yet.');
    $('visiblePreview').innerHTML = renderPreview(currentReview.previewRows);
    $('attentionList').innerHTML = renderLines(summary.attention, 'No attention notes yet.');
    $('comparisonList').innerHTML = renderLines(renderComparison(currentReview, previousSnapshot), 'No comparison notes yet.');
    $('privacyNote').textContent = summary.privacyNote || EMPTY_STATE.summary.privacyNote;
  };

  const requestReview = () => {
    if (pendingRequestId) return;
    pendingRequestId = (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    $('reviewVisibleTable').textContent = 'Reviewing…';
    $('reviewVisibleTable').disabled = true;
    $('topFinding').textContent = 'Reviewing the visible table…';
    window.parent.postMessage({ type: 'gnomeo-review-visible-table-request', requestId: pendingRequestId }, '*');
  };

  const clearCurrent = () => {
    pendingRequestId = null;
    lastSnapshot = null;
    setReviewState(EMPTY_STATE);
    $('reviewVisibleTable').textContent = 'Review visible table';
    $('reviewVisibleTable').disabled = false;
  };

  const boot = () => {
    const close = $('closePanel');
    const reviewButton = $('reviewVisibleTable');
    const clearButton = $('clearReview');

    setReviewState(EMPTY_STATE);

    close?.addEventListener('click', () => {
      window.parent.postMessage({ type: 'gnomeo-close' }, '*');
    });

    reviewButton?.addEventListener('click', requestReview);
    clearButton?.addEventListener('click', clearCurrent);

    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type !== 'gnomeo-visible-table-result') return;
      if (pendingRequestId && data.requestId && data.requestId !== pendingRequestId) return;
      pendingRequestId = null;
      $('reviewVisibleTable').textContent = 'Review visible table';
      $('reviewVisibleTable').disabled = false;
      const payload = data.payload || EMPTY_STATE;
      const previousSnapshot = lastSnapshot;
      currentReview = payload;
      lastSnapshot = payload.snapshot || null;
      setReviewState(payload, previousSnapshot);
      if (!payload.success) {
        $('reviewVisibleTable').focus();
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
