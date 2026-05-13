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
      executiveFinding: 'Add a table to see the focus.',
      keySignals: [],
      attention: [
        'Gnomeo only reviews visible tables you choose to add.',
        'Only the visible table you choose. Nothing runs in the background.',
        'Try another campaign table if this page is not the right one.',
      ],
      privacyNote: 'Only the visible table you choose. Nothing runs in the background.',
    },
    sources: [],
  };

  let pendingRequestId = null;
  let capturedTables = [];
  let currentAnalysis = EMPTY_ANALYSIS;
  const STORAGE_KEY = 'gnomeo-captured-tables';
  const ANALYSIS_META_KEY = 'gnomeo-analysis-meta';
  const sessionStorageApi = globalThis.chrome?.storage?.session || null;
  const tabsApi = globalThis.chrome?.tabs || null;
  const sidePanelApi = globalThis.chrome?.sidePanel || null;
  const runtimeApi = globalThis.chrome?.runtime || null;
  const isLocalFixtureHost = () => ['localhost', '127.0.0.1'].includes((currentPageDebug.host || '').toLowerCase());

  let analysisMeta = {
    lastAnalysedSignature: '',
    analysedAt: 0,
  };
  let activeRefreshTimer = null;

  const currentPageDebug = {
    host: '',
    path: '',
    url: '',
    activeTabId: null,
    activeUrl: '',
    currentPlatform: '',
    currentCaptureKey: '',
    currentBundleSignature: '',
    lastAnalysedSignature: '',
    analysisFresh: false,
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

  const setActionError = (message = '') => {
    const el = $('actionError');
    if (!el) return;
    const text = String(message || '').trim();
    el.hidden = !text;
    el.textContent = text;
  };

  const clearActionError = () => setActionError('');

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
      sessionStorageApi.set({ [key]: value }, () => {
        if (runtimeApi?.lastError?.message) {
          resolve({ ok: false, error: runtimeApi.lastError.message });
          return;
        }
        resolve({ ok: true });
      });
    });
  };

  const storageRemove = async (key) => {
    if (!sessionStorageApi) return;
    await new Promise((resolve) => {
      sessionStorageApi.remove(key, () => {
        if (runtimeApi?.lastError?.message) {
          resolve({ ok: false, error: runtimeApi.lastError.message });
          return;
        }
        resolve({ ok: true });
      });
    });
  };

  const loadAnalysisMeta = async () => {
    const stored = await storageGet(ANALYSIS_META_KEY);
    if (stored && typeof stored === 'object') {
      analysisMeta = {
        ...analysisMeta,
        lastAnalysedSignature: String(stored.lastAnalysedSignature || ''),
        analysedAt: Number.isFinite(stored.analysedAt) ? stored.analysedAt : 0,
      };
    }
  };

  const persistAnalysisMeta = async () => {
    const result = await storageSet(ANALYSIS_META_KEY, analysisMeta);
    if (result?.ok === false) throw new Error(result.error || 'Analysis metadata write failed');
  };

  const queryActiveTab = async () => {
    if (!tabsApi?.query) {
      return { ok: false, error: { stage: 'active-tab', message: 'chrome.tabs.query is unavailable', userMessage: 'Open a supported campaign table, then click Add table.' } };
    }
    return await new Promise((resolve) => {
      tabsApi.query({ active: true, currentWindow: true }, (tabs) => {
        const message = runtimeApi?.lastError?.message || '';
        if (message) {
          resolve({ ok: false, error: { stage: 'active-tab', message, userMessage: 'Open a supported campaign table, then click Add table.' } });
          return;
        }
        if (!Array.isArray(tabs) || !tabs.length || !tabs[0]?.id) {
          resolve({ ok: false, error: { stage: 'active-tab', message: 'No active tab found', userMessage: 'Open a supported campaign table, then click Add table.' } });
          return;
        }
        resolve({ ok: true, tab: tabs[0] });
      });
    });
  };

  const sendMessageToTab = async (tabId, message) => {
    if (!tabsApi?.sendMessage) {
      return { ok: false, error: { stage: 'message-send', message: 'chrome.tabs.sendMessage is unavailable', userMessage: 'Open a supported campaign table, then click Add table.' } };
    }
    return await new Promise((resolve) => {
      tabsApi.sendMessage(tabId, message, (response) => {
        const messageText = runtimeApi?.lastError?.message || '';
        if (messageText) {
          resolve({ ok: false, error: { stage: 'message-send', message: messageText, userMessage: 'Open a supported campaign table, then click Add table.' } });
          return;
        }
        resolve({ ok: true, response });
      });
    });
  };

  const closePanelView = async () => {
    if (!sidePanelApi?.close || !tabsApi?.query) return false;
    const activeTab = await queryActiveTab();
    if (!activeTab.ok) return false;
    try {
      await sidePanelApi.close({ windowId: activeTab.tab.windowId });
      return true;
    } catch {
      return false;
    }
  };

  const requestDebugSnapshot = async () => {
    const activeTab = await queryActiveTab();
    if (!activeTab.ok) return activeTab;
    const response = await sendMessageToTab(activeTab.tab.id, { type: 'gnomeo-debug-request' });
    if (!response.ok) return { ok: false, error: response.error, tab: activeTab.tab, contentScriptLoaded: false };
    return response.response?.ok
      ? { ok: true, state: response.response.state, tab: activeTab.tab, contentScriptLoaded: true }
      : { ok: false, error: response.response?.error || { stage: 'debug-state', message: 'Debug state failed', userMessage: 'Debug state failed' }, tab: activeTab.tab, contentScriptLoaded: true };
  };

  const requestTableReview = async () => {
    const activeTab = await queryActiveTab();
    if (!activeTab.ok) return activeTab;
    const response = await sendMessageToTab(activeTab.tab.id, { type: 'gnomeo-review-visible-table-request' });
    if (!response.ok) return { ok: false, error: response.error, tab: activeTab.tab, contentScriptLoaded: false };
    return response.response?.ok
      ? { ok: true, payload: response.response.payload, tab: activeTab.tab, contentScriptLoaded: true }
      : { ok: false, error: response.response?.error || { stage: 'extractor', message: 'Extraction failed', userMessage: 'Gnomeo could not read this table yet.' }, tab: activeTab.tab, contentScriptLoaded: true };
  };

  const inferPlatformFromUrl = (url = '') => {
    try {
      const parsed = new URL(url);
      const hostName = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      if (hostName.includes('google.com') && path.includes('/')) return 'Google Ads';
      if (hostName.includes('facebook.com') || hostName.includes('meta.com')) return 'Meta Ads';
      if (hostName.includes('linkedin.com') && path.includes('/campaignmanager')) return 'LinkedIn Campaign Manager';
      if (hostName === 'localhost' || hostName === '127.0.0.1') return 'Local test page';
    } catch {
      // Ignore malformed URLs.
    }
    return 'Unknown platform';
  };

  const refreshActiveContext = async () => {
    const response = await requestDebugSnapshot();
    const tab = response.tab || null;
    currentPageDebug.activeTabId = tab?.id ?? null;
    currentPageDebug.activeUrl = tab?.url || currentPageDebug.activeUrl || '';

    if (response.ok) {
      applyDebugState(response.state);
      currentPageDebug.host = response.state.host || currentPageDebug.host || '';
      currentPageDebug.path = response.state.path || currentPageDebug.path || '';
      currentPageDebug.url = response.state.url || tab?.url || currentPageDebug.url || '';
      currentPageDebug.platform = response.state.platform || inferPlatformFromUrl(tab?.url || currentPageDebug.url);
      currentPageDebug.currentPlatform = currentPageDebug.platform;
      currentPageDebug.currentCaptureKey = captureKeyFromPlatform(currentPageDebug.currentPlatform);
      currentPageDebug.contentScriptLoaded = true;
      currentPageDebug.lastExtractionStatus = response.state.lastExtractionStatus || currentPageDebug.lastExtractionStatus;
      currentPageDebug.lastError = response.state.lastError || '';
      currentPageDebug.rowsDetected = Number.isFinite(response.state.rowsDetected) ? response.state.rowsDetected : currentPageDebug.rowsDetected;
      currentPageDebug.columnsDetected = Number.isFinite(response.state.columnsDetected) ? response.state.columnsDetected : currentPageDebug.columnsDetected;
      currentPageDebug.metricColumns = Array.isArray(response.state.metricColumns) ? response.state.metricColumns : currentPageDebug.metricColumns;
    } else {
      currentPageDebug.url = tab?.url || currentPageDebug.url || '';
      currentPageDebug.platform = inferPlatformFromUrl(tab?.url || currentPageDebug.url);
      currentPageDebug.currentPlatform = currentPageDebug.platform;
      currentPageDebug.currentCaptureKey = captureKeyFromPlatform(currentPageDebug.currentPlatform);
      currentPageDebug.contentScriptLoaded = Boolean(response.contentScriptLoaded);
      currentPageDebug.lastExtractionStatus = response.error?.userMessage || 'Open a supported campaign table, then click Add table.';
      currentPageDebug.lastError = response.error?.message || response.error?.userMessage || 'No content script response on this page.';
    }

    renderCapturedTables();
    renderDebugState();
  };

  let contextRefreshScheduled = null;
  const scheduleContextRefresh = () => {
    if (contextRefreshScheduled) window.clearTimeout(contextRefreshScheduled);
    contextRefreshScheduled = window.setTimeout(() => {
      contextRefreshScheduled = null;
      refreshActiveContext().catch(() => {});
    }, 100);
  };

  const loadCapturedTables = async () => {
    const stored = await storageGet(STORAGE_KEY);
    capturedTables = Array.isArray(stored) ? stored.filter(Boolean) : [];
    refreshBundleDebugState();
  };

  const persistCapturedTables = async () => {
    const result = await storageSet(STORAGE_KEY, capturedTables);
    if (result?.ok === false) throw new Error(result.error || 'Storage write failed');
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
    refreshBundleDebugState();
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

  const displayPlatformName = (platform) => {
    const value = String(platform || '').trim();
    if (/^google ads$/i.test(value)) return 'Google Ads';
    if (/^meta ads$/i.test(value)) return 'Meta Ads';
    if (/^linkedin campaign manager$/i.test(value)) return 'LinkedIn Campaign Manager';
    if (/^local test page$/i.test(value)) return 'Local test page';
    return value || 'Other';
  };

  const captureKeyFromPlatform = (platform) => displayPlatformName(platform);

  const buildBundleSignature = (items = []) => JSON.stringify(sortCapturedTables(items).map((capture) => ({
    platform: displayPlatformName(capture.platform),
    tableKind: capture.tableKind || 'table',
    rowsDetected: capture.rowsDetected || 0,
    columnsDetected: capture.columnsDetected || 0,
    capturedAt: capture.capturedAt || 0,
    metricColumns: Array.isArray(capture.metricColumns) ? [...new Set(capture.metricColumns)].sort() : [],
    snapshot: {
      spendLabel: capture.snapshot?.spendLabel || '',
      conversionLabel: capture.snapshot?.conversionLabel || '',
      watchLabel: capture.snapshot?.watchLabel || '',
      watchSpendValue: Number.isFinite(capture.snapshot?.watchSpendValue) ? capture.snapshot.watchSpendValue : null,
      watchConversionValue: Number.isFinite(capture.snapshot?.watchConversionValue) ? capture.snapshot.watchConversionValue : null,
      watchRoasValue: Number.isFinite(capture.snapshot?.watchRoasValue) ? capture.snapshot.watchRoasValue : null,
    },
  })));

  const refreshBundleDebugState = () => {
    currentPageDebug.bundleCount = capturedTables.length;
    currentPageDebug.bundleKeys = sortPlatformNames(capturedTables.map((item) => item.platform));
    currentPageDebug.currentBundleSignature = buildBundleSignature(capturedTables);
    currentPageDebug.lastAnalysedSignature = analysisMeta.lastAnalysedSignature || '';
    currentPageDebug.analysisFresh = Boolean(currentPageDebug.currentBundleSignature && currentPageDebug.currentBundleSignature === currentPageDebug.lastAnalysedSignature);
    return currentPageDebug.analysisFresh;
  };

  const captureAnalysisFreshness = () => refreshBundleDebugState();

  const makeStaleAnalysis = () => ({
    ...EMPTY_ANALYSIS,
    summary: {
      ...EMPTY_ANALYSIS.summary,
      executiveFinding: 'Tables changed — analyse again for an updated focus.',
      attention: ['Analyse again to refresh the focus.'],
      privacyNote: EMPTY_ANALYSIS.summary.privacyNote,
    },
    stale: true,
  });

  const platformLabelFromState = () => currentPageDebug.currentPlatform || currentPageDebug.platform || 'Unknown platform';

  const derivePanelState = () => {
    const bundleCount = capturedTables.length;
    const currentPlatform = platformLabelFromState();
    const supported = Boolean(currentPageDebug.contentScriptLoaded && currentPlatform && !/^unknown platform$/i.test(currentPlatform));
    const currentCaptureKey = currentPlatform ? captureKeyFromPlatform(currentPlatform) : '';
    const currentCaptureAdded = supported && capturedTables.some((item) => captureKeyFromPlatform(item.platform) === currentCaptureKey);
    const analysisFresh = captureAnalysisFreshness();
    const state = bundleCount === 0
      ? 'empty'
      : supported && currentCaptureAdded
        ? 'current-added'
        : supported
          ? 'current-missing'
          : 'unsupported';
    const tableCountText = `${bundleCount} table${bundleCount === 1 ? '' : 's'} added`;
    const addedPlatforms = sortPlatformNames(capturedTables.map((item) => item.platform));
    const addedText = addedPlatforms.length ? addedPlatforms.join(', ') : 'None yet';
    let note = '';
    if (!supported) {
      note = 'Open a supported campaign table, then click Add table.';
    } else if (state === 'empty') {
      note = 'Add the visible campaign table to start.';
    } else if (state === 'current-added') {
      note = 'This table is already added.';
    } else {
      note = 'Current page not added yet.';
    }
    if (supported && bundleCount > 0 && !analysisFresh) {
      note = `${note} Tables changed — analyse again for an updated focus.`.trim();
    }
    return {
      state,
      supported,
      currentPlatform,
      currentCaptureKey,
      currentCaptureAdded,
      bundleCount,
      tableCountText,
      addedText,
      note,
      analysisFresh,
      canAddTable: supported,
      buttonLabel: bundleCount > 0 && currentCaptureAdded ? 'Update table' : 'Add table',
      statusLine: !supported
        ? 'Open a supported campaign table, then click Add table.'
        : bundleCount === 0
          ? 'Add the visible campaign table to start.'
          : state === 'current-added'
            ? (analysisFresh ? 'This table is already added. Analysis ready.' : 'This table is already added. Tables changed — analyse again for an updated focus.')
            : state === 'current-missing'
              ? (analysisFresh ? 'Current page not added yet. Analysis ready.' : 'Current page not added yet. Tables changed — analyse again for an updated focus.')
              : 'Open a supported campaign table, then click Add table.',
      summaryChip: analysisFresh ? 'Analysis ready' : (bundleCount ? 'Needs re-analysis' : 'No analysis yet'),
    };
  };

  const canonicalPlatformName = (platform) => {
    const value = String(platform || '').trim();
    if (/^google ads$/i.test(value)) return 'Google Ads';
    if (/^meta ads$/i.test(value)) return 'Meta Ads';
    if (/^linkedin campaign manager$/i.test(value)) return 'LinkedIn Campaign Manager';
    return 'Other';
  };

  const platformRank = (platform) => {
    const value = displayPlatformName(platform);
    if (value === 'Google Ads') return 0;
    if (value === 'Meta Ads') return 1;
    if (value === 'LinkedIn Campaign Manager') return 2;
    if (value === 'Local test page') return 3;
    return 4;
  };

  const sortCapturedTables = (items = []) => [...items].sort((a, b) => {
    const rankDiff = platformRank(a.platform) - platformRank(b.platform);
    if (rankDiff !== 0) return rankDiff;
    const aLabel = String(a?.snapshot?.watchLabel || a?.snapshot?.spendLabel || a?.platform || '').toLowerCase();
    const bLabel = String(b?.snapshot?.watchLabel || b?.snapshot?.spendLabel || b?.platform || '').toLowerCase();
    if (aLabel < bLabel) return -1;
    if (aLabel > bLabel) return 1;
    return (a.capturedAt || 0) - (b.capturedAt || 0);
  });

  const sortPlatformNames = (items = []) => {
    const names = uniquePlatforms(items).map(displayPlatformName);
    return [...new Set(names)].sort((a, b) => platformRank(a) - platformRank(b));
  };

  const platformAdvice = (platform) => {
    const name = displayPlatformName(platform);
    if (name === 'Google Ads') return 'For Google, check the landing page or keywords if this is a Search campaign.';
    if (name === 'Meta Ads') return 'For Meta, check the audience, creative, placement, or landing page.';
    if (name === 'LinkedIn Campaign Manager') return 'For LinkedIn, check the audience, offer, lead form, or landing page.';
    if (name === 'Local test page') return 'For local fixtures, compare the visible rows and try another supported page if needed.';
    return 'Check why this is spending money without enough visible results.';
  };

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
      return '<div class="preview-item"><strong>No safe preview yet</strong><span>Add a table to see a local preview.</span></div>';
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
    const addVisibleTableButton = $('addVisibleTable');
    const analyseNow = $('analyseNow');
    const clearCapturedTablesButton = $('clearCapturedTables');
    const capturedSummaryCard = $('capturedSummaryCard');
    const capturedCountInline = $('capturedCountInline');

    const orderedTables = sortCapturedTables(capturedTables);
    const panelState = derivePanelState();

    countChip.textContent = panelState.tableCountText;
    if (addVisibleTableButton) {
      addVisibleTableButton.textContent = panelState.buttonLabel;
      addVisibleTableButton.disabled = !panelState.canAddTable || Boolean(pendingRequestId);
    }
    if (capturedCountInline) {
      capturedCountInline.textContent = panelState.tableCountText;
    }
    analyseNow.disabled = capturedTables.length === 0;
    analyseNow.hidden = !capturedTables.length;
    clearCapturedTablesButton.hidden = !capturedTables.length;
    capturedSummaryCard.hidden = false;
    capturedSummaryCard.querySelector('.card-label').textContent = 'Current page';
    hint.textContent = `${panelState.note} Added: ${panelState.addedText}.`;
    setStatus(panelState.statusLine);

    if (!orderedTables.length) {
      container.innerHTML = '<div class="captured-item"><strong>No tables yet</strong><span>Add a table from Google Ads, Meta Ads, or LinkedIn Ads.</span></div>';
      countChip.textContent = '0 tables added';
      return;
    }

    container.innerHTML = orderedTables.map((capture) => `
      <div class="captured-item">
        <strong>${escapeHtml(capture.platform)} — ${escapeHtml(formatNumber(capture.rowsDetected || 0))} rows</strong>
        <span>${escapeHtml(formatNumber((capture.metricColumns || []).length))} metric columns · ${escapeHtml(formatTime(capture.capturedAt))}</span>
      </div>
    `).join('');
  };

  const renderDebugState = () => {
    const debugCard = $('debugCard');
    if (!debugCard) return;

    debugCard.hidden = !isLocalFixtureHost();
    if (debugCard.hidden) return;

    $('debugPage').textContent = currentPageDebug.url || (currentPageDebug.host ? `${currentPageDebug.host}${currentPageDebug.path || '/'}` : 'Waiting…');
    $('debugActiveTab').textContent = Number.isFinite(currentPageDebug.activeTabId) ? String(currentPageDebug.activeTabId) : 'Waiting…';
    $('debugActiveUrl').textContent = currentPageDebug.activeUrl || 'Waiting…';
    $('debugPlatform').textContent = currentPageDebug.platform || 'Waiting…';
    $('debugCurrentCapture').textContent = currentPageDebug.currentCaptureKey || '—';
    $('debugContentScript').textContent = currentPageDebug.contentScriptLoaded ? 'Yes' : 'No';
    $('debugStorage').textContent = currentPageDebug.storageAvailable ? 'Yes' : 'No';
    $('debugBundleCount').textContent = String(currentPageDebug.bundleCount ?? capturedTables.length ?? 0);
    $('debugBundleKeys').textContent = currentPageDebug.bundleKeys.length ? currentPageDebug.bundleKeys.join(' · ') : '—';
    $('debugCurrentBundleSignature').textContent = currentPageDebug.currentBundleSignature || '—';
    $('debugLastAnalysedSignature').textContent = currentPageDebug.lastAnalysedSignature || '—';
    $('debugAnalysisFresh').textContent = currentPageDebug.analysisFresh ? 'Yes' : 'No';
    $('debugLastExtraction').textContent = currentPageDebug.lastExtractionStatus || '—';
    $('debugRows').textContent = Number.isFinite(currentPageDebug.rowsDetected) ? formatNumber(currentPageDebug.rowsDetected) : '—';
    $('debugColumns').textContent = Number.isFinite(currentPageDebug.columnsDetected) ? formatNumber(currentPageDebug.columnsDetected) : '—';
    $('debugMetricColumns').textContent = currentPageDebug.metricColumns.length ? currentPageDebug.metricColumns.join(', ') : '—';
    $('debugError').textContent = currentPageDebug.lastError || '—';
  };

  const applyDebugState = (state = {}) => {
    currentPageDebug.host = state.host || currentPageDebug.host || '';
    currentPageDebug.path = state.path || currentPageDebug.path || '';
    currentPageDebug.url = state.url || currentPageDebug.url || '';
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
    debugRequestTimer = window.setTimeout(async () => {
      const response = await requestDebugSnapshot();
      if (response.ok) {
        applyDebugState(response.state);
        return;
      }
      const error = response.error || {};
      currentPageDebug.contentScriptLoaded = Boolean(response.contentScriptLoaded);
      currentPageDebug.lastExtractionStatus = error.userMessage || 'Open a supported campaign table, then click Add table.';
      currentPageDebug.lastError = error.message || error.userMessage || 'No content script response on this page.';
      setStatus(error.userMessage || 'Open a supported campaign table, then click Add table.');
      setActionError(error.userMessage || error.message || '');
      renderDebugState();
    }, 0);
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
    const reviewContent = $('reviewContent');
    const panelState = derivePanelState();

    $('sourceChip').textContent = currentAnalysis.success && currentAnalysis.mode === 'bundle'
      ? `${currentAnalysis.sources.length} tables`
      : currentAnalysis.success && currentAnalysis.mode === 'single'
        ? currentAnalysis.platform || 'Local only'
        : (currentAnalysis.stale ? 'Needs re-analysis' : 'Local only');

    const meta = [];
    if (currentAnalysis.success) {
      if (currentAnalysis.mode === 'bundle') {
        meta.push(`<span class="chip">Tables: ${escapeHtml(formatNumber(currentAnalysis.sources.length || 0))}</span>`);
        meta.push(`<span class="chip">Platforms: ${escapeHtml(currentAnalysis.platforms.join(', ') || '—')}</span>`);
      } else {
        meta.push(`<span class="chip">${escapeHtml(currentAnalysis.platform || 'Unknown platform')}</span>`);
        meta.push(`<span class="chip">Rows detected: ${escapeHtml(formatNumber(currentAnalysis.rowsDetected || 0))}</span>`);
        meta.push(`<span class="chip">Columns detected: ${escapeHtml(formatNumber(currentAnalysis.columnsDetected || 0))}</span>`);
        if (Array.isArray(currentAnalysis.metricColumns) && currentAnalysis.metricColumns.length) meta.push(`<span class="chip">Metric columns: ${escapeHtml(currentAnalysis.metricColumns.join(', '))}</span>`);
      }
      meta.push(`<span class="chip">${escapeHtml(currentAnalysis.reviewConfidence || 'Visible rows only · session-only prototype')}</span>`);
    } else if (currentAnalysis.stale) {
      meta.push('<span class="chip">Needs re-analysis</span>');
      meta.push(`<span class="chip">${escapeHtml(panelState.tableCountText)}</span>`);
    } else {
      meta.push('<span class="chip">Local only</span>');
      meta.push('<span class="chip">Visible rows only</span>');
    }
    $('metaRow').innerHTML = meta.join('');
    focusCard.hidden = !currentAnalysis.success && !currentAnalysis.stale;
    nextStepsCard.hidden = !currentAnalysis.success;
    capturedSummaryCard.hidden = false;
    capturedSummaryCard.querySelector('.card-label').textContent = 'Current page';
    reviewContent.hidden = !currentAnalysis.success;
    if (currentAnalysis.success) {
      focusText.textContent = currentAnalysis.focus || summary.executiveFinding || EMPTY_ANALYSIS.summary.executiveFinding;
      focusConfidence.textContent = currentAnalysis.reviewConfidence || 'Visible rows only';
      $('keySignals').innerHTML = renderLines(summary.keySignals.slice(0, 4), 'No visible signals found yet.');
      $('visiblePreview').innerHTML = renderPreview(currentAnalysis.previewRows);
      $('attentionList').innerHTML = renderLines(summary.attention.slice(0, 3), 'No attention notes yet.');
      nextStepsList.innerHTML = renderSteps(currentAnalysis.nextSteps || [], 'Add a table first.');
    } else if (currentAnalysis.stale) {
      focusText.textContent = summary.executiveFinding || 'Tables changed — analyse again for an updated focus.';
      focusConfidence.textContent = 'Needs re-analysis';
      $('keySignals').innerHTML = '';
      $('visiblePreview').innerHTML = '';
      $('attentionList').innerHTML = '';
      nextStepsList.innerHTML = '';
    } else {
      focusText.textContent = 'Add a table to see the focus.';
      focusConfidence.textContent = 'Visible rows only';
      $('keySignals').innerHTML = renderLines(summary.keySignals.slice(0, 4), 'No visible signals found yet.');
      $('visiblePreview').innerHTML = renderPreview(currentAnalysis.previewRows);
      $('attentionList').innerHTML = renderLines(summary.attention.slice(0, 3), 'No attention notes yet.');
      nextStepsList.innerHTML = renderSteps(currentAnalysis.nextSteps || [], 'Add a table first.');
    }
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
      nextSteps.push(`Protect ${conversionLabel} if it keeps producing results efficiently.`);
    }
    nextSteps.push(platformAdvice(capture.platform));

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
          { label: 'Biggest spend', title: spendLabel, details: Number.isFinite(spendValue) ? `This is spending ${formatNumber(spendValue, 2)}.` : 'This is spending the most money.' },
          conversionLabel ? { label: 'Best results', title: conversionLabel, details: Number.isFinite(conversionValue) ? 'This appears to be getting results more efficiently.' : 'This appears to be getting the clearest results.' } : null,
          capture.snapshot?.watchLabel ? { label: 'Main watch item', title: watchLabel, details: Number.isFinite(watchSpend) ? `${capture.platform} · spending ${formatNumber(watchSpend, 2)} with fewer results.` : `${capture.platform} · spending money but showing fewer results.` } : null,
          { label: 'Confidence', title: 'Visible rows only', details: 'Spot check only.' },
        ].filter(Boolean),
        attention: [
          `Check ${spendLabel} first. It is where mistakes cost the most.`,
          conversionLabel && conversionLabel !== spendLabel ? `Protect ${conversionLabel} if it keeps producing results efficiently.` : 'Do not increase budget until another review confirms the pattern.',
          platformAdvice(capture.platform),
        ],
        privacyNote: summary.privacyNote || EMPTY_ANALYSIS.summary.privacyNote,
      },
      sources: [capture],
      platforms: [capture.platform],
    };
  };

  const buildBundleReview = (captures) => {
    if (!captures.length) return EMPTY_ANALYSIS;
    const orderedCaptures = sortCapturedTables(captures);

    const spendCandidate = orderedCaptures
      .map((capture) => ({ capture, value: getMetric(capture, 'spendValue') }))
      .filter((item) => Number.isFinite(item.value))
      .sort((a, b) => b.value - a.value)[0] || null;

    const conversionCandidate = orderedCaptures
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

    const watchCandidate = orderedCaptures
      .map((capture) => ({ capture, score: efficiencyScore(capture) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => a.score - b.score)[0]
      || spendCandidate;

    const platforms = sortPlatformNames(orderedCaptures.map((capture) => capture.platform));
    const previewRows = orderedCaptures.flatMap((capture) => capture.previewRows.slice(0, 2).map((row) => ({ ...row, source: capture.platform }))).slice(0, 5);

    const spendLabel = spendCandidate?.capture?.snapshot?.spendLabel || spendCandidate?.capture?.platform || '';
    const conversionLabel = conversionCandidate?.capture?.snapshot?.conversionLabel || '';
    const watchLabel = watchCandidate?.capture?.snapshot?.watchLabel || watchCandidate?.capture?.platform || '';

    const keySignals = [];
    if (spendCandidate) {
      keySignals.push({
        label: 'Biggest spend',
        title: spendLabel,
        details: `${spendCandidate.capture.platform} · spending ${formatNumber(spendCandidate.value, 2)}.`,
      });
    }
    if (conversionCandidate) {
      keySignals.push({
        label: 'Best results',
        title: conversionLabel || conversionCandidate.capture.platform,
        details: `${conversionCandidate.capture.platform} · this appears to be getting results more efficiently.`,
      });
    }
    if (watchCandidate) {
      keySignals.push({
        label: 'Main watch item',
        title: watchLabel,
        details: `${watchCandidate.capture.platform} · spending money but showing fewer results.`,
      });
    }
    keySignals.push({
      label: 'Confidence',
      title: 'Visible rows only',
      details: 'Spot check only.',
    });
    keySignals.push({
      label: 'Platforms',
      title: platforms.join(' · '),
      details: `${orderedCaptures.length} tables in this session`,
    });
    keySignals.push({
      label: 'Review confidence',
      title: 'Visible rows only',
      details: 'Session-only prototype',
    });

    const focus = watchCandidate
      ? `${watchLabel} is the main watch item because it is spending money but showing fewer results.`
      : conversionCandidate
        ? `${conversionLabel || conversionCandidate.capture.platform} appears to be producing the clearest results.`
        : spendCandidate
          ? `${spendLabel} is spending the most money.`
          : 'Treat this as a visible-table spot check.';

    const topFinding = focus;

    const attention = [
      spendCandidate ? `Check ${spendLabel} first. It is where mistakes cost the most.` : 'Check the highest-spend item first. It is where mistakes cost the most.',
      conversionCandidate ? `Protect ${conversionLabel || 'the best-performing item'} if it keeps producing results efficiently.` : 'Do not increase budget until another review confirms the pattern.',
      platformAdvice(watchCandidate?.capture?.platform),
    ];

    const nextSteps = [
      spendCandidate ? `Check ${spendLabel} first. It is where mistakes cost the most.` : 'Check the highest-spend item first. It is where mistakes cost the most.',
      conversionCandidate ? `Protect ${conversionLabel || 'the best-performing item'} if it keeps producing results efficiently.` : 'Do not increase budget until another review confirms the pattern.',
      platformAdvice(watchCandidate?.capture?.platform),
    ];

    return {
      mode: 'bundle',
      success: true,
      platform: 'Captured tables',
      tableKind: 'bundle',
      rowsDetected: orderedCaptures.reduce((sum, capture) => sum + (capture.rowsDetected || 0), 0),
      columnsDetected: orderedCaptures.reduce((sum, capture) => sum + (capture.columnsDetected || 0), 0),
      metricColumns: uniquePlatforms(orderedCaptures.flatMap((capture) => capture.metricColumns || [])),
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
      sources: orderedCaptures,
      platforms,
    };
  };

  const addVisibleTable = async () => {
    if (pendingRequestId) return;
    pendingRequestId = (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    $('addVisibleTable').textContent = 'Adding…';
    $('addVisibleTable').disabled = true;
    $('focusText').textContent = 'Reading the visible table…';
    clearActionError();
    setStatus('Reading the visible table you chose to add.');

    const result = await requestTableReview();
    pendingRequestId = null;
    $('addVisibleTable').textContent = 'Add table';
    $('addVisibleTable').disabled = false;

    if (!result.ok) {
      const error = result.error || {};
      const message = error.userMessage || error.message || 'Couldn’t read this table yet.';
      currentPageDebug.contentScriptLoaded = Boolean(result.contentScriptLoaded);
      currentPageDebug.lastExtractionStatus = message;
      currentPageDebug.lastError = error.message || message;
      setStatus(message);
      setActionError(message);
      renderDebugState();
      return;
    }

    clearActionError();
    const payload = result.payload || EMPTY_ANALYSIS;
    applyDebugState({
      host: currentPageDebug.host,
      path: currentPageDebug.path,
      url: currentPageDebug.url,
      platform: payload.platform || currentPageDebug.platform,
      contentScriptLoaded: true,
      storageAvailable: currentPageDebug.storageAvailable,
      lastExtractionStatus: payload.success
        ? `Captured ${payload.platform || 'table'}`
        : (payload.summary?.executiveFinding || 'Couldn’t find a visible campaign table on this page.'),
      rowsDetected: Number.isFinite(payload.rowsDetected) ? payload.rowsDetected : currentPageDebug.rowsDetected,
      columnsDetected: Number.isFinite(payload.columnsDetected) ? payload.columnsDetected : currentPageDebug.columnsDetected,
      metricColumns: Array.isArray(payload.metricColumns) ? payload.metricColumns : currentPageDebug.metricColumns,
      lastError: payload.error || '',
    });

    if (!payload.success) {
      const message = payload.summary?.executiveFinding || 'Couldn’t find a visible campaign table on this page.';
      setStatus(message);
      setActionError(message);
      if (!capturedTables.length) {
        setAnalysis({
          ...EMPTY_ANALYSIS,
          summary: {
            ...EMPTY_ANALYSIS.summary,
            executiveFinding: message,
            attention: payload.summary?.attention || EMPTY_ANALYSIS.summary.attention,
            privacyNote: payload.summary?.privacyNote || EMPTY_ANALYSIS.summary.privacyNote,
          },
        });
      }
      return;
    }

    const capture = normaliseCapture(payload);
    upsertCapturedTable(capture);
    setAnalysis(makeStaleAnalysis());
    refreshBundleDebugState();
    renderCapturedTables();
    setStatus(capturedTables.length === 1
      ? '1 table added. Analyse again for an updated focus.'
      : `${capturedTables.length} tables added. Analyse again for an updated focus.`);
    try {
      const storageResult = await persistCapturedTables();
      if (storageResult?.ok === false) throw new Error(storageResult.error || 'Storage write failed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Storage write failed');
      currentPageDebug.lastError = message;
      setActionError(`Storage write failed: ${message}`);
      setStatus(`Storage write failed: ${message}`);
    }
  };

  const analyseNow = () => {
    if (!capturedTables.length) {
      setStatus('Add a table first.');
      return;
    }
    const analysis = capturedTables.length === 1
      ? buildSingleReview(capturedTables[0])
      : buildBundleReview(capturedTables);
    setAnalysis(analysis);
    analysisMeta.lastAnalysedSignature = buildBundleSignature(capturedTables);
    analysisMeta.analysedAt = Date.now();
    persistAnalysisMeta().catch(() => {});
    refreshBundleDebugState();
    renderCapturedTables();
    setStatus(capturedTables.length === 1
      ? 'Analysis ready.'
      : 'Analysis ready.');
  };

  const clearCapturedTables = async () => {
    pendingRequestId = null;
    capturedTables = [];
    analysisMeta = { lastAnalysedSignature: '', analysedAt: 0 };
    setAnalysis(EMPTY_ANALYSIS);
    renderCapturedTables();
    renderDebugState();
    $('addVisibleTable').textContent = 'Add table';
    $('addVisibleTable').disabled = false;
    setStatus('Only the visible table you choose. Nothing runs in the background.');
    await storageRemove(STORAGE_KEY);
    await storageRemove(ANALYSIS_META_KEY);
  };

  const boot = async () => {
    const close = $('closePanel');
    const addButton = $('addVisibleTable');
    const analyseNowButton = $('analyseNow');
    const clearCapturedTablesButton = $('clearCapturedTables');

    await loadCapturedTables();
    await loadAnalysisMeta();
    renderCapturedTables();
    if (capturedTables.length && buildBundleSignature(capturedTables) === analysisMeta.lastAnalysedSignature) {
      setAnalysis(capturedTables.length === 1 ? buildSingleReview(capturedTables[0]) : buildBundleReview(capturedTables));
      refreshBundleDebugState();
    } else if (capturedTables.length) {
      setAnalysis(makeStaleAnalysis());
      refreshBundleDebugState();
    } else {
      setAnalysis(EMPTY_ANALYSIS);
      refreshBundleDebugState();
    }
    await refreshActiveContext();

    if (tabsApi?.onActivated?.addListener) {
      tabsApi.onActivated.addListener(() => { scheduleContextRefresh(); });
    }
    if (tabsApi?.onUpdated?.addListener) {
      tabsApi.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status || changeInfo.url || tab?.active) scheduleContextRefresh();
      });
    }
    activeRefreshTimer = window.setInterval(() => { scheduleContextRefresh(); }, 1500);

    close?.addEventListener('click', async () => {
      const closed = await closePanelView();
      if (!closed) {
        setStatus('Could not close the panel.');
      }
    });

    addButton?.addEventListener('click', addVisibleTable);
    analyseNowButton?.addEventListener('click', analyseNow);
    clearCapturedTablesButton?.addEventListener('click', clearCapturedTables);

    renderDebugState();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch(() => {}); }, { once: true });
  } else {
    boot().catch(() => {});
  }

  window.addEventListener('beforeunload', () => {
    if (activeRefreshTimer) window.clearInterval(activeRefreshTimer);
    if (contextRefreshScheduled) window.clearTimeout(contextRefreshScheduled);
  });
})();
