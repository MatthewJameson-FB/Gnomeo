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
    supportedPage: false,
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
      if (path.includes('google-ads-campaigns')) return 'Google Ads';
      if (path.includes('meta-ads-campaigns')) return 'Meta Ads';
      if (path.includes('linkedin-ads-campaigns')) return 'LinkedIn Campaign Manager';
      if (path.includes('no-table')) return 'No table';
      if (path.includes('/test-pages/') || path.endsWith('/test-pages/')) return 'Local test page';
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
      currentPageDebug.supportedPage = isSupportedPlatform(currentPageDebug.currentPlatform);
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
      currentPageDebug.supportedPage = isSupportedPlatform(currentPageDebug.currentPlatform);
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

  const isSupportedPlatform = (platform) => {
    const value = String(platform || '').trim();
    return /^google ads$/i.test(value)
      || /^meta ads$/i.test(value)
      || /^linkedin campaign manager$/i.test(value);
  };

  const derivePanelState = () => {
    const bundleCount = capturedTables.length;
    const currentPlatform = platformLabelFromState();
    const supported = isSupportedPlatform(currentPlatform);
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

  const shortPlatformName = (platform) => {
    const value = displayPlatformName(platform);
    if (value === 'Google Ads') return 'Google';
    if (value === 'Meta Ads') return 'Meta';
    if (value === 'LinkedIn Campaign Manager') return 'LinkedIn';
    return value;
  };

  const rowReference = (row, multiPlatform = false) => {
    const label = String(row?.label || row?.title || row?.platform || '').trim();
    if (!label) return 'Row';
    if (!multiPlatform || !row?.platform) return label;
    return `${shortPlatformName(row.platform)} ${label}`;
  };

  const platformActionHint = (platform, label = '') => {
    const name = displayPlatformName(platform);
    const value = String(label || '').toLowerCase();
    const googleSearch = /search|brand search|generic search|competitor|keyword/.test(value);
    const googleShopping = /shopping|pmax|performance max|feed|product/.test(value);
    const metaRetargeting = /retarget|remarket|existing customer/.test(value);
    const metaProspecting = /prospecting|broad audience|lookalike|advantage\+/.test(value);
    const linkedInLeadGen = /lead gen|lead generation|lead form|company|job|abm/.test(value);
    const linkedInAwareness = /brand awareness|awareness|traffic/.test(value);

    if (name === 'Google Ads') {
      if (googleShopping) return 'For Google Shopping/PMax, check product/feed quality and value tracking.';
      if (googleSearch) return 'For Google Search, check search terms, keywords, and the landing page.';
      return 'For Google, check the query, landing page, and value tracking.';
    }
    if (name === 'Meta Ads') {
      if (metaRetargeting) return 'For Meta retargeting, check the audience, creative, offer, and landing page.';
      if (metaProspecting) return 'For Meta prospecting, check the audience, creative, offer, and landing page.';
      return 'For Meta, check the audience, creative, offer, and landing page.';
    }
    if (name === 'LinkedIn Campaign Manager') {
      if (linkedInLeadGen || linkedInAwareness) return 'For LinkedIn, check the audience, offer, lead form, and landing page.';
      return 'For LinkedIn, check the audience, offer, lead form, and landing page.';
    }
    if (name === 'Local test page') return 'For local fixtures, compare the visible rows and try another supported page if needed.';
    return 'Check the audience, offer, landing page, and tracking.';
  };

  const formatRowRef = (row, multiPlatform = false) => rowReference(row, multiPlatform);

  const platformAdvice = (platform, label = '') => platformActionHint(platform, label);

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
    $('debugSupportedPage').textContent = currentPageDebug.supportedPage ? 'Yes' : 'No';
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
    currentPageDebug.supportedPage = isSupportedPlatform(currentPageDebug.platform || currentPageDebug.currentPlatform || inferPlatformFromUrl(currentPageDebug.url));
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
      $('keySignals').innerHTML = renderLines(summary.keySignals.slice(0, 5), 'No visible signals found yet.');
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
      $('keySignals').innerHTML = renderLines(summary.keySignals.slice(0, 5), 'No visible signals found yet.');
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
    reviewLevel: payload.reviewLevel || 'One-page spot check',
    previewRows: Array.isArray(payload.previewRows) ? payload.previewRows.slice(0, 5) : [],
    summary: payload.summary || EMPTY_ANALYSIS.summary,
    snapshot: payload.snapshot || null,
    decisionMatrix: payload.decisionMatrix || null,
    capturedAt: Date.now(),
  });

  const buildSingleReview = (capture) => {
    if (!capture) return EMPTY_ANALYSIS;
    const summary = capture.summary || EMPTY_ANALYSIS.summary;
    const matrix = capture.decisionMatrix || {};
    const highestSpend = matrix.highestSpend || null;
    const strongestResult = matrix.strongestResult || null;
    const efficientPerformer = matrix.efficientPerformer || null;
    const watchItem = matrix.watchItem || highestSpend || efficientPerformer || null;
    const lowDataItem = (matrix.lowDataItems || [])[0] || null;
    const rowLabel = (row) => formatRowRef(row, false);
    const reviewLevel = capture.reviewLevel || matrix.reviewLevel || 'One-page spot check';
    const reviewConfidence = capture.reviewConfidence || matrix.confidence || `${reviewLevel} · visible rows only`;

    const focus = watchItem
      ? `On this page, ${rowLabel(watchItem)} is the main watch item because it is spending money with weaker visible results.${watchItem.visibleDataNote && watchItem.visibleDataNote.startsWith('Low data') ? ' The visible volume is still low, so do not overreact yet.' : ''}${efficientPerformer && efficientPerformer.rowReference !== watchItem.rowReference ? ` ${rowLabel(efficientPerformer)} looks safer to protect.` : ''}${highestSpend && highestSpend.rowReference !== watchItem.rowReference ? ` ${rowLabel(highestSpend)} is where mistakes cost the most.` : ''}`
      : 'On this page, the visible rows are still too limited for a confident read.';

    const nextSteps = [
      watchItem ? `Check ${rowLabel(watchItem)} first. It is where mistakes would hurt most.` : 'Check the highest-spend row first. It is where mistakes would hurt most.',
      efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference
        ? `Keep ${rowLabel(efficientPerformer)} protected for now. It appears to be producing results more efficiently.`
        : 'Keep the clearer performer protected for now.',
      platformAdvice(capture.platform, watchItem?.label || highestSpend?.label || ''),
    ];

    const keySignals = [];
    if (highestSpend) {
      keySignals.push({ label: 'Highest spend', title: rowLabel(highestSpend), details: Number.isFinite(highestSpend.spend) ? `${formatNumber(highestSpend.spend, 2)} spent` : 'Highest spend' });
    }
    if (strongestResult) {
      keySignals.push({ label: 'Strongest result signal', title: rowLabel(strongestResult), details: Number.isFinite(strongestResult.resultValue) ? `${formatNumber(strongestResult.resultValue)} ${strongestResult.resultLabel}` : 'Strongest visible result signal' });
    }
    if (efficientPerformer) {
      keySignals.push({ label: 'Best efficiency signal', title: rowLabel(efficientPerformer), details: Number.isFinite(efficientPerformer.efficiencyScore) ? `${formatNumber(efficientPerformer.efficiencyScore, 2)} ${efficientPerformer.roas ? 'ROAS' : 'result per spend'}` : 'Best visible efficiency signal' });
    }
    if (watchItem) {
      keySignals.push({ label: 'Main watch item', title: rowLabel(watchItem), details: Number.isFinite(watchItem.spend)
        ? `${formatNumber(watchItem.spend, 2)} spent · ${Number.isFinite(watchItem.resultValue) ? `${formatNumber(watchItem.resultValue)} ${watchItem.resultLabel}` : 'weak visible results'}`
        : 'Meaningful spend with weak visible results' });
    }
    if (lowDataItem) {
      keySignals.push({ label: 'Low data', title: rowLabel(lowDataItem), details: lowDataItem.visibleDataNote });
    }
    keySignals.push({ label: 'Review level', title: reviewLevel, details: 'Visible rows only' });

    const attention = [
      watchItem && watchItem.visibleDataNote && watchItem.visibleDataNote.startsWith('Low data')
        ? `${rowLabel(watchItem)} has spend, but the visible volume is still low. Do not overreact yet.`
        : (watchItem ? `${rowLabel(watchItem)} is the main watch item because it is spending money with weaker visible results.` : 'Check the highest-spend row first. It is where mistakes cost the most.'),
      lowDataItem && lowDataItem.rowReference !== watchItem?.rowReference
        ? `Treat ${rowLabel(lowDataItem)} as low confidence. Do not overreact until the visible volume improves.`
        : (efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference ? `Keep ${rowLabel(efficientPerformer)} protected for now. It looks like the safer performer.` : 'Keep the clearer performer protected for now.'),
      platformAdvice(capture.platform, watchItem?.label || highestSpend?.label || ''),
    ];

    const comparison = lowDataItem
      ? ['This is a visible-page spot check.', `${rowLabel(lowDataItem)} should be treated as low confidence.`]
      : ['This is a visible-page spot check.'];

    return {
      mode: 'single',
      success: true,
      platform: capture.platform,
      tableKind: capture.tableKind,
      rowsDetected: capture.rowsDetected,
      columnsDetected: capture.columnsDetected,
      metricColumns: capture.metricColumns,
      reviewConfidence,
      reviewLevel,
      previewRows: capture.previewRows,
      focus,
      nextSteps,
      summary: {
        executiveFinding: focus,
        keySignals,
        attention,
        comparison,
        privacyNote: summary.privacyNote || EMPTY_ANALYSIS.summary.privacyNote,
      },
      sources: [capture],
      platforms: [capture.platform],
    };
  };

  const buildBundleReview = (captures) => {
    if (!captures.length) return EMPTY_ANALYSIS;
    const orderedCaptures = sortCapturedTables(captures);
    const allRows = orderedCaptures.flatMap((capture) => (capture.decisionMatrix?.rows || []).map((row) => ({ ...row, platform: capture.platform })));
    const platforms = sortPlatformNames(orderedCaptures.map((capture) => capture.platform));
    const multiPlatform = platforms.length > 1;
    const reviewLevel = multiPlatform ? 'Cross-platform spot check' : 'One-page spot check';
    const reviewConfidence = `${reviewLevel} · visible rows only`;

    const bySpend = [...allRows].filter((row) => Number.isFinite(row.spend)).sort((a, b) => (b.spend - a.spend) || ((b.resultValue || 0) - (a.resultValue || 0)));
    const byResult = [...allRows].filter((row) => Number.isFinite(row.resultValue) || Number.isFinite(row.revenue)).sort((a, b) => {
      const aValue = Number.isFinite(a.resultValue) ? a.resultValue : (Number.isFinite(a.revenue) ? a.revenue : -1);
      const bValue = Number.isFinite(b.resultValue) ? b.resultValue : (Number.isFinite(b.revenue) ? b.revenue : -1);
      return (bValue - aValue) || ((a.spend || 0) - (b.spend || 0));
    });
    const byEfficiency = [...allRows].filter((row) => Number.isFinite(row.efficiencyScore) && row.efficiencyScore > 0).sort((a, b) => (b.efficiencyScore - a.efficiencyScore) || ((a.spend || 0) - (b.spend || 0)));
    const byWatch = [...allRows].filter((row) => Number.isFinite(row.spend) && row.spend > 0).map((row) => {
      const weakSignal = Number.isFinite(row.resultValue) ? row.resultValue : 0;
      const efficiencyPenalty = Number.isFinite(row.efficiencyScore) ? row.efficiencyScore : 0;
      const lowDataPenalty = row.visibleDataNote?.startsWith('Low data') ? 2 : 0;
      return { ...row, watchScore: (row.spend || 0) - (weakSignal * 10) - (efficiencyPenalty * 1000) - (lowDataPenalty * 500) };
    }).sort((a, b) => (b.watchScore - a.watchScore) || (b.spend - a.spend));

    const highestSpend = bySpend[0] || null;
    const strongestResult = byResult[0] || null;
    const efficientPerformer = byEfficiency[0] || strongestResult || highestSpend || null;
    const watchItem = byWatch[0] || highestSpend || efficientPerformer || null;
    const lowDataItem = [...allRows].filter((row) => row.visibleDataNote?.startsWith('Low data'))[0] || null;
    const rowLabel = (row) => formatRowRef(row, multiPlatform);

    const keySignals = [];
    if (highestSpend) keySignals.push({ label: 'Highest spend', title: rowLabel(highestSpend), details: `${shortPlatformName(highestSpend.platform)} · ${formatNumber(highestSpend.spend, 2)} spent` });
    if (strongestResult) keySignals.push({ label: 'Strongest result signal', title: rowLabel(strongestResult), details: Number.isFinite(strongestResult.resultValue) ? `${formatNumber(strongestResult.resultValue)} ${strongestResult.resultLabel}` : 'Strongest visible result signal' });
    if (efficientPerformer) keySignals.push({ label: 'Best efficiency signal', title: rowLabel(efficientPerformer), details: Number.isFinite(efficientPerformer.efficiencyScore) ? `${formatNumber(efficientPerformer.efficiencyScore, 2)} ${efficientPerformer.roas ? 'ROAS' : 'result per spend'}` : 'Best visible efficiency signal' });
    if (watchItem) keySignals.push({ label: 'Main watch item', title: rowLabel(watchItem), details: `${shortPlatformName(watchItem.platform)} · ${Number.isFinite(watchItem.spend) ? `${formatNumber(watchItem.spend, 2)} spent` : 'meaningful spend'}${Number.isFinite(watchItem.resultValue) ? ` · ${formatNumber(watchItem.resultValue)} ${watchItem.resultLabel}` : ' · weak visible results'}` });
    if (lowDataItem) keySignals.push({ label: 'Low data', title: rowLabel(lowDataItem), details: lowDataItem.visibleDataNote });
    keySignals.push({ label: 'Review level', title: reviewLevel, details: 'Visible rows only' });

    const topFinding = watchItem
      ? `${multiPlatform ? 'Across the visible tables' : 'On this page'}, ${rowLabel(watchItem)} is the main watch item because it is spending money with weaker visible results.${watchItem.visibleDataNote && watchItem.visibleDataNote.startsWith('Low data') ? ' The visible volume is still low, so do not overreact yet.' : ''}${efficientPerformer && efficientPerformer.rowReference !== watchItem.rowReference ? ` ${rowLabel(efficientPerformer)} looks safer to protect.` : ''}${highestSpend && highestSpend.rowReference !== watchItem.rowReference ? ` ${rowLabel(highestSpend)} is where mistakes cost the most.` : ''}`
      : `${multiPlatform ? 'Across the visible tables' : 'On this page'}, the visible rows are still too limited for a confident read.`;

    const attention = [
      watchItem && watchItem.visibleDataNote && watchItem.visibleDataNote.startsWith('Low data')
        ? `${rowLabel(watchItem)} has spend, but the visible volume is still low. Do not overreact yet.`
        : (watchItem ? `Check ${rowLabel(watchItem)} first. It is where mistakes would hurt most.` : 'Check the highest-spend row first. It is where mistakes would hurt most.'),
      efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference
        ? `Keep ${rowLabel(efficientPerformer)} protected for now. It looks like the safer performer.`
        : 'Keep the clearer performer protected for now.',
      platformActionHint(watchItem?.platform || highestSpend?.platform || efficientPerformer?.platform, watchItem?.label || highestSpend?.label || efficientPerformer?.label || ''),
    ];

    if (lowDataItem && lowDataItem.rowReference !== watchItem?.rowReference) {
      attention.splice(1, 0, `Treat ${rowLabel(lowDataItem)} as low confidence. Do not overreact until the visible volume improves.`);
    }

    const nextSteps = [
      watchItem ? `Check ${rowLabel(watchItem)} first. It is where mistakes would hurt most.` : 'Check the highest-spend row first. It is where mistakes would hurt most.',
      efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference
        ? `Keep ${rowLabel(efficientPerformer)} protected for now. It appears to be producing results more efficiently.`
        : 'Keep the clearer performer protected for now.',
      platformActionHint(watchItem?.platform || highestSpend?.platform || efficientPerformer?.platform, watchItem?.label || highestSpend?.label || efficientPerformer?.label || ''),
    ];

    const previewRows = orderedCaptures.flatMap((capture) => capture.previewRows.slice(0, 2).map((row) => ({ ...row, source: capture.platform }))).slice(0, 5);
    const comparison = lowDataItem
      ? ['This is a visible-page spot check.', `${rowLabel(lowDataItem)} should be treated as low confidence.`]
      : ['This is a visible-page spot check.'];

    return {
      mode: 'bundle',
      success: true,
      platform: 'Captured tables',
      tableKind: 'bundle',
      rowsDetected: orderedCaptures.reduce((sum, capture) => sum + (capture.rowsDetected || 0), 0),
      columnsDetected: orderedCaptures.reduce((sum, capture) => sum + (capture.columnsDetected || 0), 0),
      metricColumns: uniquePlatforms(orderedCaptures.flatMap((capture) => capture.metricColumns || [])),
      reviewConfidence,
      reviewLevel,
      previewRows,
      focus: topFinding,
      nextSteps,
      summary: {
        executiveFinding: topFinding,
        keySignals,
        attention,
        comparison,
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
