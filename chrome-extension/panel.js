(() => {
  const $ = (id) => document.getElementById(id);

  const EMPTY_ANALYSIS = {
    mode: 'empty',
    success: false,
    platform: 'Local only',
    tableKind: 'none',
    rowsDetected: 0,
    columnsDetected: 0,
    metricColumns: [],
    reviewConfidence: 'Visible rows only · session-only prototype',
    previewRows: [],
    summary: {
      executiveFinding: 'Open a visible campaign table, then click Add visible table.',
      keySignals: [],
      attention: [
        'Gnomeo only reviews visible tables you choose to add.',
        'Nothing is captured in the background, sent, or stored yet.',
        'Try another campaign table if this page is not the right one.',
      ],
      privacyNote: 'Gnomeo only reviews visible tables you choose to add. Nothing is captured in the background, sent, or stored in this prototype.',
    },
    sources: [],
  };

  let pendingRequestId = null;
  let capturedTables = [];
  let currentAnalysis = EMPTY_ANALYSIS;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]|'/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const formatNumber = (value, digits = 0) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(num);
  };

  const formatTime = (value) => {
    if (!Number.isFinite(Number(value))) return '—';
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  };

  const uniquePlatforms = (items) => [...new Set(items.filter(Boolean))];

  const getMetric = (capture, key) => Number.isFinite(capture?.snapshot?.[key]) ? capture.snapshot[key] : null;

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
      return '<div class="preview-item"><strong>No safe preview yet</strong><span>Add a visible table to see a local preview.</span></div>';
    }
    return rows.map((row) => {
      const source = row.source ? `<span class="source-pill">${escapeHtml(row.source)}</span>` : '';
      return `
      <div class="preview-item">
        <div class="preview-head">
          <strong>${escapeHtml(row.label || 'Row')}</strong>
          ${source}
        </div>
        ${Array.isArray(row.metrics) && row.metrics.length ? `<span>${escapeHtml(row.metrics.join(' · '))}</span>` : ''}
        ${Array.isArray(row.cells) && row.cells.length ? `<div class="row-metrics">${row.cells.slice(0, 3).map((cell) => `<span class="mini-chip">${escapeHtml(cell)}</span>`).join('')}</div>` : ''}
      </div>
    `;
    }).join('');
  };

  const renderCapturedTables = () => {
    const container = $('capturedList');
    const countChip = $('bundleCount');
    const hint = $('bundleHint');
    const analyseNow = $('analyseNow');
    const analyseCapturedTables = $('analyseCapturedTables');

    countChip.textContent = `${capturedTables.length} captured`;
    analyseNow.disabled = capturedTables.length === 0;
    analyseCapturedTables.disabled = capturedTables.length === 0;

    if (!capturedTables.length) {
      container.innerHTML = '<div class="captured-item"><strong>No captured tables yet</strong><span>Add a visible table from Google Ads, Meta Ads, or LinkedIn Ads.</span></div>';
      hint.textContent = 'Add visible tables from one or more platforms, then analyse them together.';
      return;
    }

    container.innerHTML = capturedTables.map((capture) => `
      <div class="captured-item">
        <strong>${escapeHtml(capture.platform)} — ${escapeHtml(formatNumber(capture.rowsDetected || 0))} rows, ${escapeHtml(formatNumber((capture.metricColumns || []).length))} metric columns</strong>
        <span>${escapeHtml(formatTime(capture.capturedAt))} · ${escapeHtml(formatNumber(capture.columnsDetected || 0))} columns · ${escapeHtml(capture.reviewConfidence || 'Visible rows only')}</span>
      </div>
    `).join('');

    hint.textContent = 'Open another ad platform campaign table, then click Add visible table again.';
  };

  const setStatus = (text) => {
    $('captureStatus').textContent = text;
  };

  const setAnalysis = (analysis) => {
    currentAnalysis = analysis || EMPTY_ANALYSIS;
    const summary = currentAnalysis.summary || EMPTY_ANALYSIS.summary;

    $('sourceChip').textContent = currentAnalysis.mode === 'bundle'
      ? `${currentAnalysis.sources.length} tables`
      : currentAnalysis.mode === 'single'
        ? currentAnalysis.platform || 'Local only'
        : 'Local only';

    const meta = [];
    if (currentAnalysis.success) {
      if (currentAnalysis.mode === 'bundle') {
        meta.push(`<span class="chip">Captured tables: ${escapeHtml(formatNumber(currentAnalysis.sources.length || 0))}</span>`);
        meta.push(`<span class="chip">Platforms: ${escapeHtml(currentAnalysis.platforms.join(', ') || '—')}</span>`);
      } else {
        meta.push(`<span class="chip">${escapeHtml(currentAnalysis.platform || 'Unknown platform')}</span>`);
        meta.push(`<span class="chip">Rows detected: ${escapeHtml(formatNumber(currentAnalysis.rowsDetected || 0))}</span>`);
        meta.push(`<span class="chip">Columns detected: ${escapeHtml(formatNumber(currentAnalysis.columnsDetected || 0))}</span>`);
        if (Array.isArray(currentAnalysis.metricColumns) && currentAnalysis.metricColumns.length) meta.push(`<span class="chip">Metric columns: ${escapeHtml(currentAnalysis.metricColumns.join(', '))}</span>`);
      }
      meta.push(`<span class="chip">${escapeHtml(currentAnalysis.reviewConfidence || 'Visible rows only · session-only prototype')}</span>`);
    } else {
      meta.push('<span class="chip">Local only</span>');
      meta.push('<span class="chip">Visible rows only</span>');
    }
    $('metaRow').innerHTML = meta.join('');
    $('topFinding').textContent = summary.executiveFinding || EMPTY_ANALYSIS.summary.executiveFinding;
    $('keySignals').innerHTML = renderLines(summary.keySignals, 'No visible signals found yet.');
    $('visiblePreview').innerHTML = renderPreview(currentAnalysis.previewRows);
    $('attentionList').innerHTML = renderLines(summary.attention, 'No attention notes yet.');
    $('reviewConfidence').textContent = currentAnalysis.reviewConfidence || EMPTY_ANALYSIS.reviewConfidence;
    $('privacyNote').textContent = summary.privacyNote || EMPTY_ANALYSIS.summary.privacyNote;
  };

  const normaliseCapture = (payload) => ({
    mode: 'single',
    success: true,
    platform: payload.platform || 'Local only',
    tableKind: payload.tableKind || 'table',
    rowsDetected: payload.rowsDetected || 0,
    columnsDetected: payload.columnsDetected || 0,
    metricColumns: Array.isArray(payload.metricColumns) ? payload.metricColumns : [],
    reviewConfidence: payload.reviewConfidence || 'Visible rows only · session-only prototype',
    previewRows: Array.isArray(payload.previewRows) ? payload.previewRows.slice(0, 5) : [],
    summary: payload.summary || EMPTY_ANALYSIS.summary,
    snapshot: payload.snapshot || null,
    capturedAt: Date.now(),
  });

  const buildSingleReview = (capture) => {
    if (!capture) return EMPTY_ANALYSIS;
    return {
      mode: 'single',
      success: true,
      platform: capture.platform,
      tableKind: capture.tableKind,
      rowsDetected: capture.rowsDetected,
      columnsDetected: capture.columnsDetected,
      metricColumns: capture.metricColumns,
      reviewConfidence: capture.reviewConfidence,
      previewRows: capture.previewRows,
      summary: {
        executiveFinding: capture.summary?.executiveFinding || `${capture.platform} is ready for a spot check.`,
        keySignals: [
          { label: 'Captured source', title: capture.platform, details: `${formatNumber(capture.rowsDetected || 0)} rows · ${formatNumber(capture.columnsDetected || 0)} columns` },
          ...(capture.summary?.keySignals || []).slice(0, 3),
        ],
        attention: capture.summary?.attention || ['Treat this as a visible-row spot check, not a full account review.'],
        privacyNote: capture.summary?.privacyNote || EMPTY_ANALYSIS.summary.privacyNote,
      },
      sources: [capture],
      platforms: [capture.platform],
    };
  };

  const buildBundleReview = (captures) => {
    if (!captures.length) return EMPTY_ANALYSIS;

    const spendCandidate = captures
      .map((capture) => ({ capture, value: getMetric(capture, 'spendValue') }))
      .filter((item) => Number.isFinite(item.value))
      .sort((a, b) => b.value - a.value)[0] || null;

    const conversionCandidate = captures
      .map((capture) => ({ capture, value: getMetric(capture, 'conversionValue') }))
      .filter((item) => Number.isFinite(item.value))
      .sort((a, b) => b.value - a.value)[0] || null;

    const roasCandidate = captures
      .map((capture) => ({ capture, value: getMetric(capture, 'roasValue') }))
      .filter((item) => Number.isFinite(item.value))
      .sort((a, b) => b.value - a.value)[0] || null;

    const efficiencyScore = (capture) => {
      const roas = getMetric(capture, 'roasValue');
      if (Number.isFinite(roas)) return roas;
      const spend = getMetric(capture, 'spendValue');
      const conversions = getMetric(capture, 'conversionValue');
      if (Number.isFinite(spend) && spend > 0 && Number.isFinite(conversions)) return conversions / spend;
      const watchSpend = getMetric(capture, 'watchSpendValue');
      const watchConversions = getMetric(capture, 'watchConversionValue');
      if (Number.isFinite(watchSpend) && watchSpend > 0 && Number.isFinite(watchConversions)) return watchConversions / watchSpend;
      return null;
    };

    const watchCandidate = captures
      .map((capture) => ({ capture, score: efficiencyScore(capture) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => a.score - b.score)[0]
      || spendCandidate;

    const platforms = uniquePlatforms(captures.map((capture) => capture.platform));
    const previewRows = captures.flatMap((capture) => capture.previewRows.slice(0, 2).map((row) => ({ ...row, source: capture.platform }))).slice(0, 5);

    const keySignals = [];
    if (spendCandidate) {
      keySignals.push({
        label: 'Highest visible spend',
        title: `${spendCandidate.capture.platform} — ${spendCandidate.capture.snapshot?.spendLabel || spendCandidate.capture.platform}`,
        details: `${formatNumber(spendCandidate.value, 2)} visible spend`,
      });
    }
    if (conversionCandidate) {
      keySignals.push({
        label: 'Strongest visible result signal',
        title: `${conversionCandidate.capture.platform} — ${conversionCandidate.capture.snapshot?.conversionLabel || conversionCandidate.capture.platform}`,
        details: `${formatNumber(conversionCandidate.value, 0)} visible results`,
      });
    }
    if (roasCandidate) {
      keySignals.push({
        label: 'Best visible ROAS signal',
        title: `${roasCandidate.capture.platform} — ${roasCandidate.capture.snapshot?.roasLabel || roasCandidate.capture.platform}`,
        details: `ROAS ${formatNumber(roasCandidate.value, 2)}x`,
      });
    }
    if (watchCandidate) {
      const score = efficiencyScore(watchCandidate.capture);
      const watchLabel = watchCandidate.capture.snapshot?.watchLabel || watchCandidate.capture.platform;
      keySignals.push({
        label: 'Weakest visible efficiency',
        title: `${watchCandidate.capture.platform} — ${watchLabel}`,
        details: Number.isFinite(score) ? `Efficiency score ${formatNumber(score, 2)}` : 'Visible spend with limited efficiency signal',
      });
    }
    keySignals.push({
      label: 'Captured platforms',
      title: platforms.join(' · '),
      details: `${captures.length} captured tables in this session`,
    });
    keySignals.push({
      label: 'Review confidence',
      title: 'Visible rows only',
      details: 'Session-only prototype',
    });

    const summaryParts = [];
    if (spendCandidate) summaryParts.push(`${spendCandidate.capture.platform} — ${spendCandidate.capture.snapshot?.spendLabel || spendCandidate.capture.platform} carries the highest visible spend`);
    if (conversionCandidate) summaryParts.push(`${conversionCandidate.capture.platform} — ${conversionCandidate.capture.snapshot?.conversionLabel || conversionCandidate.capture.platform} shows the strongest visible result signal`);
    if (roasCandidate) summaryParts.push(`${roasCandidate.capture.platform} — ${roasCandidate.capture.snapshot?.roasLabel || roasCandidate.capture.platform} has the best visible ROAS signal`);
    if (watchCandidate) summaryParts.push(`${watchCandidate.capture.platform} — ${watchCandidate.capture.snapshot?.watchLabel || watchCandidate.capture.platform} is the watch item`);

    const topFinding = summaryParts.length
      ? `${summaryParts.join('; ')}. Treat this as a spot check because only visible rows were reviewed.`
      : 'Captured tables are ready, but the visible rows are too limited for a stronger cross-platform read.';

    const attention = [
      spendCandidate ? `Review ${spendCandidate.capture.platform} first.` : 'Review the highest-signal platform first.',
      conversionCandidate ? `Protect ${conversionCandidate.capture.platform} from accidental cuts.` : 'Protect the strongest visible result signal from accidental cuts.',
      'Treat this as a visible-row spot check, not a full account review.',
    ];

    return {
      mode: 'bundle',
      success: true,
      platform: 'Captured tables',
      tableKind: 'bundle',
      rowsDetected: captures.reduce((sum, capture) => sum + (capture.rowsDetected || 0), 0),
      columnsDetected: captures.reduce((sum, capture) => sum + (capture.columnsDetected || 0), 0),
      metricColumns: uniquePlatforms(captures.flatMap((capture) => capture.metricColumns || [])),
      reviewConfidence: 'Visible rows only · session-only prototype',
      previewRows,
      summary: {
        executiveFinding: topFinding,
        keySignals,
        attention,
        privacyNote: EMPTY_ANALYSIS.summary.privacyNote,
      },
      sources: captures,
      platforms,
    };
  };

  const addVisibleTable = () => {
    if (pendingRequestId) return;
    pendingRequestId = (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    $('addVisibleTable').textContent = 'Adding…';
    $('addVisibleTable').disabled = true;
    $('topFinding').textContent = 'Reading the visible table…';
    setStatus('Gnomeo is reading the visible table you chose to add.');
    window.parent.postMessage({ type: 'gnomeo-review-visible-table-request', requestId: pendingRequestId }, '*');
  };

  const analyseNow = () => {
    if (!capturedTables.length) {
      setStatus('Add a visible table first.');
      return;
    }
    setAnalysis(buildSingleReview(capturedTables[capturedTables.length - 1]));
    setStatus(`${capturedTables[capturedTables.length - 1].platform} analysed. Add another platform if you want to compare more sources.`);
  };

  const analyseCapturedTables = () => {
    if (!capturedTables.length) {
      setStatus('Add a visible table first.');
      return;
    }
    setAnalysis(buildBundleReview(capturedTables));
    setStatus(`Analysed ${capturedTables.length} captured tables together.`);
  };

  const addAnotherPlatform = () => {
    $('bundleHint').textContent = 'Open another ad platform campaign table, then click Add visible table again.';
    setStatus('Open another ad platform campaign table, then click Add visible table again.');
  };

  const clearCapturedTables = () => {
    pendingRequestId = null;
    capturedTables = [];
    setAnalysis(EMPTY_ANALYSIS);
    renderCapturedTables();
    $('addVisibleTable').textContent = 'Add visible table';
    $('addVisibleTable').disabled = false;
    setStatus('Captured tables cleared. Start again with Add visible table.');
  };

  const boot = () => {
    const close = $('closePanel');
    const addButton = $('addVisibleTable');
    const analyseNowButton = $('analyseNow');
    const analyseCapturedTablesButton = $('analyseCapturedTables');
    const addAnotherPlatformButton = $('addAnotherPlatform');
    const clearCapturedTablesButton = $('clearCapturedTables');
    const clearReviewButton = $('clearReview');

    setAnalysis(EMPTY_ANALYSIS);
    renderCapturedTables();

    close?.addEventListener('click', () => {
      window.parent.postMessage({ type: 'gnomeo-close' }, '*');
    });

    addButton?.addEventListener('click', addVisibleTable);
    analyseNowButton?.addEventListener('click', analyseNow);
    analyseCapturedTablesButton?.addEventListener('click', analyseCapturedTables);
    addAnotherPlatformButton?.addEventListener('click', addAnotherPlatform);
    clearCapturedTablesButton?.addEventListener('click', clearCapturedTables);
    clearReviewButton?.addEventListener('click', clearCapturedTables);

    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type !== 'gnomeo-visible-table-result') return;
      if (pendingRequestId && data.requestId && data.requestId !== pendingRequestId) return;
      pendingRequestId = null;
      addButton.textContent = 'Add visible table';
      addButton.disabled = false;

      const payload = data.payload || EMPTY_ANALYSIS;
      if (!payload.success) {
        setStatus(payload.summary?.executiveFinding || 'Gnomeo could not find a visible campaign table on this page.');
        if (!capturedTables.length) {
          setAnalysis({
            ...EMPTY_ANALYSIS,
            summary: {
              ...EMPTY_ANALYSIS.summary,
              executiveFinding: payload.summary?.executiveFinding || EMPTY_ANALYSIS.summary.executiveFinding,
              attention: payload.summary?.attention || EMPTY_ANALYSIS.summary.attention,
              privacyNote: payload.summary?.privacyNote || EMPTY_ANALYSIS.summary.privacyNote,
            },
          });
        }
        return;
      }

      const capture = normaliseCapture(payload);
      capturedTables.push(capture);
      renderCapturedTables();
      setAnalysis(buildSingleReview(capture));
      setStatus(`${capture.platform} table added to this review.`);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
