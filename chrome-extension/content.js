(() => {
  if (window.__gnomeoReviewLayerInjected) return;
  window.__gnomeoReviewLayerInjected = true;

  const isLocalTestHost = ['localhost', '127.0.0.1'].includes(location.hostname.toLowerCase());
  const sidePanelApi = globalThis.chrome?.sidePanel || null;
  const tabsApi = globalThis.chrome?.tabs || null;
  const debug = (...args) => {
    if (isLocalTestHost) console.debug('[Gnomeo]', ...args);
  };

  const host = document.createElement('div');
  host.id = 'gnomeo-review-opener-host';
  host.setAttribute('aria-live', 'polite');
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .button {
        position: fixed;
        right: 18px;
        bottom: 18px;
        pointer-events: auto;
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: rgba(248, 250, 252, 0.96);
        color: #0f172a;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .button::before {
        content: '';
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #64748b;
        display: inline-block;
      }
    </style>
    <div class="wrap">
      <button class="button" type="button">Review with Gnomeo</button>
    </div>
  `;

  (document.documentElement || document.body || document.head).appendChild(host);

  const button = shadow.querySelector('.button');
  const supportsSidePanel = Boolean(sidePanelApi?.open);

  const queryActiveWindow = async () => {
    if (!tabsApi?.query) {
      return { ok: false, error: { stage: 'active-window', message: 'chrome.tabs.query is unavailable', userMessage: 'Open a supported campaign table, then click Add table.' } };
    }
    return await new Promise((resolve) => {
      tabsApi.query({ active: true, currentWindow: true }, (tabs) => {
        const message = globalThis.chrome?.runtime?.lastError?.message || '';
        if (message) {
          resolve({ ok: false, error: { stage: 'active-window', message, userMessage: 'Open a supported campaign table, then click Add table.' } });
          return;
        }
        if (!Array.isArray(tabs) || !tabs.length || !tabs[0]?.id) {
          resolve({ ok: false, error: { stage: 'active-window', message: 'No active tab found', userMessage: 'Open a supported campaign table, then click Add table.' } });
          return;
        }
        resolve({ ok: true, tab: tabs[0] });
      });
    });
  };

  const openSidePanel = async () => {
    if (!supportsSidePanel) return { ok: false, error: { stage: 'side-panel', message: 'chrome.sidePanel is unavailable', userMessage: '' } };
    const activeWindow = await queryActiveWindow();
    if (!activeWindow.ok) return activeWindow;
    try {
      await sidePanelApi.open({ windowId: activeWindow.tab.windowId });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Side panel open failed');
      return { ok: false, error: { stage: 'side-panel', message, userMessage: 'Open a supported campaign table, then click Add table.' } };
    }
  };

  button.addEventListener('click', async () => {
    const result = await openSidePanel();
    if (result.ok) {
      debug('side panel opened');
      return;
    }
    debug('side panel open failed', result.error?.message || result.error?.userMessage || 'unknown');
  });

  const detectPlatform = () => {
    const bodyPlatform = normalizeText(document.body?.dataset?.gnomeoPlatform || '');
    const metaPlatform = normalizeText(document.querySelector('meta[name="gnomeo-platform"]')?.content || '');
    if (bodyPlatform) return bodyPlatform;
    if (metaPlatform) return metaPlatform;
    const hostName = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    if (hostName.includes('google.com') && path.includes('/')) return 'Google Ads';
    if (hostName.includes('facebook.com') || hostName.includes('meta.com')) return 'Meta Ads';
    if (hostName.includes('linkedin.com') && path.includes('/campaignmanager')) return 'LinkedIn Campaign Manager';
    if (hostName === 'localhost' || hostName === '127.0.0.1') return 'Local test page';
    return 'Unknown platform';
  };

  const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  const isVisible = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return el.getClientRects().length > 0;
  };

  const getVisibleText = (el) => {
    if (!isVisible(el)) return '';
    const text = normalizeText(el.innerText || el.textContent || '');
    return text;
  };

  const getRowElements = (container) => {
    if (container.tagName === 'TABLE') {
      return Array.from(container.querySelectorAll('tr')).filter(isVisible);
    }
    return Array.from(container.querySelectorAll('[role="row"], tr')).filter(isVisible);
  };

  const getCellElements = (row) => {
    const selectors = [
      ':scope > th',
      ':scope > td',
      ':scope > [role="columnheader"]',
      ':scope > [role="cell"]',
    ].join(', ');
    let cells = Array.from(row.querySelectorAll(selectors)).filter(isVisible);
    if (cells.length < 2) {
      cells = Array.from(row.children || []).filter(isVisible);
    }
    return cells.filter((cell) => getVisibleText(cell));
  };

  const textIsNumeric = (text) => /^[£€$]?\s*-?[\d,.]+(?:\s*%|x)?$/i.test(normalizeText(text));

  const detectMetricKind = (text) => {
    const value = normalizeText(text).toLowerCase();
    if (/\broas\b/.test(value)) return 'roas';
    if (/\bcpa\b|cost per result|cost per action/.test(value)) return 'cpa';
    if (/\bcpc\b|cost per click/.test(value)) return 'cpc';
    if (/\bctr\b|click-through/.test(value)) return 'ctr';
    if (/\bspend\b|\bcost\b|amount spent|media spend/.test(value)) return 'spend';
    if (/\bclicks\b/.test(value)) return 'clicks';
    if (/\bimpressions\b/.test(value)) return 'impressions';
    if (/\bconversions?\b|\bresults?\b|all conversions?/.test(value)) return 'conversions';
    if (/\brevenue\b|\bvalue\b|conversion value/.test(value)) return 'revenue';
    return '';
  };

  const detectLabelKind = (text) => {
    const value = normalizeText(text).toLowerCase();
    if (/campaign/.test(value)) return 'campaign';
    if (/ad set/.test(value)) return 'ad set';
    if (/ad group/.test(value)) return 'ad group';
    if (/ad name/.test(value)) return 'ad name';
    if (/keyword|search term/.test(value)) return 'keyword';
    if (/source|name|label/.test(value)) return 'name';
    return '';
  };

  const parseCell = (text) => {
    const raw = normalizeText(text);
    if (!raw) return { raw: '', type: 'text', value: null, currency: '' };
    const percent = raw.match(/^(-?\d[\d,.]*)\s*%$/);
    if (percent) return { raw, type: 'percent', value: Number(percent[1].replace(/,/g, '')), currency: '' };
    const ratio = raw.match(/^(-?\d[\d,.]*)x$/i);
    if (ratio) return { raw, type: 'ratio', value: Number(ratio[1].replace(/,/g, '')), currency: '' };
    const currency = raw.match(/^([£€$])\s*(-?[\d,.]+(?:\.\d+)?)$/) || raw.match(/^(-?[\d,.]+(?:\.\d+)?)\s*([£€$])$/);
    if (currency) {
      const symbol = currency[1] && /[£€$]/.test(currency[1]) ? currency[1] : currency[2];
      const number = Number(String(currency[1] && /[£€$]/.test(currency[1]) ? currency[2] : currency[1]).replace(/,/g, ''));
      return { raw, type: 'currency', value: Number.isFinite(number) ? number : null, currency: symbol || '' };
    }
    const number = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(number) && !textIsNumeric(raw) && !/\s/.test(raw)) return { raw, type: 'number', value: number, currency: '' };
    if (Number.isFinite(number)) return { raw, type: 'number', value: number, currency: '' };
    return { raw, type: 'text', value: null, currency: '' };
  };

  const looksLikeHeaderRow = (row, maybeNextRow) => {
    if (!row) return false;
    const cells = row.cells;
    if (!cells || cells.length < 2) return false;
    if (row.hasHeaderCells) return true;
    const textCells = cells.filter((cell) => !textIsNumeric(cell));
    if (textCells.length === cells.length && cells.some((cell) => detectMetricKind(cell) || detectLabelKind(cell))) return true;
    if (maybeNextRow) {
      const nextNumericCount = maybeNextRow.cells.filter((cell) => textIsNumeric(cell)).length;
      const thisNumericCount = cells.filter((cell) => textIsNumeric(cell)).length;
      if (thisNumericCount < nextNumericCount && cells.some((cell) => /campaign|ad set|ad group|spend|clicks|results?|value|roas|cpa/i.test(cell))) return true;
    }
    return false;
  };

  const extractCandidate = (container) => {
    const rows = getRowElements(container).map((row) => {
      const cells = getCellElements(row).map((cell) => getVisibleText(cell)).filter(Boolean);
      return {
        row,
        cells,
        hasHeaderCells: Boolean(row.querySelector('th,[role="columnheader"]')),
      };
    }).filter((entry) => entry.cells.length >= 2);

    if (rows.length < 2) return null;

    let headerIndex = rows.findIndex((entry) => entry.hasHeaderCells);
    if (headerIndex < 0 && looksLikeHeaderRow(rows[0], rows[1])) headerIndex = 0;

    let headers = [];
    let dataRows = rows;
    if (headerIndex >= 0) {
      headers = rows[headerIndex].cells;
      dataRows = rows.slice(headerIndex + 1);
    } else {
      headers = rows[0].cells.map((_, index) => `Column ${index + 1}`);
    }

    if (!dataRows.length) return null;

    const maxColumns = Math.max(headers.length, ...dataRows.map((entry) => entry.cells.length));
    while (headers.length < maxColumns) headers.push(`Column ${headers.length + 1}`);

    const metricColumns = [];
    const labelColumns = [];
    headers.forEach((header, index) => {
      const metricKind = detectMetricKind(header);
      if (metricKind) metricColumns.push({ index, kind: metricKind, label: header });
      const labelKind = detectLabelKind(header);
      if (labelKind) labelColumns.push({ index, kind: labelKind, label: header });
    });

    const sampleCellsByColumn = headers.map((_, index) => dataRows.slice(0, 5).map((row) => row.cells[index]).filter(Boolean));
    metricColumns.forEach((column) => {
      if (!sampleCellsByColumn[column.index].length) return;
      const rawValues = sampleCellsByColumn[column.index];
      if (!rawValues.some((cell) => /[£€$%x]/i.test(cell)) && !/roas|cpa|cpc|ctr|spend|cost|clicks|impressions|conversion|result|value/i.test(column.label)) {
        // Keep only likely metric columns.
        column.kind = '';
      }
    });

    const filteredMetricColumns = metricColumns.filter((column) => column.kind);
    const inferredLabelIndex = labelColumns[0]?.index ?? headers.findIndex((header, index) => {
      if (filteredMetricColumns.some((column) => column.index === index)) return false;
      return sampleCellsByColumn[index].some((cell) => !textIsNumeric(cell));
    });
    const labelIndex = inferredLabelIndex >= 0 ? inferredLabelIndex : 0;

    const parsedRows = dataRows.map((entry) => {
      const cells = headers.map((_, index) => entry.cells[index] || '');
      const label = normalizeText(cells[labelIndex] || cells.find((cell, index) => index !== labelIndex && !textIsNumeric(cell)) || cells[0] || 'Row');
      const metrics = {};
      filteredMetricColumns.forEach((column) => {
        metrics[column.kind] = parseCell(cells[column.index]);
      });
      return { label, cells, metrics };
    }).filter((row) => row.cells.some((cell) => normalizeText(cell)));

    const numericScore = (row) => {
      const spend = row.metrics.spend?.value ?? null;
      const conversions = row.metrics.conversions?.value ?? row.metrics.results?.value ?? null;
      const roas = row.metrics.roas?.value ?? null;
      return {
        spend: Number.isFinite(spend) ? spend : -1,
        conversions: Number.isFinite(conversions) ? conversions : -1,
        roas: Number.isFinite(roas) ? roas : -1,
      };
    };

    const score = parsedRows.length * 10 + filteredMetricColumns.length * 5 + (headerIndex >= 0 ? 5 : 0) + (container.tagName === 'TABLE' ? 4 : 0);
    return {
      container,
      kind: container.tagName === 'TABLE' ? 'table' : (container.getAttribute('role') || 'grid'),
      headers,
      dataRows: parsedRows,
      metricColumns: filteredMetricColumns,
      labelIndex,
      score,
      numericScore,
    };
  };

  const collectCandidates = () => {
    const roots = Array.from(document.querySelectorAll('table, [role="grid"], [role="table"]')).filter(isVisible);
    const candidates = roots.map(extractCandidate).filter(Boolean);
    const rowGroups = Array.from(document.querySelectorAll('[role="row"]'))
      .filter(isVisible)
      .map((row) => ({
        container: row,
        kind: 'row',
        headers: Array.from(getCellElements(row)).map((cell, index) => normalizeText(cell) || `Column ${index + 1}`),
        dataRows: [],
        metricColumns: [],
        labelIndex: 0,
        score: 0,
        numericScore: () => ({ spend: -1, conversions: -1, roas: -1 }),
      }));
    if (!candidates.length && rowGroups.length) {
      // Not enough structure to use alone, but keep a minimal fallback candidate if rows are clearly visible.
      const rowTexts = rowGroups.slice(0, 5).map((row) => normalizeText(row.container.innerText || row.container.textContent || '')).filter(Boolean);
      if (rowTexts.length >= 2) {
        const fallback = {
          container: rowGroups[0].container,
          kind: 'row-group',
          headers: rowGroups[0].headers,
          dataRows: rowTexts.map((text, index) => ({ label: text.split(' · ')[0] || `Row ${index + 1}`, cells: [text], metrics: {} })),
          metricColumns: [],
          labelIndex: 0,
          score: rowTexts.length,
          numericScore: () => ({ spend: -1, conversions: -1, roas: -1 }),
        };
        candidates.push(fallback);
      }
    }
    return candidates.sort((a, b) => b.score - a.score);
  };

  const formatMoney = (value, currency = '') => {
    if (!Number.isFinite(Number(value))) return '—';
    const raw = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(Number(value));
    return `${currency || ''}${raw}`;
  };

  const formatPlain = (value, digits = 0) => {
    if (!Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(value));
  };

  const buildReview = (candidate, platform) => {
    const rows = candidate.dataRows || [];
    const labelIndex = candidate.labelIndex ?? 0;
    const spendRow = rows.filter((row) => Number.isFinite(row.metrics.spend?.value)).sort((a, b) => (b.metrics.spend.value - a.metrics.spend.value))[0] || null;
    const conversionRow = rows.filter((row) => Number.isFinite(row.metrics.conversions?.value) || Number.isFinite(row.metrics.results?.value)).sort((a, b) => {
      const aValue = a.metrics.conversions?.value ?? a.metrics.results?.value ?? -1;
      const bValue = b.metrics.conversions?.value ?? b.metrics.results?.value ?? -1;
      return bValue - aValue;
    })[0] || null;
    const roasRow = rows.filter((row) => Number.isFinite(row.metrics.roas?.value)).sort((a, b) => (b.metrics.roas.value - a.metrics.roas.value))[0] || null;
    const watchRow = spendRow && ((spendRow.metrics.conversions?.value ?? spendRow.metrics.results?.value ?? 0) === 0 || !conversionRow) ? spendRow : (spendRow || conversionRow || rows[0] || null);
    const watchConversions = watchRow?.metrics.conversions?.value ?? watchRow?.metrics.results?.value ?? null;
    const watchSpend = watchRow?.metrics.spend?.value ?? null;

    const spendValue = spendRow?.metrics.spend?.value;
    const spendCurrency = spendRow?.metrics.spend?.currency || conversionRow?.metrics.spend?.currency || '';
    const conversionValue = conversionRow?.metrics.conversions?.value ?? conversionRow?.metrics.results?.value;
    const conversionLabel = conversionRow?.metrics.conversions ? 'conversions' : (conversionRow?.metrics.results ? 'results' : 'results');
    const roasValue = roasRow?.metrics.roas?.value;

    const keySignals = [];
    if (spendRow) keySignals.push({ label: 'Highest spend', title: spendRow.label, details: `${formatMoney(spendValue, spendCurrency)} spent` });
    if (conversionRow) keySignals.push({ label: 'Best results', title: conversionRow.label, details: Number.isFinite(conversionValue) ? 'This one appears to be getting results more efficiently.' : 'This one appears to be getting the clearest results.' });
    if (roasRow) keySignals.push({ label: 'Confidence', title: 'Visible rows only', details: 'Treat this as a spot check, not a full account decision.' });
    if (watchRow) {
      keySignals.push({
        label: 'Main watch item',
        title: watchRow.label,
        details: Number.isFinite(watchConversions) ? `${formatMoney(watchSpend, watchRow.metrics.spend?.currency || '')} spent · ${formatPlain(watchConversions)} results` : `${formatMoney(watchSpend, watchRow.metrics.spend?.currency || '')} spent · limited results`,
      });
    }
    keySignals.push({ label: 'Review confidence', title: 'Visible rows only', details: 'Session-only spot check.' });

    const topFinding = spendRow && conversionRow && spendRow.label !== conversionRow.label
      ? `From the visible rows, ${spendRow.label} appears to carry the highest spend, while ${conversionRow.label} appears to be getting the clearest results. Treat this as a visible-page spot check, not a full review.`
      : spendRow
        ? `From the visible rows, ${spendRow.label} appears to carry the highest spend. Check it first before changing budget.`
        : `Gnomeo found visible table rows on this page, but the metric columns are still too limited for a confident read.`;

    const attention = spendRow
      ? [
          `Check ${spendRow.label} first. It is where mistakes cost the most.`,
          conversionRow && conversionRow.label !== spendRow.label ? `Protect ${conversionRow.label}. Do not cut it just because another row is louder.` : 'Protect the row getting the clearest results.',
          'Treat this as a visible-page spot check, not a full account review.',
        ]
      : [
          'Try opening a campaign table, changing the date range, or using paste/upload.',
          'Try again after the page finishes loading.',
          'Use this as a visible-page spot check, not a full account review.',
        ];

    const previewRows = rows.slice(0, 5).map((row) => {
      const cellPreview = row.cells.slice(0, 4).filter(Boolean);
      const metricPreview = [];
      ['spend', 'conversions', 'results', 'roas', 'cpa'].forEach((kind) => {
        const metric = row.metrics[kind];
        if (metric && metric.raw) metricPreview.push(metric.raw);
      });
      return {
        label: row.label,
        metrics: metricPreview.length ? metricPreview : cellPreview.slice(1),
        cells: cellPreview,
      };
    });

    return {
      success: true,
      platform,
      tableKind: candidate.kind,
      rowsDetected: rows.length,
      columnsDetected: candidate.headers.length,
      metricColumns: candidate.metricColumns.map((column) => column.label),
      reviewConfidence: 'Limited — visible rows only',
      previewRows,
      summary: {
        executiveFinding: topFinding,
        keySignals,
        attention,
        comparison: ['This is the first visible-page review in this panel session.'],
        privacyNote: 'This prototype only reads the visible page after you click Add table. Nothing is sent or stored yet.',
      },
      snapshot: {
        spendLabel: spendRow?.label || '',
        spendValue: Number.isFinite(spendValue) ? spendValue : null,
        conversionLabel: conversionRow?.label || '',
        conversionValue: Number.isFinite(conversionValue) ? conversionValue : null,
        roasLabel: roasRow?.label || '',
        roasValue: Number.isFinite(roasValue) ? roasValue : null,
        watchLabel: watchRow?.label || '',
        watchSpendValue: Number.isFinite(watchSpend) ? watchSpend : null,
        watchConversionValue: Number.isFinite(watchConversions) ? watchConversions : null,
        watchRoasValue: Number.isFinite(watchRow?.metrics?.roas?.value) ? watchRow.metrics.roas.value : null,
        watchEfficiencyValue: Number.isFinite(watchSpend) && watchSpend > 0 && Number.isFinite(watchConversions) ? watchConversions / watchSpend : null,
        rowsDetected: rows.length,
      },
    };
  };

  const extractVisibleTableReview = () => {
    const platform = detectPlatform();
    const candidates = collectCandidates();
    if (!candidates.length) {
      return {
        success: false,
        platform,
        tableKind: 'none',
        rowsDetected: 0,
        columnsDetected: 0,
        metricColumns: [],
        reviewConfidence: 'Limited — visible rows only',
        previewRows: [],
        summary: {
          executiveFinding: 'Couldn’t find a visible campaign table on this page.',
          keySignals: [],
          attention: [
            'Try opening a campaign table.',
            'Change the date range if the table is collapsed or empty.',
            'Use paste or upload if the page layout is still hiding the rows.',
          ],
          comparison: ['No visible table was captured yet in this panel session.'],
          privacyNote: 'This prototype only reads the visible page after you click Add table. Nothing is sent or stored yet.',
        },
      };
    }

    return buildReview(candidates[0], platform);
  };

  const buildDebugState = () => {
    const response = extractVisibleTableReview();
    return {
      host: location.host,
      path: `${location.pathname}${location.search || ''}`,
      url: location.href,
      platform: response.platform || detectPlatform(),
      contentScriptLoaded: true,
      storageAvailable: Boolean(chrome?.storage?.session),
      lastExtractionStatus: response.success
        ? `Ready to review ${response.platform || 'this page'}`
        : (response.summary?.executiveFinding || 'Couldn’t find a visible campaign table on this page.'),
      lastError: response.error || '',
      rowsDetected: Number.isFinite(response.rowsDetected) ? response.rowsDetected : 0,
      columnsDetected: Number.isFinite(response.columnsDetected) ? response.columnsDetected : 0,
      metricColumns: Array.isArray(response.metricColumns) ? response.metricColumns : [],
      bundleCount: 0,
      bundleKeys: [],
    };
  };

  const safeExtractReview = () => {
    try {
      return { ok: true, payload: extractVisibleTableReview() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown extraction error');
      return {
        ok: false,
        error: {
          stage: 'extractor',
          message,
          userMessage: `Extractor crashed: ${message}`,
        },
      };
    }
  };

  const safeDebugState = () => {
    try {
      return { ok: true, state: buildDebugState() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown debug error');
      return {
        ok: false,
        error: {
          stage: 'debug-state',
          message,
          userMessage: `Debug state failed: ${message}`,
        },
      };
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'gnomeo-review-visible-table-request') {
      debug('review requested');
      const response = safeExtractReview();
      if (response.ok) {
        const payload = response.payload;
        lastExtractionStatus = payload.success
          ? `Captured ${payload.platform || 'visible table'}`
          : (payload.summary?.executiveFinding || 'Couldn’t find a visible campaign table on this page.');
        lastError = payload.error || '';
        lastRowsDetected = Number.isFinite(payload.rowsDetected) ? payload.rowsDetected : 0;
        lastColumnsDetected = Number.isFinite(payload.columnsDetected) ? payload.columnsDetected : 0;
        lastMetricColumns = Array.isArray(payload.metricColumns) ? payload.metricColumns : [];
        sendResponse({ ok: true, payload });
      } else {
        lastExtractionStatus = response.error?.userMessage || 'Extractor crashed.';
        lastError = response.error?.message || response.error?.userMessage || 'Unknown extraction error';
        sendResponse({ ok: false, error: response.error });
      }
      debug('review response', { lastExtractionStatus, lastError, rowsDetected: lastRowsDetected, columnsDetected: lastColumnsDetected, metricColumns: lastMetricColumns });
      return true;
    }
    if (message.type === 'gnomeo-debug-request') {
      const response = safeDebugState();
      if (response.ok) {
        const state = response.state;
        lastExtractionStatus = state.lastExtractionStatus;
        lastError = state.lastError;
        lastRowsDetected = state.rowsDetected;
        lastColumnsDetected = state.columnsDetected;
        lastMetricColumns = state.metricColumns;
        sendResponse({ ok: true, state });
      } else {
        lastError = response.error?.message || response.error?.userMessage || 'Unknown debug error';
        sendResponse({ ok: false, error: response.error });
      }
      return true;
    }
    return undefined;
  });

  debug('injected', location.href);
})();
