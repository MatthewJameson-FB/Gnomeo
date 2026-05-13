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
        'Nothing is captured in the background, sent, or stored beyond this session.',
        'Try another campaign table if this page is not the right one.',
      ],
      privacyNote: 'Gnomeo only reviews visible tables you choose to add. Nothing is captured in the background, sent, or stored beyond this session.',
    },
    sources: [],
  };

  let pendingRequestId = null;
  let capturedTables = [];
  let currentAnalysis = EMPTY_ANALYSIS;
  const STORAGE_KEY = 'gnomeo-captured-tables';
  const sessionStorageApi = globalThis.chrome?.storage?.session || null;
  const isLocalFixtureHost = () => ['localhost', '127.0.0.1'].includes((currentPageDebug.host || '').toLowerCase());

  const currentPageDebug = {
    host: '',
    path: '',
    platform: '',
    contentScriptLoaded: false,
    storageAvailable: Boolean(sessionStorageApi),
    bundleCount: 0,
    bundleKeys: [],
    lastExtractionStatus: 'Waiting for page response…',
    rowsDetected: 0,
    columnsDetected: 0,
    metricColumns: [],
    lastError: '',
  };
  let debugRequestTimer = null;

  try {
    if (document.referrer) {
      const referrerUrl = new URL(document.referrer);
      currentPageDebug.host = referrerUrl.host;
      currentPageDebug.path = `${referrerUrl.pathname}${referrerUrl.search || ''}`;
    }
  } catch {
    // Ignore referrer parsing issues; the content script can still fill this in.
  }

  const storageGet = async (key) => {
    if (!sessionStorageApi) return null;
    return await new Promise((resolve) => {
      sessionStorageApi.get([key], (result) => resolve(result?.[key] ?? null));
    });
  };

  const storageSet = async (key, value) => {
    if (!sessionStorageApi) return;
    await new Promise((resolve) => {
      sessionStorageApi.set({ [key]: value }, () => resolve());
    });
  };

  const storageRemove = async (key) => {
    if (!sessionStorageApi) return;
    await new Promise((resolve) => {
      sessionStorageApi.remove(key, () => resolve());
    });
  };

  const loadCapturedTables = async () => {
    const stored = await storageGet(STORAGE_KEY);
    capturedTables = Array.isArray(stored) ? stored.filter(Boolean) : [];
    currentPageDebug.bundleCount = capturedTables.length;
    currentPageDebug.bundleKeys = capturedTables.map((capture) => capture.platform).filter(Boolean);
  };

  const persistCapturedTables = async () => {
    await storageSet(STORAGE_KEY, capturedTables);
  };

  const upsertCapturedTable = (capture) => {
    const platform = String(capture?.platform || '').trim();
    const canReplace = platform && !/^unknown platform$/i.test(platform) && !/^local only$/i.test(platform) && !/^local test page$/i.test(platform);
    const index = canReplace ? capturedTables.findIndex((item) => item.platform === platform) : -1;
    if (index >= 0) {
      capturedTables.splice(index, 1, capture);
    } else {
      capturedTables.push(capture);
    }
    currentPageDebug.bundleCount = capturedTables.length;
    currentPageDebug.bundleKeys = capturedTables.map((item) => item.platform).filter(Boolean);
  };

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

  const renderSteps = (items, emptyLabel) => {
    if (!items || !items.length) {
      return `<li>${escapeHtml(emptyLabel)}</li>`;
    }
    return items.slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
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
    const capturedSummaryCard = $('capturedSummaryCard');
    const capturedCountInline = $('capturedCountInline');

    countChip.textContent = `${capturedTables.length} table${capturedTables.length === 1 ? '' : 's'} captured`;
    analyseNow.disabled = capturedTables.length === 0;
    capturedSummaryCard.hidden = !capturedTables.length;
    capturedCountInline.textContent = capturedTables.length
      ? `${capturedTables.length} table${capturedTables.length === 1 ? '' : 's'} captured`
      : '0 tables';

    if (!capturedTables.length) {
      container.innerHTML = '<div class="captured-item"><strong>No captured tables yet</strong><span>Add a visible table from Google Ads, Meta Ads, or LinkedIn Ads.</span></div>';
      hint.textContent = 'Add visible tables from one or more platforms, then analyse them together.';
      return;
    }

    const platforms = uniquePlatforms(capturedTables.map((capture) => capture.platform));
    container.innerHTML = capturedTables.map((capture) => `
      <div class="captured-item">
        <strong>${escapeHtml(capture.platform)} — ${escapeHtml(formatNumber(capture.rowsDetected || 0))} rows</strong>
        <span>${escapeHtml(formatNumber((capture.metricColumns || []).length))} metric columns · ${escapeHtml(formatTime(capture.capturedAt))}</span>
      </div>
    `).join('');

    hint.textContent = `${capturedTables.length} table${capturedTables.length === 1 ? '' : 's'} captured · ${platforms.join(', ')}`;
  };

  const renderDebugState = () => {
    const debugCard = $('debugCard');
    if (!debugCard) return;

    debugCard.hidden = !isLocalFixtureHost();
    if (debugCard.hidden) return;

    $('debugPage').textContent = currentPageDebug.host ? `${currentPageDebug.host}${currentPageDebug.path || '/'}` : 'Waiting…';
    $('debugPlatform').textContent = currentPageDebug.platform || 'Waiting…';
    $('debugContentScript').textContent = currentPageDebug.contentScriptLoaded ? 'Loaded' : 'Not confirmed yet';
    $('debugStorage').textContent = currentPageDebug.storageAvailable ? 'Available' : 'Unavailable';
    $('debugBundleCount').textContent = String(currentPageDebug.bundleCount ?? capturedTables.length ?? 0);
    $('debugBundleKeys').textContent = currentPageDebug.bundleKeys.length ? currentPageDebug.bundleKeys.join(' · ') : '—';
    $('debugLastExtraction').textContent = currentPageDebug.lastExtractionStatus || '—';
    $('debugRows').textContent = Number.isFinite(currentPageDebug.rowsDetected) ? formatNumber(currentPageDebug.rowsDetected) : '—';
    $('debugColumns').textContent = Number.isFinite(currentPageDebug.columnsDetected) ? formatNumber(currentPageDebug.columnsDetected) : '—';
    $('debugMetricColumns').textContent = currentPageDebug.metricColumns.length ? currentPageDebug.metricColumns.join(', ') : '—';
    $('debugError').textContent = currentPageDebug.lastError || '—';
  };

  const applyDebugState = (state = {}) => {
    currentPageDebug.host = state.host || currentPageDebug.host || '';
    currentPageDebug.path = state.path || currentPageDebug.path || '';
    currentPageDebug.platform = state.platform || currentPageDebug.platform || '';
    currentPageDebug.contentScriptLoaded = Boolean(state.contentScriptLoaded || currentPageDebug.contentScriptLoaded);
    currentPageDebug.storageAvailable = Boolean(state.storageAvailable ?? currentPageDebug.storageAvailable);
    currentPageDebug.lastExtractionStatus = state.lastExtractionStatus || currentPageDebug.lastExtractionStatus;
    currentPageDebug.rowsDetected = Number.isFinite(state.rowsDetected) ? state.rowsDetected : currentPageDebug.rowsDetected;
    currentPageDebug.columnsDetected = Number.isFinite(state.columnsDetected) ? state.columnsDetected : currentPageDebug.columnsDetected;
    currentPageDebug.metricColumns = Array.isArray(state.metricColumns) ? state.metricColumns : currentPageDebug.metricColumns;
    currentPageDebug.lastError = state.lastError || '';
    renderDebugState();
  };

  const requestDebugState = () => {
    if (debugRequestTimer) window.clearTimeout(debugRequestTimer);
    currentPageDebug.lastError = '';
    window.parent.postMessage({ type: 'gnomeo-debug-request' }, '*');
    debugRequestTimer = window.setTimeout(() => {
      if (!currentPageDebug.contentScriptLoaded) {
        currentPageDebug.lastExtractionStatus = 'Gnomeo is not available on this page.';
        currentPageDebug.lastError = 'No content script response on this page.';
        setStatus('Gnomeo is not available on this page. Open a supported campaign table or local fixture page.');
        renderDebugState();
      }
    }, 600);
  };

  const setStatus = (text) => {
    $('captureStatus').textContent = text;
  };

  const setAnalysis = (analysis) => {
    currentAnalysis = analysis || EMPTY_ANALYSIS;
    const summary = currentAnalysis.summary || EMPTY_ANALYSIS.summary;
    const focusCard = $('focusCard');
    const focusText = $('focusText');
    const focusConfidence = $('focusConfidence');
    const nextStepsCard = $('nextStepsCard');
    const nextStepsList = $('nextStepsList');
    const capturedSummaryCard = $('capturedSummaryCard');
    const privacyHint = $('privacyHint');

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
    focusCard.hidden = !currentAnalysis.success;
    nextStepsCard.hidden = !currentAnalysis.success;
    capturedSummaryCard.hidden = !currentAnalysis.success || !capturedTables.length;
    focusText.textContent = currentAnalysis.success
      ? (currentAnalysis.focus || summary.executiveFinding || EMPTY_ANALYSIS.summary.executiveFinding)
      : 'Add a visible table to see the focus.';
    focusConfidence.textContent = currentAnalysis.success
      ? (currentAnalysis.reviewConfidence || 'Visible rows only')
      : 'Visible rows only';
    $('keySignals').innerHTML = renderLines(summary.keySignals.slice(0, 4), 'No visible signals found yet.');
    $('visiblePreview').innerHTML = renderPreview(currentAnalysis.previewRows);
    $('attentionList').innerHTML = renderLines(summary.attention.slice(0, 3), 'No attention notes yet.');
    nextStepsList.innerHTML = renderSteps(currentAnalysis.nextSteps || [], 'Add a visible table first.');
    if (privacyHint) privacyHint.textContent = currentAnalysis.success
      ? 'Gnomeo only reviews visible tables you choose to add. Nothing is captured in the background, sent, or stored beyond this session.'
      : 'Gnomeo only reviews visible tables you choose to add. Nothing is captured in the background, sent, or stored beyond this session.';
    $('privacyNote').textContent = currentAnalysis.success
      ? (summary.privacyNote || EMPTY_ANALYSIS.summary.privacyNote)
      : 'Gnomeo only reviews visible tables you choose to add. Nothing is captured in the background, sent, or stored beyond this session.';
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
    const summary = capture.summary || EMPTY_ANALYSIS.summary;
    const spendLabel = capture.snapshot?.spendLabel || capture.platform;
    const conversionLabel = capture.snapshot?.conversionLabel || '';
    const watchLabel = capture.snapshot?.watchLabel || spendLabel;
    const spendValue = capture.snapshot?.spendValue;
    const conversionValue = capture.snapshot?.conversionValue;
    const watchSpend = capture.snapshot?.watchSpendValue;

    const focus = capture.snapshot?.watchLabel
      ? `${watchLabel} is the main watch item because it is spending money but showing fewer results.`
      : conversionLabel && conversionLabel !== spendLabel
        ? `${conversionLabel} appears to be producing the clearest results. ${spendLabel} is spending the most money, so check that it is doing something useful before you add more budget.`
        : `${spendLabel} is spending the most money, so check that it is doing something useful before you add more budget.`;

    const nextSteps = [
      `Check ${spendLabel} first. It is where mistakes cost the most.`,
    ];
    if (conversionLabel && conversionLabel !== spendLabel) {
      nextSteps.push(`Protect ${conversionLabel}. Do not cut it just because another campaign is louder.`);
    }
    if (capture.snapshot?.watchLabel) {
      nextSteps.push(`Be cautious with ${watchLabel}. Review the page, audience, or search terms before adding budget.`);
    }
    nextSteps.push('Treat this as a visible-table spot check, not a full account decision.');

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
      focus,
      nextSteps,
      summary: {
        executiveFinding: focus,
        keySignals: [
          { label: 'Biggest spend', title: spendLabel, details: Number.isFinite(spendValue) ? `This campaign is spending ${formatNumber(spendValue, 2)}.` : 'This campaign is spending the most money.' },
          conversionLabel ? { label: 'Best results', title: conversionLabel, details: Number.isFinite(conversionValue) ? 'This one appears to be getting results more efficiently.' : 'This one appears to be getting the clearest results.' } : null,
          capture.snapshot?.watchLabel ? { label: 'Main watch item', title: watchLabel, details: Number.isFinite(watchSpend) ? `Spending ${formatNumber(watchSpend, 2)} with fewer results.` : 'Spending money but showing fewer results.' } : null,
          { label: 'Confidence', title: 'Visible rows only', details: 'Treat this as a spot check, not a full account decision.' },
        ].filter(Boolean),
        attention: [
          `Check ${spendLabel} first. It is where mistakes cost the most.`,
          conversionLabel && conversionLabel !== spendLabel ? `Protect ${conversionLabel}. Do not cut it just because another campaign is louder.` : 'Protect the campaign getting the clearest results. Do not cut it just because another campaign is louder.',
          capture.snapshot?.watchLabel ? `Be cautious with ${watchLabel}. Review the page, audience, or search terms before adding budget.` : 'Be cautious with the campaign spending money but showing fewer results.',
        ],
        privacyNote: summary.privacyNote || EMPTY_ANALYSIS.summary.privacyNote,
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

    const spendLabel = spendCandidate?.capture?.snapshot?.spendLabel || spendCandidate?.capture?.platform || '';
    const conversionLabel = conversionCandidate?.capture?.snapshot?.conversionLabel || '';
    const watchLabel = watchCandidate?.capture?.snapshot?.watchLabel || watchCandidate?.capture?.platform || '';

    const keySignals = [];
    if (spendCandidate) {
      keySignals.push({
        label: 'Biggest spend',
        title: `${spendCandidate.capture.platform} — ${spendLabel}`,
        details: `This campaign is spending ${formatNumber(spendCandidate.value, 2)}.`,
      });
    }
    if (conversionCandidate) {
      keySignals.push({
        label: 'Best results',
        title: `${conversionCandidate.capture.platform} — ${conversionLabel || conversionCandidate.capture.platform}`,
        details: 'This one appears to be getting results more efficiently.',
      });
    }
    if (watchCandidate) {
      keySignals.push({
        label: 'Main watch item',
        title: `${watchCandidate.capture.platform} — ${watchLabel}`,
        details: 'This campaign is spending money but showing fewer results.',
      });
    }
    keySignals.push({
      label: 'Confidence',
      title: 'Visible rows only',
      details: 'Treat this as a spot check, not a full account decision.',
    });
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

    const focus = watchCandidate
      ? `${watchCandidate.capture.platform} is the main watch item because it is spending money but showing fewer results.`
      : conversionCandidate
        ? `${conversionCandidate.capture.platform} appears to be producing the clearest results.`
        : spendCandidate
          ? `${spendCandidate.capture.platform} is spending the most money.`
          : 'Treat this as a visible-table spot check.';

    const topFinding = focus;

    const attention = [
      spendCandidate ? `Check ${spendCandidate.capture.platform} first. It is where mistakes cost the most.` : 'Check the highest-spend platform first. It is where mistakes cost the most.',
      conversionCandidate ? `Protect ${conversionCandidate.capture.platform}. Do not cut it just because another campaign is louder.` : 'Protect the campaign getting the clearest results. Do not cut it just because another campaign is louder.',
      watchCandidate ? `Be cautious with ${watchCandidate.capture.platform}. Review the page, audience, or search terms before adding budget.` : 'Be cautious with the campaign spending money but showing fewer results.',
    ];

    const nextSteps = [
      spendCandidate ? `Check ${spendCandidate.capture.platform} first. It is where mistakes cost the most.` : 'Check the highest-spend campaign first. It is where mistakes cost the most.',
      conversionCandidate ? `Protect ${conversionCandidate.capture.platform}. Do not cut it just because another campaign is louder.` : 'Protect the campaign getting the clearest results. Do not cut it just because another campaign is louder.',
      watchCandidate ? `Be cautious with ${watchCandidate.capture.platform}. Review the page, audience, or search terms before adding budget.` : 'Treat this as a visible-table spot check, not a full account decision.',
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
      focus,
      nextSteps,
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
    $('focusText').textContent = 'Reading the visible table…';
    setStatus('Gnomeo is reading the visible table you chose to add.');
    window.parent.postMessage({ type: 'gnomeo-review-visible-table-request', requestId: pendingRequestId }, '*');
  };

  const analyseNow = () => {
    if (!capturedTables.length) {
      setStatus('Add a visible table first.');
      return;
    }
    const analysis = capturedTables.length === 1
      ? buildSingleReview(capturedTables[0])
      : buildBundleReview(capturedTables);
    setAnalysis(analysis);
    setStatus(capturedTables.length === 1
      ? `${capturedTables[0].platform} analysed.`
      : `${capturedTables.length} captured tables analysed.`);
  };

  const addAnotherPlatform = () => {
    $('bundleHint').textContent = 'Open another ad platform campaign table, then click Add visible table again.';
    setStatus('Open another ad platform campaign table, then click Add visible table again.');
  };

  const clearCapturedTables = async () => {
    pendingRequestId = null;
    capturedTables = [];
    currentPageDebug.bundleCount = 0;
    currentPageDebug.bundleKeys = [];
    setAnalysis(EMPTY_ANALYSIS);
    renderCapturedTables();
    renderDebugState();
    $('addVisibleTable').textContent = 'Add visible table';
    $('addVisibleTable').disabled = false;
    setStatus('Captured tables cleared. Start again with Add visible table.');
    await storageRemove(STORAGE_KEY);
  };

  const boot = async () => {
    const close = $('closePanel');
    const addButton = $('addVisibleTable');
    const analyseNowButton = $('analyseNow');
    const addAnotherPlatformButton = $('addAnotherPlatform');
    const clearCapturedTablesButton = $('clearCapturedTables');
    const clearReviewButton = $('clearReview');

    await loadCapturedTables();
    setAnalysis(EMPTY_ANALYSIS);
    renderCapturedTables();
    if (capturedTables.length) {
      setAnalysis(capturedTables.length === 1 ? buildSingleReview(capturedTables[0]) : buildBundleReview(capturedTables));
      setStatus(`${capturedTables.length} table${capturedTables.length === 1 ? '' : 's'} captured.`);
    }

    close?.addEventListener('click', () => {
      window.parent.postMessage({ type: 'gnomeo-close' }, '*');
    });

    addButton?.addEventListener('click', addVisibleTable);
    analyseNowButton?.addEventListener('click', analyseNow);
    addAnotherPlatformButton?.addEventListener('click', addAnotherPlatform);
    clearCapturedTablesButton?.addEventListener('click', clearCapturedTables);
    clearReviewButton?.addEventListener('click', clearCapturedTables);

    renderDebugState();
    requestDebugState();

    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'gnomeo-debug-state') {
        if (debugRequestTimer) {
          window.clearTimeout(debugRequestTimer);
          debugRequestTimer = null;
        }
        applyDebugState({
          host: data.host,
          path: data.path,
          platform: data.platform,
          contentScriptLoaded: true,
          storageAvailable: data.storageAvailable,
          lastExtractionStatus: data.lastExtractionStatus,
          rowsDetected: data.rowsDetected,
          columnsDetected: data.columnsDetected,
          metricColumns: data.metricColumns,
          lastError: data.lastError,
        });
        return;
      }
      if (data.type !== 'gnomeo-visible-table-result') return;
      if (pendingRequestId && data.requestId && data.requestId !== pendingRequestId) return;
      pendingRequestId = null;
      addButton.textContent = 'Add visible table';
      addButton.disabled = false;

      const payload = data.payload || EMPTY_ANALYSIS;
      applyDebugState({
        host: currentPageDebug.host,
        path: currentPageDebug.path,
        platform: payload.platform || currentPageDebug.platform,
        contentScriptLoaded: true,
        storageAvailable: currentPageDebug.storageAvailable,
        lastExtractionStatus: payload.success
          ? `Captured ${payload.platform || 'table'}`
          : (payload.summary?.executiveFinding || 'Gnomeo could not find a visible campaign table on this page.'),
        rowsDetected: Number.isFinite(payload.rowsDetected) ? payload.rowsDetected : currentPageDebug.rowsDetected,
        columnsDetected: Number.isFinite(payload.columnsDetected) ? payload.columnsDetected : currentPageDebug.columnsDetected,
        metricColumns: Array.isArray(payload.metricColumns) ? payload.metricColumns : currentPageDebug.metricColumns,
        lastError: payload.error || '',
      });
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
      upsertCapturedTable(capture);
      renderCapturedTables();
      setAnalysis(capturedTables.length === 1 ? buildSingleReview(capture) : buildBundleReview(capturedTables));
      setStatus(`${capturedTables.length} table${capturedTables.length === 1 ? '' : 's'} captured.`);
      persistCapturedTables().catch(() => {});
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch(() => {}); }, { once: true });
  } else {
    boot().catch(() => {});
  }
})();
