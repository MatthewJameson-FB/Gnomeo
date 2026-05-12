(() => {
  const STORAGE_KEY = 'gnomeo-extension-review-history-v1';

  const $ = (id) => document.getElementById(id);

  const SAMPLE_REVIEW = {
    title: 'Sample review',
    createdAt: new Date().toISOString(),
    sourceLabel: 'Mocked data',
    metrics: {
      rows: 42,
      spend: 18250,
      conversions: 264,
      revenue: 69120,
      cpa: 69.13,
      roas: 3.79,
    },
    executiveFinding: 'Most detected spend appears concentrated in Search | Core. The strongest conversion signal appears to be Brand Search | Exact. The safest next move is to review whether the highest-spend area is producing enough conversions before increasing budget.',
    keySignals: [
      { label: 'Highest spend', title: 'Search | Core', details: '€18,250 spend' },
      { label: 'Strongest conversion signal', title: 'Brand Search | Exact', details: '264 conversions' },
      { label: 'Best ROAS signal', title: 'Brand Search | Exact', details: 'ROAS 3.79x' },
      { label: 'Highest CPA concern', title: 'Search | Core', details: 'CPA €69.13' },
    ],
    attention: [
      'Review the highest-spend campaign first.',
      'Protect the efficient campaign if it still looks healthy.',
      'Keep the next change cautious until the next export confirms the pattern.',
    ],
    comparison: [
      'This is a sample review, so there is no prior export yet.',
    ],
    privacyNote: 'This local prototype processes CSV exports in your browser. It stores only compact review summaries on this device and never raw rows.',
  };

  const formatCurrency = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(num);
  };

  const formatNumber = (value, digits = 0) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(num);
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const parseCsv = (text) => {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    const pushCell = () => {
      row.push(cell);
      cell = '';
    };

    const pushRow = () => {
      if (row.length || cell) {
        pushCell();
        rows.push(row);
      }
      row = [];
    };

    const input = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i];
      if (quoted) {
        if (char === '"' && input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          cell += char;
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === ',') {
        pushCell();
        continue;
      }
      if (char === '\n') {
        pushRow();
        continue;
      }
      cell += char;
    }
    if (cell.length || row.length) pushRow();
    return rows.filter((r) => r.some((c) => String(c || '').trim()));
  };

  const cleanLabel = (value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || '';
  };

  const parseNumber = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    const cleaned = text.replace(/[%£€$\s,]/g, '').replace(/\((.*)\)/, '-$1');
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  };

  const detectColumn = (headers, aliases) => {
    const normalised = headers.map((header) => String(header || '').toLowerCase().trim());
    for (const alias of aliases) {
      const index = normalised.findIndex((header) => header === alias || header.includes(alias));
      if (index >= 0) return index;
    }
    return -1;
  };

  const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);

  const summaryItem = (label, title, details) => ({ label, title, details });

  const toMoney = (value) => formatCurrency(value);
  const toNum = (value, digits = 0) => formatNumber(value, digits);

  const loadHistory = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
    } catch {
      return [];
    }
  };

  const saveHistory = (history) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, 8)));
  };

  const compareToPrevious = (current, previous) => {
    if (!previous) return ['This is the first review in this browser.'];
    const changes = [];
    const spend = current.metrics.spend - previous.metrics.spend;
    const conversions = current.metrics.conversions - previous.metrics.conversions;
    const revenue = current.metrics.revenue - previous.metrics.revenue;
    if (Number.isFinite(spend)) changes.push(`Spend ${spend >= 0 ? 'rose' : 'fell'} ${toMoney(Math.abs(spend))}.`);
    if (Number.isFinite(conversions)) changes.push(`Conversions ${conversions >= 0 ? 'rose' : 'fell'} ${toNum(Math.abs(conversions))}.`);
    if (Number.isFinite(revenue) && previous.metrics.revenue !== null) changes.push(`Value ${revenue >= 0 ? 'rose' : 'fell'} ${toMoney(Math.abs(revenue))}.`);
    if (current.metrics.roas !== null && previous.metrics.roas !== null) {
      const delta = current.metrics.roas - previous.metrics.roas;
      changes.push(`ROAS ${delta >= 0 ? 'improved' : 'softened'} by ${Math.abs(delta).toFixed(2)}x.`);
    }
    if (!changes.length) changes.push('The export changed, but only limited comparison fields were available.');
    return changes.slice(0, 3);
  };

  const buildSignals = (segments, totals) => {
    const signals = [];
    const highestSpend = segments[0];
    const strongestConversion = [...segments].filter((item) => item.conversions > 0).sort((a, b) => b.conversions - a.conversions || b.spend - a.spend)[0];
    const lowestCpa = [...segments].filter((item) => item.cpa !== null).sort((a, b) => a.cpa - b.cpa)[0];
    const bestRoas = [...segments].filter((item) => item.roas !== null).sort((a, b) => b.roas - a.roas)[0];
    const watchItem = [...segments].filter((item) => item.spend > 0).sort((a, b) => {
      const aScore = (a.conversions || 0) > 0 ? a.cpa || Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
      const bScore = (b.conversions || 0) > 0 ? b.cpa || Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
      return b.spend - a.spend || bScore - aScore;
    })[0];

    if (highestSpend) signals.push(summaryItem('Highest spend', highestSpend.label, `${toMoney(highestSpend.spend)} spend`));
    if (strongestConversion) signals.push(summaryItem('Strongest conversion signal', strongestConversion.label, `${toNum(strongestConversion.conversions)} conversions`));
    if (lowestCpa) signals.push(summaryItem('Lowest CPA signal', lowestCpa.label, `CPA ${toMoney(lowestCpa.cpa)}`));
    if (bestRoas) signals.push(summaryItem('Best ROAS signal', bestRoas.label, `ROAS ${bestRoas.roas.toFixed(2)}x`));

    if (!signals.length && totals.rows) {
      signals.push(summaryItem('Overall activity', 'Export processed', `${toNum(totals.rows)} rows reviewed`));
    }

    if (watchItem && !signals.some((item) => item.title === watchItem.label)) {
      signals.push(summaryItem('Main watch item', watchItem.label, watchItem.conversions > 0 ? `Spend ${toMoney(watchItem.spend)} · CPA ${toMoney(watchItem.cpa)}` : `${toMoney(watchItem.spend)} spend · no recorded conversions`));
    }

    if (signals.length < 3 && totals.rows) {
      signals.push(summaryItem('Overall activity', 'Export processed', `${toNum(totals.rows)} rows reviewed`));
    }
    if (signals.length < 3 && totals.conversions !== null) {
      signals.push(summaryItem('Conversion density', 'Signal available', `${toNum(totals.conversions)} conversions · ${toNum(totals.clicks)} clicks`));
    }
    if (signals.length < 3) {
      signals.push(summaryItem('Review focus', highestSpend ? highestSpend.label : 'No clear segment', highestSpend ? `${toMoney(highestSpend.spend)} spend` : 'Wait for a cleaner export'));
    }

    return signals.slice(0, 5);
  };

  const buildFinding = (segments, totals, previous) => {
    const highestSpend = segments[0];
    const strongestConversion = [...segments].filter((item) => item.conversions > 0).sort((a, b) => b.conversions - a.conversions || b.spend - a.spend)[0];
    const baseline = !previous;
    if (baseline) {
      if (highestSpend && strongestConversion && highestSpend.label !== strongestConversion.label) {
        return `${highestSpend.label} appears to carry the most spend, while ${strongestConversion.label} shows the clearest conversion signal. Treat this as a baseline and compare the next export before making large changes.`;
      }
      if (highestSpend) {
        return `Most detected spend appears concentrated in ${highestSpend.label}. The safest next move is to review whether that area is producing enough conversions before increasing budget.`;
      }
      return 'The export is small, so confidence is limited, but the review still shows enough signal to treat the next export as the baseline.';
    }
    const spendDelta = totals.spend - previous.metrics.spend;
    const conversionDelta = totals.conversions - previous.metrics.conversions;
    const roasNow = totals.roas;
    const cpaNow = totals.cpa;
    const pieces = [];
    if (Number.isFinite(spendDelta)) pieces.push(`Spend ${spendDelta >= 0 ? 'increased' : 'decreased'} ${Math.abs(spendDelta).toFixed(0) >= 1000 ? toMoney(Math.abs(spendDelta)) : toMoney(Math.abs(spendDelta))}.`);
    if (Number.isFinite(conversionDelta)) pieces.push(`Conversions ${conversionDelta >= 0 ? 'increased' : 'decreased'} ${toNum(Math.abs(conversionDelta))}.`);
    if (roasNow !== null && previous.metrics.roas !== null) pieces.push(`ROAS ${roasNow >= previous.metrics.roas ? 'improved' : 'softened'} from ${previous.metrics.roas.toFixed(2)}x to ${roasNow.toFixed(2)}x.`);
    if (cpaNow !== null && previous.metrics.cpa !== null) pieces.push(`CPA ${cpaNow <= previous.metrics.cpa ? 'improved' : 'worsened'} from ${toMoney(previous.metrics.cpa)} to ${toMoney(cpaNow)}.`);
    if (highestSpend) pieces.push(`Review ${highestSpend.label} first, and protect efficient campaigns from unnecessary cuts.`);
    return pieces.filter(Boolean).slice(0, 3).join(' ');
  };

  const buildReview = (csvText) => {
    const rows = parseCsv(csvText);
    if (rows.length < 2) throw new Error('Paste a CSV export with a header row and at least one data row.');
    const headers = rows[0].map((header) => cleanLabel(header));
    const dataRows = rows.slice(1);
    const spendIdx = detectColumn(headers, ['spend', 'cost', 'media cost', 'amount spent', 'amount']);
    const clicksIdx = detectColumn(headers, ['clicks']);
    const conversionsIdx = detectColumn(headers, ['conversions', 'results', 'all conversions', 'conversion']);
    const revenueIdx = detectColumn(headers, ['revenue', 'value', 'conv. value', 'conversion value']);
    const campaignIdx = detectColumn(headers, ['campaign name', 'campaign']);
    const adGroupIdx = detectColumn(headers, ['ad group', 'ad set']);
    const adNameIdx = detectColumn(headers, ['ad name']);
    const keywordIdx = detectColumn(headers, ['keyword', 'search term']);
    const platformIdx = detectColumn(headers, ['platform', 'network', 'channel']);

    const bySegment = new Map();
    const totals = { rows: 0, spend: 0, clicks: 0, conversions: 0, revenue: 0, revenueSeen: false };

    for (const row of dataRows) {
      const spend = parseNumber(row[spendIdx]);
      const clicks = parseNumber(row[clicksIdx]);
      const conversions = parseNumber(row[conversionsIdx]);
      const revenue = parseNumber(row[revenueIdx]);
      const hasSignal = [spend, clicks, conversions, revenue].some((value) => Number.isFinite(value) && value !== 0);
      if (!hasSignal) continue;
      const label = cleanLabel(row[campaignIdx] || row[adGroupIdx] || row[adNameIdx] || row[keywordIdx] || row[platformIdx] || 'Unknown segment');
      const current = bySegment.get(label) || { label, spend: 0, clicks: 0, conversions: 0, revenue: 0, revenueSeen: false };
      current.spend += spend || 0;
      current.clicks += clicks || 0;
      current.conversions += conversions || 0;
      if (Number.isFinite(revenue)) {
        current.revenue += revenue;
        current.revenueSeen = true;
      }
      bySegment.set(label, current);
      totals.rows += 1;
      totals.spend += spend || 0;
      totals.clicks += clicks || 0;
      totals.conversions += conversions || 0;
      if (Number.isFinite(revenue)) {
        totals.revenue += revenue;
        totals.revenueSeen = true;
      }
    }

    const segments = [...bySegment.values()].map((segment) => ({
      ...segment,
      cpa: segment.conversions > 0 ? ratio(segment.spend, segment.conversions) : null,
      roas: segment.revenueSeen ? ratio(segment.revenue, segment.spend) : null,
    })).sort((a, b) => b.spend - a.spend);

    const current = {
      title: 'Uploaded review',
      createdAt: new Date().toISOString(),
      sourceLabel: 'Local CSV upload',
      metrics: {
        rows: totals.rows,
        spend: totals.spend,
        conversions: totals.conversions,
        revenue: totals.revenueSeen ? totals.revenue : null,
        cpa: totals.conversions > 0 ? ratio(totals.spend, totals.conversions) : null,
        roas: totals.revenueSeen ? ratio(totals.revenue, totals.spend) : null,
      },
      executiveFinding: '',
      keySignals: [],
      attention: [],
      comparison: [],
      privacyNote: SAMPLE_REVIEW.privacyNote,
    };

    const previous = loadHistory()[0] || null;
    current.keySignals = buildSignals(segments, totals);
    current.executiveFinding = buildFinding(segments, current.metrics, previous);
    current.attention = buildSignals(segments, totals).slice(0, 3).map((item) => `${item.label}: ${item.title} — ${item.details}`);
    current.comparison = compareToPrevious(current, previous);

    return { current, previous };
  };

  const renderList = (items, selector) => {
    const root = $(selector);
    if (!root) return;
    if (!items || !items.length) {
      root.innerHTML = '<div class="bullet-item"><strong>Nothing to show yet</strong><span>Upload an export to generate a review.</span></div>';
      return;
    }
    root.innerHTML = items.map((item) => `
      <div class="${selector === 'keySignals' ? 'signal-item' : 'bullet-item'}">
        <strong>${escapeHtml(item.label || item)}</strong>
        <span>${escapeHtml(item.details || item.title || '')}</span>
      </div>
    `).join('');
  };

  const renderReview = (review) => {
    $('sourceChip').textContent = review.sourceLabel || 'Local review';
    $('topFinding').textContent = review.executiveFinding;
    renderList(review.keySignals, 'keySignals');
    renderList(review.attention.map((item) => ({ label: item, details: '' })), 'attentionList');
    renderList(review.comparison.map((item) => ({ label: item, details: '' })), 'comparisonList');
    $('privacyNote').textContent = review.privacyNote;
  };

  const setReview = (review, keepHistory = true) => {
    const history = keepHistory ? [review, ...loadHistory().filter((item) => item.createdAt !== review.createdAt)].slice(0, 8) : loadHistory();
    saveHistory(history);
    renderReview(review);
  };

  const handleReview = async (csvText) => {
    try {
      const { current } = buildReview(csvText);
      setReview(current);
    } catch (error) {
      $('topFinding').textContent = error.message || 'Could not read that export.';
      $('keySignals').innerHTML = '';
      $('attentionList').innerHTML = '';
      $('comparisonList').innerHTML = '';
    }
  };

  const boot = () => {
    const close = $('closePanel');
    const csvInput = $('csvInput');
    const csvFile = $('csvFile');
    const reviewNow = $('reviewNow');
    const clearHistory = $('clearHistory');

    const history = loadHistory();
    renderReview(history[0] || SAMPLE_REVIEW);

    close?.addEventListener('click', () => {
      window.parent.postMessage({ type: 'gnomeo-close' }, '*');
    });

    csvFile?.addEventListener('change', async () => {
      const file = csvFile.files && csvFile.files[0];
      if (!file) return;
      csvInput.value = await file.text();
    });

    reviewNow?.addEventListener('click', () => handleReview(csvInput.value));

    csvInput?.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    csvInput?.addEventListener('drop', async (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      csvInput.value = await file.text();
    });

    clearHistory?.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      renderReview(SAMPLE_REVIEW);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
