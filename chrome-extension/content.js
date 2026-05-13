(() => {
  if (window.__gnomeoReviewLayerInjected) return;
  window.__gnomeoReviewLayerInjected = true;

  const isLocalTestHost = ['localhost', '127.0.0.1'].includes(location.hostname.toLowerCase());
  const runtimeApi = globalThis.chrome?.runtime || null;
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
  const openSidePanel = async () => {
    if (!runtimeApi?.sendMessage) return { ok: false, error: { stage: 'runtime-message', message: 'chrome.runtime.sendMessage is unavailable', userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } };
    return await new Promise((resolve) => {
      runtimeApi.sendMessage({ type: 'GNOMEO_OPEN_SIDE_PANEL' }, (response) => {
        const message = runtimeApi?.lastError?.message || '';
        if (message) {
          resolve({ ok: false, error: { stage: 'runtime-message', message, userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } });
          return;
        }
        if (!response?.ok) {
          resolve({ ok: false, error: { stage: 'runtime-message', message: response?.error || 'Open side panel failed', userMessage: 'Open Google Ads, Meta Ads, or LinkedIn.' } });
          return;
        }
        resolve({ ok: true, response });
      });
    });
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
    if (path.includes('google-ads-campaigns')) return 'Google Ads';
    if (path.includes('meta-ads-campaigns')) return 'Meta Ads';
    if (path.includes('linkedin-ads-campaigns')) return 'LinkedIn Campaign Manager';
    if (path.includes('no-table')) return 'No table';
    if (path.includes('/test-pages/') || path.endsWith('/test-pages/')) return 'Local test page';
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
    if (/\bconversions?\b|\bresults?\b|\bleads?\b|all conversions?/.test(value)) return 'conversions';
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

  const firstFiniteNumber = (...values) => values.find((value) => Number.isFinite(value));

  const rowReference = (platform, label) => {
    const cleanLabel = normalizeText(label || 'Row');
    const cleanPlatform = normalizeText(platform || '');
    if (!cleanPlatform) return cleanLabel;
    const shortPlatform = /^google ads$/i.test(cleanPlatform)
      ? 'Google'
      : /^meta ads$/i.test(cleanPlatform)
        ? 'Meta'
        : /^linkedin campaign manager$/i.test(cleanPlatform)
          ? 'LinkedIn'
          : cleanPlatform;
    return `${shortPlatform} ${cleanLabel}`;
  };

  const rowSampleSizeNote = ({ impressions, clicks, spend, results }) => {
    if ((Number.isFinite(impressions) && impressions < 5000) || (Number.isFinite(clicks) && clicks < 100)) {
      return 'Low data — do not overreact.';
    }
    if ((Number.isFinite(spend) && spend < 500) || (Number.isFinite(results) && results < 10)) {
      return 'Limited visible data — keep the call conservative.';
    }
    return 'Enough visible data for a spot check.';
  };

  const rowPlatformHint = (platform, label) => {
    const platformName = normalizeText(platform || '');
    const value = normalizeText(label || '').toLowerCase();
    const googleSearch = /search|brand search|generic search|competitor|keyword/.test(value);
    const googleShopping = /shopping|pmax|performance max|feed|product/.test(value);
    const metaRetargeting = /retarget|remarket|existing customer/.test(value);
    const metaProspecting = /prospecting|broad audience|lookalike|advantage\+/.test(value);
    const linkedInLeadGen = /lead gen|lead generation|lead form|company|job|abm/.test(value);
    const linkedInAwareness = /brand awareness|awareness|traffic/.test(value);

    if (/^google ads$/i.test(platformName)) {
      if (googleShopping) return 'For Google Shopping/PMax, check product/feed quality and value tracking.';
      if (googleSearch) return 'For Google Search, check search terms, keywords, and the landing page.';
      return 'For Google, check the query, landing page, and value tracking.';
    }
    if (/^meta ads$/i.test(platformName)) {
      if (metaRetargeting) return 'For Meta retargeting, check the audience, creative, offer, and landing page.';
      if (metaProspecting) return 'For Meta prospecting, check the audience, creative, offer, and landing page.';
      return 'For Meta, check the audience, creative, offer, and landing page.';
    }
    if (/^linkedin campaign manager$/i.test(platformName)) {
      if (linkedInLeadGen || linkedInAwareness) return 'For LinkedIn, check the audience, offer, lead form, and landing page.';
      return 'For LinkedIn, check the audience, offer, lead form, and landing page.';
    }
    return 'Check the audience, offer, landing page, and tracking.';
  };

  const buildDecisionMatrix = (rows, platform) => {
    const analysedRows = rows.map((row) => {
      const spend = firstFiniteNumber(row.metrics.spend?.value);
      const conversions = firstFiniteNumber(row.metrics.conversions?.value);
      const results = firstFiniteNumber(row.metrics.results?.value);
      const leads = firstFiniteNumber(row.metrics.leads?.value);
      const revenue = firstFiniteNumber(row.metrics.revenue?.value);
      const roas = firstFiniteNumber(row.metrics.roas?.value);
      const cpa = firstFiniteNumber(row.metrics.cpa?.value);
      const cpc = firstFiniteNumber(row.metrics.cpc?.value);
      const clicks = firstFiniteNumber(row.metrics.clicks?.value);
      const impressions = firstFiniteNumber(row.metrics.impressions?.value);
      const ctr = firstFiniteNumber(row.metrics.ctr?.value);
      const resultValue = firstFiniteNumber(conversions, results, leads);
      const resultLabel = row.metrics.conversions ? 'conversions'
        : row.metrics.results ? 'results'
          : row.metrics.leads ? 'leads'
            : 'results';
      const resultPerSpend = Number.isFinite(spend) && spend > 0 && Number.isFinite(resultValue) ? resultValue / spend : null;
      const revenuePerSpend = Number.isFinite(spend) && spend > 0 && Number.isFinite(revenue) ? revenue / spend : null;
      const efficiencyScore = Number.isFinite(roas)
        ? roas
        : Number.isFinite(revenuePerSpend)
          ? revenuePerSpend
          : Number.isFinite(resultPerSpend)
            ? resultPerSpend
            : Number.isFinite(cpa) && cpa > 0
              ? 1 / cpa
              : null;
      const visibleDataNote = rowSampleSizeNote({ impressions, clicks, spend, results: resultValue });

      return {
        label: row.label,
        platform,
        spend,
        resultValue,
        resultLabel,
        revenue,
        roas,
        cpa,
        cpc,
        clicks,
        impressions,
        ctr,
        efficiencyScore,
        resultPerSpend,
        revenuePerSpend,
        visibleDataNote,
        rowReference: rowReference(platform, row.label),
        row,
      };
    }).filter((row) => row.label);

    const highestSpend = analysedRows
      .filter((row) => Number.isFinite(row.spend))
      .sort((a, b) => (b.spend - a.spend) || ((b.resultValue || 0) - (a.resultValue || 0)))[0] || null;

    const strongestResult = analysedRows
      .filter((row) => Number.isFinite(row.resultValue) || Number.isFinite(row.revenue))
      .sort((a, b) => {
        const aValue = Number.isFinite(a.resultValue) ? a.resultValue : (Number.isFinite(a.revenue) ? a.revenue : -1);
        const bValue = Number.isFinite(b.resultValue) ? b.resultValue : (Number.isFinite(b.revenue) ? b.revenue : -1);
        return (bValue - aValue) || ((a.spend || 0) - (b.spend || 0));
      })[0] || null;

    const efficientCandidates = analysedRows
      .filter((row) => Number.isFinite(row.efficiencyScore) && row.efficiencyScore > 0)
      .sort((a, b) => (b.efficiencyScore - a.efficiencyScore) || ((a.spend || 0) - (b.spend || 0)));
    const efficientPerformer = efficientCandidates[0] || strongestResult || highestSpend || analysedRows[0] || null;

    const watchCandidates = analysedRows
      .filter((row) => Number.isFinite(row.spend) && row.spend > 0)
      .map((row) => {
        const weakSignal = Number.isFinite(row.resultValue) ? row.resultValue : 0;
        const efficiencyPenalty = Number.isFinite(row.efficiencyScore) ? row.efficiencyScore : 0;
        const lowDataPenalty = row.visibleDataNote.startsWith('Low data') ? 2 : 0;
        return {
          ...row,
          watchScore: (row.spend || 0) - (weakSignal * 10) - (efficiencyPenalty * 1000) - (lowDataPenalty * 500),
          lowData: row.visibleDataNote.startsWith('Low data'),
        };
      })
      .sort((a, b) => (b.watchScore - a.watchScore) || (b.spend - a.spend));

    const watchItem = watchCandidates[0] || highestSpend || efficientPerformer || null;
    const lowDataItems = analysedRows.filter((row) => row.visibleDataNote.startsWith('Low data'));

    const reviewLevel = 'One-page spot check';
    const confidence = `${reviewLevel} · visible rows only`;

    return {
      reviewLevel,
      confidence,
      rows: analysedRows,
      highestSpend,
      strongestResult,
      efficientPerformer,
      watchItem,
      lowDataItems,
      platformHint: rowPlatformHint(platform, watchItem?.label || highestSpend?.label || ''),
    };
  };

  const buildReview = (candidate, platform) => {
    const rows = candidate.dataRows || [];
    const matrix = buildDecisionMatrix(rows, platform);
    const highestSpend = matrix.highestSpend;
    const strongestResult = matrix.strongestResult;
    const efficientPerformer = matrix.efficientPerformer;
    const watchItem = matrix.watchItem;
    const lowDataItem = matrix.lowDataItems[0] || null;

    const keySignals = [];
    if (highestSpend) {
      const spendText = Number.isFinite(highestSpend.spend) ? `${formatMoney(highestSpend.spend)} spent` : 'Highest spend';
      keySignals.push({ label: 'Highest spend', title: highestSpend.rowReference, details: spendText });
    }
    if (strongestResult) {
      const resultText = Number.isFinite(strongestResult.resultValue)
        ? `${formatPlain(strongestResult.resultValue)} ${strongestResult.resultLabel}`
        : 'Strongest visible result signal';
      keySignals.push({ label: 'Strongest result signal', title: strongestResult.rowReference, details: resultText });
    }
    if (efficientPerformer) {
      const efficiencyText = Number.isFinite(efficientPerformer.efficiencyScore)
        ? `${formatPlain(efficientPerformer.efficiencyScore, 2)} ${efficientPerformer.roas ? 'ROAS' : 'result per spend'}`
        : 'Best visible efficiency signal';
      keySignals.push({ label: 'Best efficiency signal', title: efficientPerformer.rowReference, details: efficiencyText });
    }
    if (watchItem) {
      const watchText = Number.isFinite(watchItem.spend)
        ? `${formatMoney(watchItem.spend)} · ${Number.isFinite(watchItem.resultValue) ? `${formatPlain(watchItem.resultValue)} ${watchItem.resultLabel}` : 'weak results'}`
        : 'Meaningful spend with weak results';
      keySignals.push({ label: 'Main watch item', title: watchItem.rowReference, details: watchText });
    }
    if (lowDataItem) {
      keySignals.push({ label: 'Low data', title: lowDataItem.rowReference, details: lowDataItem.visibleDataNote });
    }
    keySignals.push({ label: 'Review level', title: matrix.reviewLevel, details: 'Visible rows only' });

    const watchHeadline = watchItem || highestSpend || strongestResult || efficientPerformer;
    const saferPerformer = efficientPerformer && watchHeadline && efficientPerformer.rowReference !== watchHeadline.rowReference
      ? efficientPerformer
      : strongestResult;
    const spendLeader = highestSpend && watchHeadline && highestSpend.rowReference !== watchHeadline.rowReference
      ? highestSpend
      : null;
    const watchReason = watchHeadline
      ? (watchHeadline.visibleDataNote.startsWith('Low data')
        ? `${watchHeadline.rowReference} has spend, but the sample is still thin.`
        : `${watchHeadline.rowReference} is the main watch item.`)
      : 'There is not enough visible data for a confident call.';

    const topFinding = watchHeadline
      ? `On this page, ${watchHeadline.rowReference} is the main watch item.${saferPerformer ? ` ${saferPerformer.rowReference} looks safer to protect.` : ''}${spendLeader ? ` ${spendLeader.rowReference} leads spend.` : ''}`
      : 'On this page, the visible rows are still too limited for a confident read.';

    const attention = [
      watchReason,
      saferPerformer && saferPerformer.rowReference !== watchHeadline?.rowReference
        ? `Keep ${saferPerformer.rowReference} protected.`
        : 'Keep the clearest performer protected for now.',
      matrix.platformHint,
    ];

    if (lowDataItem && lowDataItem.rowReference !== watchHeadline?.rowReference) {
      attention.splice(1, 0, `Treat ${lowDataItem.rowReference} as low confidence.`);
    }

    const nextSteps = [
      watchHeadline ? `Check ${watchHeadline.rowReference} before adding budget.` : 'Check the highest-spend row before adding budget.',
      saferPerformer && saferPerformer.rowReference !== watchHeadline?.rowReference
        ? `Keep ${saferPerformer.rowReference} protected.`
        : 'Keep the clearer performer protected for now.',
      matrix.platformHint,
    ];

    const comparison = lowDataItem
      ? ['This is a visible-page spot check.', `${lowDataItem.rowReference} should be treated as low confidence.`]
      : ['This is a visible-page spot check.'];

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
      reviewConfidence: matrix.confidence,
      previewRows,
      decisionMatrix: matrix,
      reviewLevel: matrix.reviewLevel,
      summary: {
        executiveFinding: topFinding,
        keySignals,
        attention,
        comparison,
        privacyNote: 'This prototype only reads the visible page after you click Add table. Nothing is sent or stored yet.',
      },
      snapshot: {
        spendLabel: highestSpend?.label || '',
        spendValue: Number.isFinite(highestSpend?.spend) ? highestSpend.spend : null,
        conversionLabel: strongestResult?.label || '',
        conversionValue: Number.isFinite(strongestResult?.resultValue) ? strongestResult.resultValue : null,
        roasLabel: efficientPerformer?.label || '',
        roasValue: Number.isFinite(efficientPerformer?.efficiencyScore) ? efficientPerformer.efficiencyScore : null,
        watchLabel: watchItem?.label || '',
        watchSpendValue: Number.isFinite(watchItem?.spend) ? watchItem.spend : null,
        watchConversionValue: Number.isFinite(watchItem?.resultValue) ? watchItem.resultValue : null,
        watchRoasValue: Number.isFinite(watchItem?.roas) ? watchItem.roas : null,
        watchEfficiencyValue: Number.isFinite(watchItem?.efficiencyScore) ? watchItem.efficiencyScore : null,
        rowsDetected: rows.length,
        decisionMatrix: matrix,
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
