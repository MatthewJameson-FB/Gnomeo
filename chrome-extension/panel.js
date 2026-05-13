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
    reviewConfidence: 'visible only',
    previewRows: [],
    summary: {
      executiveFinding: 'Add a table.',
      keySignals: [],
      attention: [
        'Gnomeo only reviews visible tables.',
        'Nothing runs in the background.',
        'Try another table if this page is not right.',
      ],
      privacyNote: 'Visible only.',
    },
    sources: [],
  };

  let pendingRequestId = null;
  let capturedTables = [];
  let currentAnalysis = EMPTY_ANALYSIS;
  const STORAGE_KEY = 'gnomeo-captured-tables';
  const ANALYSIS_META_KEY = 'gnomeo-analysis-meta';
  const WORKSPACE_KEY = 'gnomeo-workspace-connection';
  const sessionStorageApi = globalThis.chrome?.storage?.session || null;
  const localStorageApi = globalThis.chrome?.storage?.local || null;
  const tabsApi = globalThis.chrome?.tabs || null;
  const sidePanelApi = globalThis.chrome?.sidePanel || null;
  const runtimeApi = globalThis.chrome?.runtime || null;
  const isLocalFixtureHost = () => ['localhost', '127.0.0.1'].includes((currentPageDebug.host || '').toLowerCase());

  let analysisMeta = {
    lastAnalysedSignature: '',
    analysedAt: 0,
  };
  let workspaceConnection = {
    rawInput: '',
    token: '',
    origin: 'https://www.gnomeo.nl',
    workspaceName: '',
    portalUrl: '',
  };
  let workspaceSaving = false;
  let workspacePromptOpen = false;
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

  const CHIP_VARIANTS = ['chip--info', 'chip--warn', 'chip--success', 'chip--neutral', 'chip--error'];

  const setChipText = (el, text, variant = 'info', hidden = false) => {
    if (!el) return;
    el.classList.remove(...CHIP_VARIANTS);
    el.classList.add(`chip--${variant}`);
    el.textContent = String(text || '');
    el.hidden = hidden;
  };

  const clearActionError = () => setActionError('');

  const getSourceProgressState = (count = 0) => {
    if (count <= 0) {
      return { label: '0 sources · hungry', copy: 'Ready for a table.', filled: 0, tone: 'neutral' };
    }
    if (count === 1) {
      return { label: '1 source · nibble', copy: 'Need one more.', filled: 1, tone: 'info' };
    }
    if (count === 2) {
      return { label: '2 sources · getting fed', copy: 'Almost there.', filled: 2, tone: 'success' };
    }
    return { label: '3+ sources · well fed', copy: 'Good to go.', filled: 3, tone: 'success' };
  };

  const renderSourceProgress = () => {
    const count = capturedTables.length;
    const state = getSourceProgressState(count);
    const label = $('sourceProgressLabel');
    const copy = $('sourceCopy');
    const segments = $('sourceMeter')?.querySelectorAll('.source-segment') || [];
    if (label) {
      label.textContent = state.label;
      label.className = `chip chip--${state.tone === 'success' ? 'success' : state.tone === 'info' ? 'info' : 'neutral'}`;
    }
    if (copy) copy.textContent = state.copy;
    segments.forEach((segment, index) => {
      segment.className = 'source-segment';
      if (state.filled >= 3) {
        segment.classList.add('is-filled-3');
      } else if (index < state.filled) {
        segment.classList.add(`is-filled-${Math.max(1, state.filled)}`);
      }
    });
  };

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

  const localGet = async (key) => {
    if (!localStorageApi) return null;
    return await new Promise((resolve) => {
      localStorageApi.get([key], (result) => resolve(result?.[key] ?? null));
    });
  };

  const localSet = async (key, value) => {
    if (!localStorageApi) return;
    await new Promise((resolve) => {
      localStorageApi.set({ [key]: value }, () => {
        if (runtimeApi?.lastError?.message) {
          resolve({ ok: false, error: runtimeApi.lastError.message });
          return;
        }
        resolve({ ok: true });
      });
    });
  };

  const localRemove = async (key) => {
    if (!localStorageApi) return;
    await new Promise((resolve) => {
      localStorageApi.remove(key, () => {
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

  const normalizeWorkspaceInput = (value = '') => String(value || '').trim();

  const extractWorkspaceConnection = (input = '') => {
    const rawInput = normalizeWorkspaceInput(input);
    if (!rawInput) return { rawInput: '', token: '', origin: '', portalUrl: '' };

    const defaultOrigin = 'https://www.gnomeo.nl';
    const tokenPattern = /^[A-Za-z0-9_-]{16,}$/;
    if (tokenPattern.test(rawInput) && !rawInput.includes('://')) {
      return {
        rawInput,
        token: rawInput,
        origin: defaultOrigin,
        portalUrl: `${defaultOrigin.replace(/\/$/, '')}/portal.html?token=${encodeURIComponent(rawInput)}`,
      };
    }

    try {
      const parsed = new URL(rawInput);
      const token = parsed.searchParams.get('token') || parsed.searchParams.get('portal_token') || parsed.pathname.split('/').filter(Boolean).pop() || '';
      const cleanToken = tokenPattern.test(token) ? token.trim() : '';
      const origin = `${parsed.protocol}//${parsed.host}`;
      return {
        rawInput,
        token: cleanToken,
        origin,
        portalUrl: cleanToken ? `${origin.replace(/\/$/, '')}/portal.html?token=${encodeURIComponent(cleanToken)}` : rawInput,
      };
    } catch {
      return { rawInput, token: '', origin: defaultOrigin, portalUrl: rawInput };
    }
  };

  const normalizeWorkspaceState = (input = null) => {
    const parsed = input && typeof input === 'object' ? input : {};
    const rawInput = normalizeWorkspaceInput(parsed.rawInput || parsed.input || '');
    const extracted = extractWorkspaceConnection(rawInput);
    return {
      rawInput,
      token: normalizeWorkspaceInput(parsed.token || extracted.token || ''),
      origin: normalizeWorkspaceInput(parsed.origin || extracted.origin || 'https://www.gnomeo.nl') || 'https://www.gnomeo.nl',
      workspaceName: normalizeWorkspaceInput(parsed.workspaceName || parsed.workspace_name || ''),
      portalUrl: normalizeWorkspaceInput(parsed.portalUrl || parsed.portal_url || extracted.portalUrl || ''),
      saved: Boolean(parsed.saved),
    };
  };

  const workspaceApiBase = () => normalizeWorkspaceState(workspaceConnection).origin || 'https://www.gnomeo.nl';

  const workspaceApiUrl = (path) => {
    const base = workspaceApiBase();
    return new URL(path, base).toString();
  };

  const loadWorkspaceConnection = async () => {
    const stored = await localGet(WORKSPACE_KEY);
    workspaceConnection = normalizeWorkspaceState(stored);
    return workspaceConnection;
  };

  const persistWorkspaceConnection = async () => {
    const result = await localSet(WORKSPACE_KEY, workspaceConnection);
    if (result?.ok === false) throw new Error(result.error || 'Workspace connection write failed');
  };

  const clearWorkspaceConnection = async () => {
    workspaceConnection = normalizeWorkspaceState(null);
    await localRemove(WORKSPACE_KEY);
  };

  const parseConnectedWorkspace = async (input) => {
    const extracted = extractWorkspaceConnection(input);
    if (!extracted.token) {
      throw new Error('Paste a valid private workspace link or token.');
    }
    const verificationUrl = `${workspaceApiUrl('/api/portal/workspace')}?token=${encodeURIComponent(extracted.token)}`;
    const response = await fetch(verificationUrl, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.workspace) {
      throw new Error(data?.error || 'That workspace link could not be verified.');
    }
    return {
      rawInput: extracted.rawInput,
      token: extracted.token,
      origin: extracted.origin || 'https://www.gnomeo.nl',
      workspaceName: data.workspace.workspace_name || '',
      portalUrl: data.portal_url || extracted.portalUrl || '',
    };
  };

  const setWorkspaceStatus = (message = '') => {
    const el = $('workspaceStatusLine');
    if (el) el.textContent = String(message || 'Want deeper memory?');
  };

  const setWorkspaceError = (message = '') => {
    const el = $('workspaceError');
    if (!el) return;
    const text = String(message || '').trim();
    el.hidden = !text;
    el.textContent = text;
  };

  const renderWorkspaceSection = () => {
    const flags = getVisibilityFlags();
    const connected = Boolean(workspaceConnection?.token);
    const promptOpen = Boolean(workspacePromptOpen && flags.hasFreshAnalysis && !connected);
    const visible = promptOpen;
    const miniVisible = flags.canShowWorkspace && connected;
    const workspaceCard = $('workspaceCard');
    const workspaceMiniRow = $('workspaceMiniRow');
    const workspaceAction = $('workspaceAction');
    const workspaceMiniStatus = $('workspaceMiniStatus');
    const workspaceMiniOpen = $('workspaceMiniOpen');
    const workspaceChangeMini = $('workspaceChangeMini');
    const disconnected = $('workspaceDisconnected');
    const closed = $('workspaceClosed');
    const chip = $('workspaceConnectionChip');
    const cancelButton = $('workspaceCancelConnect');
    const changeButton = $('workspaceChange');
    const openLink = $('openWorkspaceLink');
    const inlineLinks = $('workspaceInlineLinks');
    const input = $('workspaceLinkInput');
    const statusLine = $('workspaceStatusLine');

    if (!flags.hasFreshAnalysis && workspacePromptOpen) workspacePromptOpen = false;

    if (workspaceCard) workspaceCard.hidden = !visible;
    if (workspaceMiniRow) workspaceMiniRow.hidden = !miniVisible;
    if (!flags.hasSources || !flags.hasFreshAnalysis) {
      if (workspaceCard) workspaceCard.hidden = true;
      if (workspaceMiniRow) workspaceMiniRow.hidden = true;
      if (workspaceAction) workspaceAction.hidden = true;
      if (disconnected) disconnected.hidden = true;
      if (closed) closed.hidden = true;
      setChipText(chip, 'Workspace ready', 'success', true);
      if (statusLine) statusLine.hidden = true;
      if (workspaceMiniStatus) workspaceMiniStatus.hidden = true;
      if (workspaceMiniOpen) workspaceMiniOpen.hidden = true;
      if (workspaceChangeMini) workspaceChangeMini.hidden = true;
      if (inlineLinks) inlineLinks.hidden = true;
      if (changeButton) changeButton.hidden = true;
      if (cancelButton) cancelButton.hidden = true;
      if (openLink) openLink.hidden = true;
      if (input) input.value = '';
      return;
    }

    setChipText(chip, 'Workspace ready', 'success', !connected);
    if (closed) closed.hidden = !promptOpen;
    if (statusLine) {
      statusLine.textContent = connected
        ? (workspaceConnection.saved ? 'Saved.' : 'Ready to save.')
        : 'Paste your private workspace link.';
      statusLine.hidden = !promptOpen;
    }
    if (workspaceAction) {
      workspaceAction.hidden = !flags.canShowWorkspace || promptOpen || connected;
      workspaceAction.textContent = 'Save to workspace';
      workspaceAction.disabled = workspaceSaving;
    }
    if (workspaceMiniStatus) {
      workspaceMiniStatus.hidden = !(flags.canShowWorkspace && connected);
      workspaceMiniStatus.textContent = workspaceConnection.saved ? 'Saved.' : 'Connected.';
    }
    if (workspaceMiniOpen) {
      const href = workspaceConnection.portalUrl || workspaceConnection.rawInput || '';
      const canOpen = Boolean(href) && connected && flags.canShowWorkspace;
      workspaceMiniOpen.hidden = !canOpen;
      if (canOpen) workspaceMiniOpen.href = href;
    }
    if (workspaceChangeMini) {
      workspaceChangeMini.hidden = !(flags.canShowWorkspace && connected);
    }
    if (disconnected) disconnected.hidden = !promptOpen;
    if (inlineLinks) inlineLinks.hidden = true;
    if (changeButton) changeButton.hidden = !connected;
    if (cancelButton) cancelButton.hidden = !promptOpen;
    if (openLink) {
      const href = workspaceConnection.portalUrl || workspaceConnection.rawInput || '';
      const canOpen = Boolean(href);
      openLink.hidden = true;
      if (canOpen) openLink.href = href;
    }
    if (input && promptOpen && !connected) {
      input.value = workspaceConnection.rawInput || '';
    }
  };

  const connectWorkspaceFromInput = async () => {
    const input = $('workspaceLinkInput');
    const value = input ? input.value : '';
    setWorkspaceError('');
    try {
      const verified = await parseConnectedWorkspace(value);
      workspaceConnection = normalizeWorkspaceState({
        rawInput: verified.rawInput,
        token: verified.token,
        origin: verified.origin,
        workspaceName: verified.workspaceName,
        portalUrl: verified.portalUrl,
        saved: false,
      });
      await persistWorkspaceConnection();
      workspacePromptOpen = false;
      setWorkspaceStatus(verified.workspaceName ? `Workspace ready · ${verified.workspaceName}` : 'Workspace ready.');
      renderWorkspaceSection();
      setStatus('Workspace ready.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Workspace connection failed');
      setWorkspaceError(message);
      setStatus(message);
    }
  };

  const disconnectWorkspace = async () => {
    await clearWorkspaceConnection();
    workspacePromptOpen = false;
    setWorkspaceStatus('Want deeper memory?');
    setWorkspaceError('');
    renderWorkspaceSection();
    setStatus('Workspace disconnected.');
  };

  const buildExtensionReviewPayload = () => {
    const decision = deriveDecisionCard(currentAnalysis);
    const level = currentAnalysis.mode === 'bundle' ? 'cross_platform_spot_check' : 'one_page_spot_check';
    const summary = currentAnalysis.summary || EMPTY_ANALYSIS.summary;
    const tables = Array.isArray(currentAnalysis.sources) ? currentAnalysis.sources : [];
    return {
      source: 'chrome_extension',
      review_level: level,
      platforms: Array.isArray(decision.platforms) ? decision.platforms.slice(0, 6) : [currentAnalysis.platform || 'Unknown'],
      top_finding: decision.fixFirst || currentAnalysis.focus || summary.executiveFinding || 'Visible only.',
      next_steps: [decision.nextBest].filter(Boolean),
      fix_first: {
        label: decision.fixFirst,
        reason: decision.why,
        platform: Array.isArray(decision.platforms) ? decision.platforms[0] || currentAnalysis.platform || 'Unknown' : currentAnalysis.platform || 'Unknown',
        action: decision.nextBest,
      },
      why: decision.why,
      next_best: {
        label: decision.nextBest,
        action: decision.nextBest,
        platform: Array.isArray(decision.platforms) ? decision.platforms[0] || currentAnalysis.platform || 'Unknown' : currentAnalysis.platform || 'Unknown',
      },
      evidence: decision.evidence,
      key_signals: Array.isArray(summary.keySignals) ? summary.keySignals.slice(0, 5).map((item) => `${item.label}: ${item.title}${item.details ? ` — ${item.details}` : ''}`) : [],
      table_summaries: tables.map((capture) => ({
        platform: capture.platform || 'Unknown',
        rows_detected: capture.rowsDetected || 0,
        metric_columns: Array.isArray(capture.metricColumns) ? capture.metricColumns.slice(0, 10) : [],
        captured_at: new Date(capture.capturedAt || Date.now()).toISOString(),
        top_derived_signals: [
          capture.decisionMatrix?.watchItem ? `${capture.decisionMatrix.watchItem.label || capture.decisionMatrix.watchItem.title || 'Watch item'}` : '',
          capture.decisionMatrix?.highestSpend ? `${capture.decisionMatrix.highestSpend.label || capture.decisionMatrix.highestSpend.title || 'Highest spend'}` : '',
          capture.decisionMatrix?.efficientPerformer ? `${capture.decisionMatrix.efficientPerformer.label || capture.decisionMatrix.efficientPerformer.title || 'Best efficiency'}` : '',
          capture.decisionMatrix?.lowDataItems?.[0]?.visibleDataNote || '',
        ].filter(Boolean).slice(0, 3),
      })),
      visible_rows_note: 'This review only uses the visible table(s) you chose to save.',
      confidence_note: decision.caveat || currentAnalysis.reviewConfidence || 'visible only · user-triggered extension save',
      expected_impact: decision.fixFirst || summary.executiveFinding || 'Keeps the memory useful.',
      generated_at: new Date().toISOString(),
      report_markdown: buildReportMarkdown(),
    };
  };

  const saveReviewToWorkspace = async () => {
    if (!currentAnalysis.success || !workspaceConnection.token || workspaceSaving) return;
    workspaceSaving = true;
    setWorkspaceError('');
    renderWorkspaceSection();
    setStatus('Saving review to workspace…');
    try {
      const response = await fetch(workspaceApiUrl('/api/portal?action=extension-review'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-portal-token': workspaceConnection.token,
        },
        body: JSON.stringify(buildExtensionReviewPayload()),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !data?.saved) {
        throw new Error(data?.error || 'Could not save this review right now.');
      }
      workspaceConnection = normalizeWorkspaceState({
        ...workspaceConnection,
        origin: workspaceConnection.origin || extractWorkspaceConnection(workspaceConnection.rawInput).origin,
        workspaceName: data.workspace_name || data.workspace?.workspace_name || workspaceConnection.workspaceName || '',
        portalUrl: data.portal_url || data.workspace_url || workspaceConnection.portalUrl || '',
        saved: true,
      });
      await persistWorkspaceConnection();
      renderWorkspaceSection();
      setWorkspaceStatus(data.workspace_name ? `Workspace ready · ${data.workspace_name}` : 'Workspace ready.');
      setStatus('Saved to workspace.');
      setWorkspaceError('');
      if (data.portal_url || data.workspace_url) {
        const link = $('openWorkspaceLink');
        if (link) {
          link.href = data.portal_url || data.workspace_url;
          link.hidden = false;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Could not save this review right now.');
      setWorkspaceError(`Could not save. Download instead. ${message}`.trim());
      setStatus('Could not save. Download instead.');
    } finally {
      workspaceSaving = false;
      renderWorkspaceSection();
    }
  };

  const triggerPrimaryAction = async () => {
    const action = derivePrimaryActionState();
    if (action.mode === 'add') {
      await addVisibleTable();
      return;
    }
    if (action.mode === 'analyse') {
      analyseNow();
      return;
    }
    if (action.mode === 'save') {
      await saveReviewToWorkspace();
      return;
    }
    workspacePromptOpen = true;
    setWorkspaceError('');
    renderWorkspaceSection();
    const input = $('workspaceLinkInput');
    if (input) {
      input.focus();
      input.select();
    }
  };

  const triggerWorkspaceMiniAction = async () => {
    const analysisReady = Boolean(currentAnalysis.success && !currentAnalysis.stale);
    if (!analysisReady) return;
    if (workspaceConnection.token) {
      const href = workspaceConnection.portalUrl || workspaceConnection.rawInput || '';
      if (href) window.open(href, '_blank', 'noreferrer');
      return;
    }
    workspacePromptOpen = true;
    setWorkspaceError('');
    renderWorkspaceSection();
    const input = $('workspaceLinkInput');
    if (input) {
      input.focus();
      input.select();
    }
  };

  const queryActiveTab = async () => {
    if (!tabsApi?.query) {
      return { ok: false, error: { stage: 'active-tab', message: 'chrome.tabs.query is unavailable', userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } };
    }
    return await new Promise((resolve) => {
      tabsApi.query({ active: true, currentWindow: true }, (tabs) => {
        const message = runtimeApi?.lastError?.message || '';
        if (message) {
          resolve({ ok: false, error: { stage: 'active-tab', message, userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } });
          return;
        }
        if (!Array.isArray(tabs) || !tabs.length || !tabs[0]?.id) {
          resolve({ ok: false, error: { stage: 'active-tab', message: 'No active tab found', userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } });
          return;
        }
        resolve({ ok: true, tab: tabs[0] });
      });
    });
  };

  const sendMessageToTab = async (tabId, message) => {
    if (!tabsApi?.sendMessage) {
      return { ok: false, error: { stage: 'message-send', message: 'chrome.tabs.sendMessage is unavailable', userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } };
    }
    return await new Promise((resolve) => {
      tabsApi.sendMessage(tabId, message, (response) => {
        const messageText = runtimeApi?.lastError?.message || '';
        if (messageText) {
          resolve({ ok: false, error: { stage: 'message-send', message: messageText, userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } });
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
      : { ok: false, error: response.response?.error || { stage: 'extractor', message: 'Extraction failed', userMessage: 'Gnomeo could not read the table yet.' }, tab: activeTab.tab, contentScriptLoaded: true };
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
      currentPageDebug.lastExtractionStatus = response.error?.userMessage || 'Open Google Ads, Meta Ads, or LinkedIn.';
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

  function chipHTML(text, variant = 'info') {
    return `<span class="chip chip--${variant}">${escapeHtml(text)}</span>`;
  }

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
      executiveFinding: 'Tables changed. Analyse.',
      attention: ['Analyse.'],
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
    const reviewCountText = bundleCount === 0
      ? '0 sources · hungry'
      : analysisFresh
        ? `${bundleCount} sources · well fed`
        : `${bundleCount} sources · getting fed`;
    const tableCountText = `${bundleCount} table${bundleCount === 1 ? '' : 's'} added`;
    const addedPlatforms = sortPlatformNames(capturedTables.map((item) => item.platform));
    const addedText = addedPlatforms.length ? addedPlatforms.join(', ') : 'None yet';
    let note = '';
    if (!supported) {
      note = 'Open Google Ads, Meta Ads, or LinkedIn.';
    } else if (state === 'empty') {
      note = 'Add a table.';
    } else if (state === 'current-added') {
      note = analysisFresh ? 'This table is already added.' : 'Analyse.';
    } else {
      note = analysisFresh ? 'Current ad page not added yet.' : 'Analyse.';
    }
    return {
      state,
      supported,
      currentPlatform,
      currentCaptureKey,
      currentCaptureAdded,
      bundleCount,
      tableCountText,
      reviewCountText,
      addedText,
      note,
      analysisFresh,
      canAddTable: supported,
      buttonLabel: bundleCount > 0 && currentCaptureAdded ? 'Update table' : 'Add table',
      statusLine: !supported
        ? 'Open Google Ads, Meta Ads, or LinkedIn.'
      : bundleCount === 0
          ? '0 sources · hungry'
          : state === 'current-added'
            ? (analysisFresh ? 'This table is already added.' : 'Analyse.')
            : state === 'current-missing'
              ? (analysisFresh ? 'Current ad page not added yet.' : 'Analyse.')
              : 'Open Google Ads, Meta Ads, or LinkedIn.',
      summaryChip: analysisFresh ? 'Analysis ready' : (bundleCount ? 'Needs analysis' : 'No analysis yet'),
    };
  };

  const derivePrimaryActionState = () => {
    const bundleCount = capturedTables.length;
    const analysisFresh = captureAnalysisFreshness();
    const analysedBefore = Boolean(analysisMeta.analysedAt);
    const currentCaptureAdded = derivePanelState().currentCaptureAdded;
    if (bundleCount === 0) {
      return { label: 'Add table', mode: 'add' };
    }
    if (!currentCaptureAdded) {
      return { label: 'Add/update', mode: 'add' };
    }
    if (!analysisFresh || currentAnalysis.stale || !currentAnalysis.success || !analysedBefore) {
      return { label: 'Analyse', mode: 'analyse' };
    }
    if (workspaceConnection.token) {
      return { label: 'Save to workspace', mode: 'save' };
    }
    return { label: 'Save to workspace', mode: 'prompt' };
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
    return items.slice(0, 1).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
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

  const pad2 = (value) => String(value).padStart(2, '0');

  const formatLocalDateStamp = (date = new Date()) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

  const formatLocalDateTime = (date = new Date()) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

  const buildReportMarkdown = () => {
    if (!currentAnalysis || !currentAnalysis.success) {
      return [
        '# Gnomeo',
        '',
        'Feed Gnomeo a table first.',
        '',
        'Caveat: visible only.',
      ].join('\n');
    }

    const summary = currentAnalysis.summary || EMPTY_ANALYSIS.summary;
    const level = currentAnalysis.reviewLevel || (currentAnalysis.mode === 'bundle' ? 'spot check' : 'visible only');
    const platforms = Array.isArray(currentAnalysis.platforms) && currentAnalysis.platforms.length
      ? currentAnalysis.platforms.join(', ')
      : (currentAnalysis.platform || '—');
    const keySignals = Array.isArray(summary.keySignals) ? summary.keySignals.slice(0, 5) : [];
    const attention = Array.isArray(summary.attention) ? summary.attention.slice(0, 3) : [];
    const workspaceState = workspaceConnection.saved ? 'saved' : (workspaceConnection.token ? 'connected' : 'not connected');
    const alsoProtect = currentAnalysis.nextBest || currentAnalysis.nextSteps?.[1] || currentAnalysis.nextSteps?.[0] || '';
    const lines = [
      '# Gnomeo',
      `First fix: ${currentAnalysis.focus || summary.executiveFinding || '—'}`,
      `Why: ${currentAnalysis.why || summary.attention?.[0] || '—'}`,
      ...(alsoProtect ? [`Also protect: ${alsoProtect}`] : []),
      '',
      '## Signals',
      ...keySignals.map((item) => `- ${item.label}: ${item.title}${item.details ? ` — ${item.details}` : ''}`),
      '',
      '## Sources',
      `- ${platforms}`,
      `- Review level: ${level}`,
      '',
      '## Next',
      ...(currentAnalysis.nextSteps || []).slice(0, 3).map((item, index) => `${index + 1}. ${item}`),
      '',
      '## Caveat',
      currentAnalysis.reviewConfidence || 'visible only',
      'Visible tables only.',
      '',
      '## Workspace',
      `- ${workspaceState}`,
      '',
      '## Notes',
      ...attention.map((item) => `- ${item}`),
    ];
    return lines.join('\n');
  };

  const deriveDecisionCard = (analysis = currentAnalysis) => {
    const summary = analysis?.summary || EMPTY_ANALYSIS.summary;
    const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const firstSentence = (value) => compact(String(value || '').split(/(?<=[.!?])\s+/)[0] || value);
    const firstCandidate = analysis?.fixFirst || (Array.isArray(analysis?.nextSteps) && analysis.nextSteps[0]) || analysis?.focus || summary.executiveFinding || 'Add a table to get your first recommendation.';
    const fixFirst = compact(firstCandidate).replace(/^Start with\s+/i, '').replace(/^Check\s+/i, 'Check ').replace(/^Review\s+/i, 'Review ');
    const whySource = analysis?.why || (Array.isArray(summary.attention) && summary.attention[0]) || (Array.isArray(summary.comparison) && summary.comparison[0]) || (Array.isArray(summary.keySignals) && summary.keySignals[0]?.details) || '';
    const why = firstSentence(whySource || 'It carries spend but shows weaker results than the other reviewed tables.');
    const nextBestRaw = analysis?.nextBest || (Array.isArray(analysis?.nextSteps) && analysis.nextSteps[1]) || (Array.isArray(analysis?.nextSteps) && analysis.nextSteps[0]) || 'Keep the strongest performer protected while it stays efficient.';
    const nextBest = firstSentence(nextBestRaw).replace(/^Keep\s+/i, 'Keep ');
    const evidence = Array.isArray(summary.keySignals) ? summary.keySignals.slice(0, 3).map((item) => compact([item.label, item.title, item.details].filter(Boolean).join(' — '))) : [];
    const platforms = Array.isArray(analysis?.platforms) ? analysis.platforms : [analysis?.platform || 'Local only'];
    return {
      fixFirst,
      why,
      nextBest,
      evidence,
      reviewLevel: analysis?.reviewLevel || (analysis?.mode === 'bundle' ? 'spot check' : 'visible only'),
      platforms,
      caveat: analysis?.reviewConfidence || 'visible only',
    };
  };

  const downloadAnalysis = () => {
    if (!currentAnalysis || !currentAnalysis.success) return;
    const html = buildPrintableReportHtml();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      setActionError('Pop-up blocked. Allow it to print / save as PDF.');
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const buildPrintableReportHtml = () => {
    if (!currentAnalysis || !currentAnalysis.success) return '';
    const summary = currentAnalysis.summary || EMPTY_ANALYSIS.summary;
    const decision = deriveDecisionCard(currentAnalysis);
    const platforms = Array.isArray(currentAnalysis.platforms) && currentAnalysis.platforms.length
      ? currentAnalysis.platforms.join(', ')
      : (currentAnalysis.platform || '—');
    const keySignals = Array.isArray(summary.keySignals) ? summary.keySignals.slice(0, 5) : [];
    const nextBest = decision.nextBest || currentAnalysis.nextBest || (currentAnalysis.nextSteps || [])[1] || (currentAnalysis.nextSteps || [])[0] || '—';
    const workspaceState = workspaceConnection.saved ? 'saved' : (workspaceConnection.token ? 'connected' : 'not connected');
    const title = `gnomeo-review-${formatLocalDateStamp(new Date())}`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, Arial, sans-serif; color: #102033; background: #fff; }
    .page { max-width: 760px; margin: 0 auto; padding: 0; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    h2 { margin: 18px 0 6px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #526477; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
    .chip { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 999px; font-size: 11px; background: #eef4fb; color: #23364d; }
    .answer { margin-top: 10px; padding: 14px; border-radius: 14px; border-left: 4px solid #1f3b61; background: linear-gradient(180deg, #f8fbff 0%, #edf5ef 100%); }
    .answer p { margin: 0; font-size: 16px; line-height: 1.4; font-weight: 700; }
    .why { margin-top: 6px; color: #526477; font-size: 12px; }
    .section { margin-top: 16px; padding-top: 12px; border-top: 1px solid #d9e4ef; }
    ul, ol { margin: 8px 0 0 18px; padding: 0; }
    li { margin: 0 0 6px; font-size: 12px; line-height: 1.45; }
    .fine { margin-top: 18px; color: #6b7b8d; font-size: 11px; }
    .kv { display: grid; gap: 6px; font-size: 12px; }
    .kv div { display: flex; gap: 8px; }
    .kv span { color: #6b7b8d; min-width: 110px; }
  </style>
</head>
<body>
  <div class="page">
    <h1>Gnomeo Review</h1>
    <div class="meta">
      <span class="chip">${escapeHtml(formatLocalDateTime(new Date()))}</span>
      <span class="chip">${escapeHtml(currentAnalysis.reviewLevel || (currentAnalysis.mode === 'bundle' ? 'spot check' : 'visible only'))}</span>
      <span class="chip">${escapeHtml(platforms)}</span>
    </div>

    <div class="answer">
      <p>${escapeHtml(currentAnalysis.focus || summary.executiveFinding || '—')}</p>
      <div class="why">Why: ${escapeHtml(currentAnalysis.why || summary.attention?.[0] || '—')}</div>
    </div>

    <div class="section">
      <h2>Also protect</h2>
      <p style="margin:0;font-size:12px;line-height:1.45;">${escapeHtml(nextBest)}</p>
    </div>

    <div class="section">
      <h2>Key signals</h2>
      <ul>
        ${keySignals.map((item) => `<li>${escapeHtml(item.label)}: ${escapeHtml(item.title)}${item.details ? ` — ${escapeHtml(item.details)}` : ''}</li>`).join('')}
      </ul>
    </div>

    <div class="section">
      <h2>Sources</h2>
      <div class="kv">
        <div><span>Platforms</span><strong>${escapeHtml(platforms)}</strong></div>
        <div><span>Review level</span><strong>${escapeHtml(currentAnalysis.reviewLevel || (currentAnalysis.mode === 'bundle' ? 'spot check' : 'visible only'))}</strong></div>
        <div><span>Workspace</span><strong>${escapeHtml(workspaceState)}</strong></div>
      </div>
    </div>

    <div class="section">
      <h2>Next</h2>
      <ol>
        ${(currentAnalysis.nextSteps || []).slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ol>
    </div>

    <div class="section">
      <h2>Caveat</h2>
      <p style="margin:0;font-size:12px;line-height:1.45;">${escapeHtml(currentAnalysis.reviewConfidence || 'visible only')} · visible tables only.</p>
    </div>

    <div class="fine">No raw rows, screenshots, or private workspace token.</div>
  </div>
  <script>
    window.addEventListener('load', () => setTimeout(() => window.print(), 150));
  </script>
</body>
</html>`;
  };

  const renderCapturedTables = () => {
    const container = $('capturedList');
    const hint = $('captureHint');
    const addVisibleTableButton = $('addVisibleTable');
    const primaryActionButton = $('primaryAction');
    const analyseNow = $('analyseNow');
    const detailsToggle = $('detailsToggle');
    const clearCapturedTablesButton = $('clearCapturedTables');
    const capturedCountInline = $('capturedCountInline');
    const captureContextLine = $('captureContextLine');

    const orderedTables = sortCapturedTables(capturedTables);
    const panelState = derivePanelState();
    const sourceState = getSourceProgressState(capturedTables.length);
    const primaryActionState = derivePrimaryActionState();

    if (addVisibleTableButton) {
      addVisibleTableButton.textContent = 'Add/update';
      addVisibleTableButton.hidden = capturedTables.length === 0;
      addVisibleTableButton.disabled = !panelState.canAddTable || Boolean(pendingRequestId);
    }
    if (primaryActionButton) {
      primaryActionButton.textContent = workspaceSaving ? 'Saving…' : primaryActionState.label;
      primaryActionButton.disabled = Boolean(pendingRequestId) || workspaceSaving;
    }
    if (capturedCountInline) {
      capturedCountInline.textContent = sourceState.label;
    }
    renderSourceProgress();
    analyseNow.textContent = 'Analyse again';
    analyseNow.hidden = !(currentAnalysis.success && !currentAnalysis.stale);
    analyseNow.disabled = Boolean(pendingRequestId);
    if (detailsToggle) {
      detailsToggle.disabled = capturedTables.length === 0;
      detailsToggle.hidden = capturedTables.length === 0;
    }
    clearCapturedTablesButton.hidden = !capturedTables.length;
    if (hint) hint.textContent = sourceState.copy;
    if (hint) hint.hidden = true;
    if (captureContextLine) {
      const currentPlatform = currentPageDebug.currentPlatform || currentPageDebug.platform || 'Unknown platform';
      const currentStatus = panelState.currentCaptureAdded ? 'added' : 'not added';
      captureContextLine.textContent = capturedTables.length ? `Current: ${currentPlatform} · ${currentStatus}` : 'Current: —';
    }
    const showStatus = panelState.state === 'unsupported';
    if ($('captureStatus')) {
      $('captureStatus').hidden = !showStatus;
      if (showStatus) $('captureStatus').textContent = panelState.statusLine || sourceState.label;
    }

    if (!orderedTables.length) {
      container.innerHTML = '<div class="captured-item"><strong>No sources yet</strong><span>Add a table.</span></div>';
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
    const hasSources = capturedTables.length > 0;
    const hasFreshAnalysis = Boolean(currentAnalysis.success && !currentAnalysis.stale && currentPageDebug.analysisFresh);
    const hasNextBest = Boolean(hasFreshAnalysis && currentAnalysis.nextBest);
    const canShowWorkspace = Boolean(hasFreshAnalysis);
    $('debugStateFlags').textContent = `hasSources=${hasSources ? 'true' : 'false'} · hasFreshAnalysis=${hasFreshAnalysis ? 'true' : 'false'} · hasNextBest=${hasNextBest ? 'true' : 'false'} · canShowWorkspace=${canShowWorkspace ? 'true' : 'false'} · capturedTables=${capturedTables.length} · analysisFresh=${currentPageDebug.analysisFresh ? 'true' : 'false'}`;
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
      currentPageDebug.lastExtractionStatus = error.userMessage || 'Open Google Ads, Meta Ads, or LinkedIn.';
      currentPageDebug.lastError = error.message || error.userMessage || 'No content script response on this page.';
      setStatus(error.userMessage || 'Open Google Ads, Meta Ads, or LinkedIn.');
      setActionError(error.userMessage || error.message || '');
      renderDebugState();
    }, 0);
  };

  const setStatus = (text) => {
    $('captureStatus').textContent = text;
  };

  const getVisibilityFlags = () => {
    const hasSources = capturedTables.length > 0;
    const hasFreshAnalysis = Boolean(hasSources && currentAnalysis.success && !currentAnalysis.stale && captureAnalysisFreshness());
    const hasNextBest = Boolean(hasFreshAnalysis && currentAnalysis.nextBest);
    const canShowWorkspace = Boolean(hasFreshAnalysis);
    return { hasSources, hasFreshAnalysis, hasNextBest, canShowWorkspace };
  };

  const setAnalysis = (analysis) => {
    currentAnalysis = analysis || EMPTY_ANALYSIS;
    const summary = currentAnalysis.summary || EMPTY_ANALYSIS.summary;
    const focusCard = $('focusCard');
    const focusText = $('focusText');
    const focusWhy = $('focusWhy');
    const focusConfidence = $('focusConfidence');
    const nextStepsCard = $('nextStepsCard');
    const nextStepsList = $('nextStepsList');
    const reviewContent = $('reviewContent');
    const panelState = derivePanelState();
    const reportText = $('fullReportText');
    const reportSummary = $('reportSummary');
    const downloadButton = $('downloadAnalysis');
    const analyseNowButton = $('analyseNow');
    const decision = deriveDecisionCard(currentAnalysis);
    const confidenceVariant = currentAnalysis.stale ? 'warn' : (currentAnalysis.success ? 'info' : 'neutral');
    const flags = getVisibilityFlags();
    const ready = flags.hasFreshAnalysis;

    if (analyseNowButton) {
      analyseNowButton.textContent = currentAnalysis.success && !currentAnalysis.stale ? 'Analyse again' : 'Analyse';
    }

    setChipText(
      $('sourceChip'),
      currentAnalysis.success && currentAnalysis.mode === 'bundle'
        ? `${currentAnalysis.sources.length} tables`
        : currentAnalysis.success && currentAnalysis.mode === 'single'
          ? currentAnalysis.platform || 'Local only'
          : (currentAnalysis.stale ? 'Needs analysis' : 'Local only'),
      currentAnalysis.success ? 'info' : (currentAnalysis.stale ? 'warn' : 'neutral')
    );

    const meta = [];
    if (currentAnalysis.success) {
      if (currentAnalysis.mode === 'bundle') {
        meta.push(chipHTML(`Tables: ${formatNumber(currentAnalysis.sources.length || 0)}`, 'info'));
        meta.push(chipHTML(`Platforms: ${currentAnalysis.platforms.join(', ') || '—'}`, 'neutral'));
      } else {
        meta.push(chipHTML(currentAnalysis.platform || 'Unknown platform', 'info'));
        meta.push(chipHTML(`Rows: ${formatNumber(currentAnalysis.rowsDetected || 0)}`, 'neutral'));
        meta.push(chipHTML(`Columns: ${formatNumber(currentAnalysis.columnsDetected || 0)}`, 'neutral'));
        if (Array.isArray(currentAnalysis.metricColumns) && currentAnalysis.metricColumns.length) meta.push(chipHTML(`Metrics: ${currentAnalysis.metricColumns.join(', ')}`, 'neutral'));
      }
      meta.push(chipHTML(currentAnalysis.reviewConfidence || 'visible only', confidenceVariant));
    } else if (currentAnalysis.stale) {
      meta.push(chipHTML('Needs analysis', 'warn'));
      meta.push(chipHTML(panelState.tableCountText, 'neutral'));
    } else {
      meta.push(chipHTML('Local only', 'neutral'));
      meta.push(chipHTML('visible only', 'info'));
    }
    $('metaRow').innerHTML = meta.join('');
    focusCard.classList.toggle('is-ready', ready);
    focusCard.classList.toggle('is-stale', currentAnalysis.stale);
    focusCard.classList.toggle('is-empty', !ready && !currentAnalysis.stale);
    focusCard.hidden = false;
    nextStepsCard.hidden = !flags.hasNextBest;
    reviewContent.hidden = !currentAnalysis.success && !currentAnalysis.stale;
    if (downloadButton) downloadButton.disabled = !currentAnalysis.success;
    if (reportSummary) {
      reportSummary.textContent = currentAnalysis.success
        ? 'Open for the full note.'
        : (currentAnalysis.stale ? 'Analyse to refresh.' : 'Add a table.');
    }
    if (reportText) {
      reportText.textContent = currentAnalysis.success ? buildReportMarkdown() : (currentAnalysis.stale ? 'Analyse to refresh.' : 'Add a table.');
    }
    if (currentAnalysis.success) {
      focusText.textContent = decision.fixFirst || currentAnalysis.focus || summary.executiveFinding || EMPTY_ANALYSIS.summary.executiveFinding;
      if (focusWhy) focusWhy.textContent = `Why: ${decision.why || 'It spends, but the result signal is weaker.'}`;
      setChipText(focusConfidence, decision.caveat || 'visible only', confidenceVariant);
      $('keySignals').innerHTML = renderLines(summary.keySignals.slice(0, 5), 'No visible signals found yet.');
      $('visiblePreview').innerHTML = renderPreview(currentAnalysis.previewRows);
      $('attentionList').innerHTML = renderLines(summary.attention.slice(0, 3), 'No attention notes yet.');
      nextStepsList.innerHTML = renderSteps([decision.nextBest].filter(Boolean), 'Add a table first.');
    } else if (currentAnalysis.stale) {
      focusText.textContent = 'Analyse to find the first fix.';
      if (focusWhy) focusWhy.textContent = 'The tables changed.';
      setChipText(focusConfidence, 'Needs analysis', 'warn');
      $('keySignals').innerHTML = '';
      $('visiblePreview').innerHTML = '';
      $('attentionList').innerHTML = '';
      nextStepsList.innerHTML = renderSteps([], 'Analyse');
    } else {
      focusText.textContent = 'Feed me a campaign table to start.';
      if (focusWhy) focusWhy.textContent = 'Then I’ll tell you the first fix.';
      setChipText(focusConfidence, 'hungry', 'neutral');
      $('keySignals').innerHTML = renderLines(summary.keySignals.slice(0, 5), 'No visible signals found yet.');
      $('visiblePreview').innerHTML = renderPreview(currentAnalysis.previewRows);
      $('attentionList').innerHTML = renderLines(summary.attention.slice(0, 3), 'No attention notes yet.');
      nextStepsList.innerHTML = renderSteps([], 'Add a table.');
    }
    renderWorkspaceSection();
  };

  const normaliseCapture = (payload) => ({
    mode: 'single',
    success: true,
    platform: payload.platform || 'Local only',
    tableKind: payload.tableKind || 'table',
    rowsDetected: payload.rowsDetected || 0,
    columnsDetected: payload.columnsDetected || 0,
    metricColumns: Array.isArray(payload.metricColumns) ? payload.metricColumns : [],
    reviewConfidence: payload.reviewConfidence || 'visible only',
    reviewLevel: payload.reviewLevel || 'visible only',
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
    const reviewLevel = capture.reviewLevel || matrix.reviewLevel || 'visible only';
    const reviewConfidence = capture.reviewConfidence || matrix.confidence || 'visible only';

    const focus = watchItem
      ? `Check ${rowLabel(watchItem)} before adding budget.`
      : 'The rows are still too limited.';

    const nextSteps = [
      watchItem ? `Check ${rowLabel(watchItem)} before adding budget.` : 'Check the highest-spend row before adding budget.',
      efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference
        ? `Keep ${rowLabel(efficientPerformer)} protected for now.`
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
        ? `${formatNumber(watchItem.spend, 2)} spent · ${Number.isFinite(watchItem.resultValue) ? `${formatNumber(watchItem.resultValue)} ${watchItem.resultLabel}` : 'weak results'}`
        : 'Meaningful spend · weak results' });
    }
    if (lowDataItem) {
      keySignals.push({ label: 'Low data', title: rowLabel(lowDataItem), details: lowDataItem.visibleDataNote });
    }
    keySignals.push({ label: 'Review level', title: reviewLevel, details: 'visible only' });

    const attention = [
      watchItem ? `${rowLabel(watchItem)} is the main watch item.` : 'Check the highest-spend row first.',
      lowDataItem && lowDataItem.rowReference !== watchItem?.rowReference
        ? `${rowLabel(lowDataItem)} is still low confidence.`
        : (efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference ? `Keep ${rowLabel(efficientPerformer)} protected.` : 'Keep the clearer performer protected.'),
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
      fixFirst: nextSteps[0] || focus,
      why: summary.attention?.[0] || summary.comparison?.[0] || summary.keySignals?.[0]?.details || '',
      nextBest: nextSteps[1] || nextSteps[0] || '',
      evidence: keySignals.slice(0, 3),
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
    const summary = orderedCaptures[0]?.summary || EMPTY_ANALYSIS.summary;
    const allRows = orderedCaptures.flatMap((capture) => (capture.decisionMatrix?.rows || []).map((row) => ({ ...row, platform: capture.platform })));
    const platforms = sortPlatformNames(orderedCaptures.map((capture) => capture.platform));
    const multiPlatform = platforms.length > 1;
    const reviewLevel = multiPlatform ? 'spot check' : 'visible only';
    const reviewConfidence = multiPlatform ? 'spot check' : 'visible only';

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
    if (watchItem) keySignals.push({ label: 'Main watch item', title: rowLabel(watchItem), details: `${shortPlatformName(watchItem.platform)} · ${Number.isFinite(watchItem.spend) ? `${formatNumber(watchItem.spend, 2)} spent` : 'meaningful spend'}${Number.isFinite(watchItem.resultValue) ? ` · ${formatNumber(watchItem.resultValue)} ${watchItem.resultLabel}` : ' · weak results'}` });
    if (lowDataItem) keySignals.push({ label: 'Low data', title: rowLabel(lowDataItem), details: lowDataItem.visibleDataNote });
    keySignals.push({ label: 'Review level', title: reviewLevel, details: 'visible only' });

    const topFinding = watchItem
      ? `Check ${rowLabel(watchItem)} first.${efficientPerformer && efficientPerformer.rowReference !== watchItem.rowReference ? ` ${rowLabel(efficientPerformer)} looks safer to protect.` : ''}`
      : 'The rows are still too limited.';

    const attention = [
      watchItem ? `Check ${rowLabel(watchItem)} before adding budget.` : 'Check the highest-spend row before adding budget.',
      efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference
        ? `Keep ${rowLabel(efficientPerformer)} protected.`
        : 'Keep the clearer performer protected.',
      platformActionHint(watchItem?.platform || highestSpend?.platform || efficientPerformer?.platform, watchItem?.label || highestSpend?.label || efficientPerformer?.label || ''),
    ];

    if (lowDataItem && lowDataItem.rowReference !== watchItem?.rowReference) {
      attention.splice(1, 0, `Treat ${rowLabel(lowDataItem)} as low confidence. Do not overreact until the visible volume improves.`);
    }

    const nextSteps = [
      watchItem ? `Check ${rowLabel(watchItem)} before adding budget.` : 'Check the highest-spend row before adding budget.',
      efficientPerformer && efficientPerformer.rowReference !== watchItem?.rowReference
        ? `Keep ${rowLabel(efficientPerformer)} protected.`
        : 'Keep the clearer performer protected.',
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
      fixFirst: nextSteps[0] || topFinding,
      why: summary.attention?.[0] || summary.comparison?.[0] || summary.keySignals?.[0]?.details || '',
      nextBest: nextSteps[1] || nextSteps[0] || '',
      evidence: keySignals.slice(0, 3),
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
    setStatus(derivePanelState().reviewCountText);
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
    setStatus(derivePanelState().reviewCountText);
  };

  const clearCapturedTables = async () => {
    pendingRequestId = null;
    capturedTables = [];
    analysisMeta = { lastAnalysedSignature: '', analysedAt: 0 };
    workspacePromptOpen = false;
    setAnalysis(EMPTY_ANALYSIS);
    renderCapturedTables();
    renderDebugState();
    $('addVisibleTable').textContent = 'Add table';
    $('addVisibleTable').disabled = false;
    setStatus('0 sources · hungry');
    await storageRemove(STORAGE_KEY);
    await storageRemove(ANALYSIS_META_KEY);
  };

  const boot = async () => {
    const close = $('closePanel');
    const primaryActionButton = $('primaryAction');
    const addButton = $('addVisibleTable');
    const analyseNowButton = $('analyseNow');
    const detailsToggleButton = $('detailsToggle');
    const clearCapturedTablesButton = $('clearCapturedTables');
    const downloadAnalysisButton = $('downloadAnalysis');
    const workspaceConnectButton = $('workspaceConnect');
    const workspaceCancelConnectButton = $('workspaceCancelConnect');
    const workspaceChangeButton = $('workspaceChange');
    const workspaceActionButton = $('workspaceAction');
    const workspaceChangeMiniButton = $('workspaceChangeMini');

    await loadCapturedTables();
    await loadAnalysisMeta();
    await loadWorkspaceConnection();
    if (workspaceConnection.token) {
      try {
        const verified = await parseConnectedWorkspace(workspaceConnection.rawInput || workspaceConnection.portalUrl || workspaceConnection.token);
        workspaceConnection = normalizeWorkspaceState({
          ...workspaceConnection,
          rawInput: verified.rawInput,
          token: verified.token,
          origin: verified.origin,
          workspaceName: verified.workspaceName,
          portalUrl: verified.portalUrl,
          saved: Boolean(workspaceConnection.saved),
        });
        await persistWorkspaceConnection();
      } catch {
        await clearWorkspaceConnection();
      }
    }
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
    renderWorkspaceSection();
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

    primaryActionButton?.addEventListener('click', triggerPrimaryAction);
    addButton?.addEventListener('click', addVisibleTable);
    analyseNowButton?.addEventListener('click', analyseNow);
    detailsToggleButton?.addEventListener('click', () => {
      const details = $('detailsCard');
      const review = $('reviewContent');
      if (review && review.hidden) return;
      if (details) details.open = true;
      details?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    clearCapturedTablesButton?.addEventListener('click', clearCapturedTables);
    downloadAnalysisButton?.addEventListener('click', downloadAnalysis);
    workspaceConnectButton?.addEventListener('click', connectWorkspaceFromInput);
    workspaceCancelConnectButton?.addEventListener('click', () => {
      workspacePromptOpen = false;
      setWorkspaceError('');
      renderWorkspaceSection();
    });
    workspaceActionButton?.addEventListener('click', triggerWorkspaceMiniAction);
    workspaceChangeMiniButton?.addEventListener('click', () => {
      workspacePromptOpen = true;
      setWorkspaceError('');
      renderWorkspaceSection();
      const input = $('workspaceLinkInput');
      if (input) {
        input.focus();
        input.select();
      }
    });
    workspaceChangeButton?.addEventListener('click', async () => {
      workspacePromptOpen = true;
      workspaceConnection = normalizeWorkspaceState({
        rawInput: workspaceConnection.rawInput || workspaceConnection.portalUrl || '',
        token: '',
        origin: workspaceConnection.origin || 'https://www.gnomeo.nl',
        workspaceName: '',
        portalUrl: '',
        saved: false,
      });
      setWorkspaceError('');
      renderWorkspaceSection();
      const input = $('workspaceLinkInput');
      if (input) {
        input.value = workspaceConnection.rawInput || '';
        input.focus();
        input.select();
      }
      setStatus('Paste your private workspace link again if you want to change it.');
    });

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
