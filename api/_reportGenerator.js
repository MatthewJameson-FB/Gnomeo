const CURRENCY_SYMBOLS = /[£$€¥]/g;
const THOUSANDS_SEPARATORS = /,/g;
const EMPTY_VALUES = new Set(['', '-', 'n/a', 'na', 'null', 'none', 'undefined']);

const FIELD_ALIASES = {
  campaign_name: ['campaign name', 'campaign', 'campaign_name'],
  ad_group: ['ad group', 'ad group name', 'adset', 'ad set', 'ad set name', 'ad set name', 'adset name', 'ad_group'],
  ad_name: ['ad name', 'ad'],
  keyword: ['keyword', 'keywords'],
  search_term: ['search term', 'search terms', 'search_term'],
  device: ['device'],
  country: ['country', 'geo', 'region', 'market', 'location'],
  campaign_type: ['campaign type', 'objective', 'campaign_type'],
  platform: ['platform', 'channel', 'network'],
  spend: ['amount spent', 'amount spent (gbp)', 'amount spent (usd)', 'amount spent gbp', 'amount spent usd', 'cost micros', 'cost micros gbp', 'cost micros usd', 'cost', 'cost gbp', 'cost usd', 'spend', 'ad spend', 'monthly spend gbp'],
  clicks: ['clicks', 'link clicks', 'outbound clicks', 'landing page views'],
  impressions: ['impressions', 'impr.', 'impr'],
  conversions: ['conversions', 'results', 'purchases', 'website purchases', 'purchase', 'actions', 'all conversions', 'converted clicks'],
  revenue: ['conv. value', 'conversion value', 'purchase conversion value', 'purchases conversion value', 'website purchases conversion value', 'total conversion value', 'revenue'],
  result_rate: ['result rate', 'result rate (%)', 'conversion rate', 'conv. rate'],
};

const GOOGLE_HINTS = ['campaign', 'ad group', 'impr', 'clicks', 'cost', 'search impr', 'conv. value', 'conversions', 'converted clicks'];
const META_HINTS = ['campaign name', 'ad set name', 'ad name', 'amount spent', 'results', 'purchase conversion value', 'website purchases', 'link clicks', 'cpm'];

const slugify = (value) => String(value || '')
  .trim()
  .replace(/[^a-zA-Z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .toLowerCase();

const normalizeHeader = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/&/g, ' and ')
  .replace(/[._\/\\-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeCell = (value) => String(value ?? '').replace(/\u00a0/g, ' ').trim();

const parseCsvText = (text) => {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        continue;
      }
      cell += char;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows
    .map((fields) => fields.map((value) => normalizeCell(value)))
    .filter((fields) => fields.some((value) => value !== ''));
};

const toNumber = (value, { micros = false } = {}) => {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  if (!text || EMPTY_VALUES.has(slugify(text))) return null;
  const isParenthesizedNegative = /^\(.*\)$/.test(text);
  text = text.replace(/^\(|\)$/g, '');
  text = text.replace(CURRENCY_SYMBOLS, '');
  text = text.replace(/[%]/g, '');
  text = text.replace(THOUSANDS_SEPARATORS, '');
  text = text.replace(/\s+/g, '');
  let multiplier = 1;
  if (/k$/i.test(text)) {
    multiplier = 1_000;
    text = text.slice(0, -1);
  } else if (/m$/i.test(text)) {
    multiplier = 1_000_000;
    text = text.slice(0, -1);
  } else if (/b$/i.test(text)) {
    multiplier = 1_000_000_000;
    text = text.slice(0, -1);
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  let result = numeric * multiplier;
  if (micros) result /= 1_000_000;
  if (isParenthesizedNegative) result *= -1;
  return result;
};

const asInteger = (value, opts) => {
  const number = toNumber(value, opts);
  if (number === null) return null;
  return Math.round(number);
};

const formatNumber = (value, fractionDigits = 0) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Number(value));
};

const formatCurrency = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 2,
  }).format(Number(value));
};

const formatPercent = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(Number(value) < 10 ? 1 : 0)}%`;
};

const safeRatio = (numerator, denominator) => {
  if (!Number.isFinite(Number(numerator)) || !Number.isFinite(Number(denominator)) || Number(denominator) === 0) return null;
  return Number(numerator) / Number(denominator);
};

const findColumn = (headers, aliases) => {
  const map = new Map();
  for (const header of headers) {
    const key = normalizeHeader(header).replace(/\s+/g, ' ');
    if (key) map.set(key, header);
  }
  for (const alias of aliases) {
    const key = normalizeHeader(alias).replace(/\s+/g, ' ');
    if (map.has(key)) return map.get(key);
  }
  return null;
};

const detectPlatformFromHints = ({ filename, headers, text }) => {
  const combined = [filename, ...headers, String(text || '').slice(0, 4096)].join(' ').toLowerCase();
  const googleScore = GOOGLE_HINTS.reduce((score, hint) => score + (combined.includes(hint) ? 1 : 0), 0);
  const metaScore = META_HINTS.reduce((score, hint) => score + (combined.includes(hint) ? 1 : 0), 0);
  if (googleScore > metaScore && googleScore >= 2) return 'google_ads';
  if (metaScore > googleScore && metaScore >= 2) return 'meta_ads';
  if (googleScore === metaScore && googleScore >= 3) {
    if (combined.includes('amount spent') || combined.includes('results')) return 'meta_ads';
    if (combined.includes('cost micros') || combined.includes('search impr')) return 'google_ads';
  }
  if (combined.includes('meta') || combined.includes('facebook') || combined.includes('instagram')) return 'meta_ads';
  if (combined.includes('google ads') || combined.includes('search terms') || combined.includes('search impression share')) return 'google_ads';
  return 'unknown';
};

const buildFieldMap = (headers) => {
  const fieldMap = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    fieldMap[canonical] = findColumn(headers, aliases);
  }
  return fieldMap;
};

const rowValue = (row, fieldMap, field) => {
  const column = fieldMap[field];
  if (!column) return '';
  return row[column] ?? '';
};

const extractRecord = (row, fieldMap, defaultPlatform = 'unknown') => {
  const spendSource = rowValue(row, fieldMap, 'spend');
  const spendMicros = String(fieldMap.spend || '').toLowerCase().includes('micros');
  const spend = toNumber(spendSource, { micros: spendMicros });
  const clicks = asInteger(rowValue(row, fieldMap, 'clicks'));
  const impressions = asInteger(rowValue(row, fieldMap, 'impressions'));
  const conversions = asInteger(rowValue(row, fieldMap, 'conversions'));
  const revenue = toNumber(rowValue(row, fieldMap, 'revenue'));
  const resultRate = toNumber(rowValue(row, fieldMap, 'result_rate'));

  const dimensions = {
    campaign_name: normalizeCell(rowValue(row, fieldMap, 'campaign_name')),
    ad_group: normalizeCell(rowValue(row, fieldMap, 'ad_group')),
    ad_name: normalizeCell(rowValue(row, fieldMap, 'ad_name')),
    keyword: normalizeCell(rowValue(row, fieldMap, 'keyword')),
    search_term: normalizeCell(rowValue(row, fieldMap, 'search_term')),
    device: normalizeCell(rowValue(row, fieldMap, 'device')),
    country: normalizeCell(rowValue(row, fieldMap, 'country')),
    campaign_type: normalizeCell(rowValue(row, fieldMap, 'campaign_type')),
    platform: normalizeCell(rowValue(row, fieldMap, 'platform')) || defaultPlatform,
  };

  return {
    ...dimensions,
    spend,
    clicks,
    impressions,
    conversions,
    revenue,
    result_rate: resultRate,
    ctr: safeRatio(clicks, impressions),
    cpc: safeRatio(spend, clicks),
    cpa: safeRatio(spend, conversions),
    roas: safeRatio(revenue, spend),
  };
};

const chooseSegmentKey = (record) => {
  const keys = [
    'campaign_name',
    'ad_group',
    'ad_name',
    'keyword',
    'search_term',
    'device',
    'country',
    'campaign_type',
  ];
  const parts = keys.map((key) => cleanDisplayLabel(record[key])).filter(Boolean);
  const uniqueParts = [...new Set(parts)];
  return uniqueParts.length ? uniqueParts.join(' · ') : 'All rows';
};

const summarizePlatform = (platform, records) => {
  const totals = records.reduce((acc, record) => {
    acc.spend += Number(record.spend || 0);
    acc.clicks += Number(record.clicks || 0);
    acc.impressions += Number(record.impressions || 0);
    acc.conversions += Number(record.conversions || 0);
    acc.revenue += Number(record.revenue || 0);
    acc.revenueSeen = acc.revenueSeen || Number.isFinite(Number(record.revenue));
    return acc;
  }, { spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0, revenueSeen: false });

  return {
    platform,
    rows: records.length,
    spend: totals.spend,
    clicks: totals.clicks,
    impressions: totals.impressions,
    conversions: totals.conversions,
    revenue: totals.revenueSeen ? totals.revenue : null,
    ctr: safeRatio(totals.clicks, totals.impressions),
    cpc: safeRatio(totals.spend, totals.clicks),
    cpa: safeRatio(totals.spend, totals.conversions),
    roas: totals.revenueSeen ? safeRatio(totals.revenue, totals.spend) : null,
  };
};

const segmentDisplayName = (segment) => {
  const candidates = [
    segment.campaign_name,
    segment.ad_group,
    segment.ad_name,
    segment.keyword,
    segment.search_term,
    segment.segment_label,
  ];
  const selected = candidates.map(cleanDisplayLabel).find((value) => String(value || '').trim()) || 'All rows';
  return String(selected).split('·')[0].trim();
};

const platformDisplayName = (platform) => ({
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  mixed: 'Mixed',
  unknown: 'Unknown',
}[String(platform || '').toLowerCase()] || String(platform || '').replace(/_/g, ' ').trim() || 'Unknown');

const cleanDisplayLabel = (value) => {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const prefixMatch = text.match(/^(campaign_name|campaign|platform|source|result_indicator|amount_spent|ad_group|ad_name|keyword|search_term|campaign_type)\s*:\s*(.*)$/i);
  if (prefixMatch) text = String(prefixMatch[2] || '').trim();
  if (!text) return '';
  const normalized = text.toLowerCase();
  if (normalized === 'google_ads') return 'Google Ads';
  if (normalized === 'meta_ads') return 'Meta Ads';
  if (normalized === 'mixed') return 'Mixed';
  if (normalized === 'unknown') return 'Unknown';
  if (/^[a-z0-9_]+$/.test(text) && text.includes('_')) {
    return text.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  }
  return text;
};

const detectIssueSeverity = (segment, totals) => {
  if (!segment.spend || segment.spend < totals.spend * 0.05) return null;
  if ((segment.conversions || 0) > 0) return null;
  if ((segment.clicks || 0) === 0 && (segment.impressions || 0) > 0) return 'weak signal';
  if ((segment.clicks || 0) > 0) return 'wasted spend';
  return 'wasted spend';
};

const buildPriorityItems = ({ overall, topSegments, platformSummaries }) => {
  const items = [];
  const hasRevenue = overall.revenue !== null;
  const totalSpend = overall.spend || 0;
  const totalConversions = overall.conversions || 0;
  const topSegment = topSegments[0] || null;
  const topPlatform = [...platformSummaries].sort((a, b) => b.spend - a.spend)[0] || null;

  const worstSegments = topSegments.filter((segment) => segment.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 3);

  for (const segment of worstSegments) {
    const severity = detectIssueSeverity(segment, overall);
    if (!severity) continue;
    const label = segmentDisplayName(segment);
    const details = [];
    details.push(`Spend: ${formatCurrency(segment.spend)}`);
    if (segment.clicks !== null && segment.clicks !== undefined) details.push(`Clicks: ${formatNumber(segment.clicks)}`);
    if (segment.conversions !== null && segment.conversions !== undefined) details.push(`Conversions: ${formatNumber(segment.conversions)}`);
    if (segment.ctr !== null) details.push(`CTR: ${formatPercent(segment.ctr * 100)}`);
    if (segment.cpc !== null) details.push(`CPC: ${formatCurrency(segment.cpc)}`);
    items.push({
      title: severity === 'wasted spend'
        ? `Reduce or cap ${label}`
        : `Review ${label} first`,
      details: `${details.join(' · ')}. The export shows weak signal here, so this is the safest place to tighten or compare before changing budgets elsewhere in this export.`,
    });
  }

  if (!items.length && totalSpend > 0 && totalConversions === 0) {
    items.push({
      title: 'Hold budget increases until conversion signal improves',
      details: 'Spend is present, but the exports do not show any conversions. The safest reading is that the account is either under-reporting outcomes or spending into weak signal.',
    });
  }

  if (!items.length && hasRevenue === false) {
    items.push({
      title: 'Use cost per result as the main control',
      details: 'Revenue is missing, so ROAS cannot be assessed from this export alone. Cost per result and conversion volume are the safer controls for now.',
    });
  }

  if (!items.length) {
    items.push({
      title: `Review ${segmentDisplayName(topSegment || {})} first`,
      details: 'Nothing obviously broken stands out from the available fields, but the safest next move is to keep the highest-spend segment under review and compare it against the next export.',
    });
  }

  const platformIssue = platformSummaries
    .filter((item) => item.rows > 0)
    .sort((a, b) => (a.cpa || Infinity) - (b.cpa || Infinity))[0];
  if (platformIssue && platformIssue.platform !== 'unknown' && platformIssue.conversions === 0 && totalSpend > 0) {
    items.push({
      title: `${platformIssue.platform === 'google_ads' ? 'Hold Google Ads increases' : 'Hold Meta Ads increases'} until signal improves`,
      details: 'The platform-level export shows spend but no recorded conversions. That often points to either weak traffic quality or incomplete conversion tracking.',
    });
  }

  if (platformSummaries.length > 1) {
    items.push({
      title: 'Separate platform comparisons before changing budget',
      details: 'Google Ads and Meta Ads do not mean the same thing in a review, so it is safer to compare them separately before making a budget move.',
    });
  } else if (topPlatform && topPlatform.platform !== 'unknown') {
    items.push({
      title: `Review ${topPlatform.platform === 'google_ads' ? 'Google Ads' : 'Meta Ads'} in isolation`,
      details: 'There is only one clearly detected platform export, so the safer move is to judge that platform on its own signal rather than forcing a cross-platform comparison.',
    });
  }

  return items.slice(0, 3);
};

const buildWeakSignalNotes = ({ overall, missingFields, platformSummaries, topSegments }) => {
  const notes = [];
  if (!overall.rows) {
    notes.push('No usable rows were found in the CSV exports.');
    return notes;
  }
  if (!overall.impressions && !overall.clicks && !overall.conversions) {
    notes.push('The exports do not expose enough activity fields to assess waste confidently.');
  }
  if (overall.conversions === 0) {
    notes.push('No conversions were visible in the processed rows, so the current evidence leans toward weak signal rather than proven efficiency.');
  }
  if (overall.revenue === null) {
    notes.push('Revenue / conversion value was not present, so ROAS cannot be calculated from these exports.');
  }
  if (missingFields.length) {
    notes.push(`Missing columns: ${missingFields.join(', ')}.`);
  }
  const heavyNoConv = topSegments.find((segment) => segment.spend >= overall.spend * 0.1 && (segment.conversions || 0) === 0);
  if (heavyNoConv) {
    notes.push(`A high-spend segment (${heavyNoConv.segment_label}) appears to have no conversions, which is a common waste marker.`);
  }
  const platformWithThinSignal = platformSummaries.find((item) => item.rows && (!item.conversions || item.conversions === 0) && item.spend > 0);
  if (platformWithThinSignal) {
    notes.push(`${platformWithThinSignal.platform === 'google_ads' ? 'Google Ads' : platformWithThinSignal.platform === 'meta_ads' ? 'Meta Ads' : 'One export'} shows spend without a clear conversion signal.`);
  }
  return notes;
};

const buildPlatformTradeoffNotes = ({ platformSummaries, overall }) => {
  const notes = [];
  const google = platformSummaries.find((item) => item.platform === 'google_ads');
  const meta = platformSummaries.find((item) => item.platform === 'meta_ads');

  if (google && meta) {
    const better = (google.cpa !== null && meta.cpa !== null)
      ? (google.cpa <= meta.cpa ? 'Google Ads appears more efficient on cost per result.' : 'Meta Ads appears more efficient on cost per result.')
      : (google.conversions > meta.conversions ? 'Google Ads shows more conversion signal.' : 'Meta Ads shows more conversion signal.');
    notes.push(better);
    notes.push('Google Ads is usually better for closer-to-demand intent; Meta usually needs stronger creative and audience context. Those tradeoffs matter more when conversion volume is thin.');
  } else if (google || meta) {
    const platform = google || meta;
    notes.push(`${platform.platform === 'google_ads' ? 'Google Ads' : 'Meta Ads'} is the only clearly detected platform export, so the comparison is limited.`);
  } else {
    notes.push('Platform detection was inconclusive, so the tradeoff view stays generic.');
  }

  if (!overall.revenue) {
    notes.push('Without revenue or value, platform tradeoffs should be judged more on conversion quality and waste markers than on ROAS.');
  }

  return notes;
};

const buildRecommendations = ({ overall, topSegments, platformSummaries }) => {
  const recommendations = [];
  const highestSpend = topSegments[0];
  const topPlatform = [...platformSummaries].sort((a, b) => b.spend - a.spend)[0];

  if (highestSpend && highestSpend.spend > 0) {
    recommendations.push({
      title: `Audit ${highestSpend.segment_label}`,
      details: `This is the largest spend segment in the export set. Check targeting, search terms or creative, and whether it is producing enough conversion signal to justify the spend.`,
    });
  }

  if (overall.revenue === null) {
    recommendations.push({
      title: 'Add revenue / value tracking to the next export',
      details: 'ROAS is unavailable without conversion value. Keep the analysis conservative until value reporting is present.',
    });
  }

  if (topPlatform && topPlatform.conversions === 0 && topPlatform.spend > 0) {
    recommendations.push({
      title: `Pause or reduce the ${topPlatform.platform === 'google_ads' ? 'Google Ads' : topPlatform.platform === 'meta_ads' ? 'Meta Ads' : 'largest'} test segment until signal improves`,
      details: 'The current export suggests spend is being spent into weak signal. Consider tightening budgets until conversion evidence improves.',
    });
  }

  if (!recommendations.length) {
    recommendations.push({
      title: `Review ${segmentDisplayName(highestSpend || {})} first`,
      details: 'The data does not show a dramatic outlier, so the safest move is to keep the highest-spend segment under review and watch whether efficiency holds.',
    });
  }

  return recommendations.slice(0, 3);
};

const buildScalingCaution = ({ overall, platformSummaries, topSegments }) => {
  const hasWeakSignal = topSegments.some((segment) => segment.spend >= overall.spend * 0.1 && (segment.conversions || 0) === 0);
  const totalSpend = overall.spend || 0;
  const lowData = overall.rows < 25 || totalSpend < 100;
  const noRevenue = overall.revenue === null;
  const noConversions = overall.conversions === 0;
  const thinPlatform = platformSummaries.some((item) => item.spend > 0 && item.conversions === 0);

  const pieces = [];
  if (lowData) pieces.push('The dataset is still small, so any scaling call should stay cautious.');
  if (noConversions) pieces.push('No recorded conversions were visible, which makes scale-up risky.');
  if (noRevenue) pieces.push('Without revenue, scale decisions should rely on conversion signal rather than ROAS.');
  if (hasWeakSignal || thinPlatform) pieces.push('At least one spend segment appears to be running on weak signal, so it would be safer to tighten targeting before adding budget.');
  if (!pieces.length) pieces.push('Nothing here proves the account is ready to scale aggressively; the safer direction is to expand only the best-signalled rows and keep watching efficiency closely.');
  return pieces;
};

const buildExecutiveSummary = ({ overall, platformSummaries, topSegments }) => {
  const platformCount = platformSummaries.filter((item) => item.rows > 0).length;
  const spendText = formatCurrency(overall.spend);
  const conversionText = formatNumber(overall.conversions);
  const clickText = formatNumber(overall.clicks);
  const impressionText = formatNumber(overall.impressions);
  const signalText = overall.conversions > 0 ? 'There is at least some conversion signal to work with.' : 'Conversion signal looks thin or absent.';
  const platformText = platformCount > 1 ? 'Both Google and Meta exports are present, so the comparison is useful.' : 'The comparison is limited by the number of detected platforms.';
  const wasteText = topSegments.some((segment) => segment.spend >= overall.spend * 0.1 && (segment.conversions || 0) === 0)
    ? 'At least one high-spend segment appears to be wasting budget or lacking measurable signal.'
    : 'No single row jumps out as an extreme outlier, but the safest reading is still conservative.';
  return `${spendText} of spend was analyzed across ${formatNumber(overall.rows)} rows, with ${clickText} clicks, ${impressionText} impressions and ${conversionText} conversions visible. ${signalText} ${platformText} ${wasteText}`;
};

const buildHowToRead = ({ overall }) => {
  if (overall.revenue === null) {
    return 'Read this report as a conservative waste-and-signal review. Cost per result, CTR, and conversion volume matter more here than ROAS, because value data is missing.';
  }
  return 'Read this report as a conservative efficiency review. The safest changes are usually the ones that reduce waste first, then widen only the rows with repeatable signal.';
};

const buildExpectedImpact = ({ overall, topSegments }) => {
  if (!overall.rows) return 'No usable input was processed, so there is no reliable impact estimate.';
  if (topSegments.some((segment) => segment.spend >= overall.spend * 0.1 && (segment.conversions || 0) === 0)) {
    return 'Tightening the weak-signal rows should reduce wasted spend and make the account easier to scale once conversion tracking is clearer.';
  }
  if (overall.conversions === 0) {
    return 'The likely impact is diagnostic first: improve signal quality, then use the next review to judge efficiency with more confidence.';
  }
  return 'The likely impact is incremental: small targeting and budget changes should improve control without making the account more fragile.';
};

const buildExecutiveFinding = ({ overall, topSegments, platformSummaries }) => {
  if (!overall.rows) return 'No usable input was processed, so there is no reliable finding yet.';
  const highestSpend = topSegments[0] || null;
  const strongestConversion = [...topSegments].filter((segment) => Number(segment.conversions || 0) > 0).sort((a, b) => Number(b.conversions || 0) - Number(a.conversions || 0) || Number(b.spend || 0) - Number(a.spend || 0))[0] || null;
  const weakestEfficiency = [...topSegments].filter((segment) => Number(segment.spend || 0) > 0).sort((a, b) => {
    const aScore = Number.isFinite(Number(a.roas)) ? Number(a.roas) : (Number(a.conversions || 0) > 0 ? safeRatio(a.conversions, a.spend) : 0);
    const bScore = Number.isFinite(Number(b.roas)) ? Number(b.roas) : (Number(b.conversions || 0) > 0 ? safeRatio(b.conversions, b.spend) : 0);
    return aScore - bScore;
  })[0] || null;
  const bestRoas = [...topSegments].filter((segment) => Number.isFinite(Number(segment.roas))).sort((a, b) => Number(b.roas) - Number(a.roas))[0] || null;
  const highCpaConcern = [...topSegments].filter((segment) => Number.isFinite(Number(segment.cpa))).sort((a, b) => Number(b.cpa) - Number(a.cpa))[0] || null;
  const pieces = [];
  if (highestSpend) pieces.push(`Spend appears concentrated in ${segmentDisplayName(highestSpend)}.`);
  if (strongestConversion && strongestConversion !== highestSpend) {
    pieces.push(`${segmentDisplayName(strongestConversion)} looks like the strongest conversion signal in the export.`);
  }
  if (bestRoas && bestRoas !== strongestConversion && bestRoas !== highestSpend) {
    pieces.push(`${segmentDisplayName(bestRoas)} appears to carry the strongest ROAS signal.`);
  }
  if (weakestEfficiency && weakestEfficiency !== highestSpend && weakestEfficiency !== strongestConversion && weakestEfficiency !== bestRoas) {
    pieces.push(`${segmentDisplayName(weakestEfficiency)} may need closer review because the efficiency signal looks weaker.`);
  } else if (highCpaConcern && highCpaConcern !== highestSpend && highCpaConcern !== strongestConversion) {
    pieces.push(`${segmentDisplayName(highCpaConcern)} may need closer review because CPA looks elevated.`);
  }
  const accountWideNote = overall.conversions > 0
    ? 'No obvious account-wide issue stands out yet, but confidence is limited to the available fields.'
    : 'No major issue stands out from the first export alone, so the next review will be more useful once another submission is available.';
  if (!pieces.length) pieces.push(accountWideNote);
  pieces.push('The safest next move is to keep the highest-spend area under review and compare it against the next export.');
  return pieces.slice(0, 3).join(' ');
};

const buildKeySignals = ({ overall, topSegments }) => {
  const signals = [];
  const pushSignal = (label, title, details) => {
    if (!title || signals.length >= 5) return;
    const key = `${label}:${title}`.toLowerCase();
    if (signals.some((item) => `${item.label}:${item.title}`.toLowerCase() === key)) return;
    signals.push({ label, title, details });
  };

  const highestSpend = topSegments[0] || null;
  const strongestConversion = [...topSegments].filter((segment) => Number(segment.conversions || 0) > 0).sort((a, b) => Number(b.conversions || 0) - Number(a.conversions || 0) || Number(b.spend || 0) - Number(a.spend || 0))[0] || null;
  const weakestEfficiency = [...topSegments].filter((segment) => Number(segment.spend || 0) > 0).sort((a, b) => {
    const aScore = Number.isFinite(Number(a.roas)) ? Number(a.roas) : (Number(a.conversions || 0) > 0 ? safeRatio(a.conversions, a.spend) : 0);
    const bScore = Number.isFinite(Number(b.roas)) ? Number(b.roas) : (Number(b.conversions || 0) > 0 ? safeRatio(b.conversions, b.spend) : 0);
    return aScore - bScore;
  })[0] || null;
  const bestRoas = [...topSegments].filter((segment) => Number.isFinite(Number(segment.roas))).sort((a, b) => Number(b.roas) - Number(a.roas))[0] || null;
  const highestCpa = [...topSegments].filter((segment) => Number.isFinite(Number(segment.cpa))).sort((a, b) => Number(b.cpa) - Number(a.cpa))[0] || null;

  if (highestSpend) pushSignal('Highest spend', segmentDisplayName(highestSpend), `${formatCurrency(highestSpend.spend)} spend`);
  if (strongestConversion) pushSignal('Strongest conversion signal', segmentDisplayName(strongestConversion), `${formatNumber(strongestConversion.conversions)} conversions`);
  if (weakestEfficiency) pushSignal('Weakest efficiency signal', segmentDisplayName(weakestEfficiency), weakestEfficiency.conversions ? `ROAS ${formatNumber(weakestEfficiency.roas, 2)}x · CPA ${formatCurrency(weakestEfficiency.cpa)}` : `${formatCurrency(weakestEfficiency.spend)} spend · no recorded conversions`);
  if (bestRoas) pushSignal('Best ROAS signal', segmentDisplayName(bestRoas), `ROAS ${formatNumber(bestRoas.roas, 2)}x`);
  if (highestCpa) pushSignal('Highest CPA concern', segmentDisplayName(highestCpa), `CPA ${formatCurrency(highestCpa.cpa)}`);

  return signals.slice(0, 5);
};

const buildSourceSummaries = (files) => files.map((file) => {
  const rows = file.records.length;
  const spend = file.totals.spend;
  return `- **${file.filename}** — ${file.platform_label}; ${formatNumber(rows)} rows; ${formatCurrency(spend)} spend${file.totals.conversions !== null ? `; ${formatNumber(file.totals.conversions)} conversions` : ''}${file.totals.revenue !== null ? `; ${formatCurrency(file.totals.revenue)} value` : ''}.`;
}).join('\n');

const buildTopPriorityMarkdown = (items) => items.map((item, index) => `${index + 1}. ${item.title}\n   - ${item.details}`).join('\n');

const buildBulletMarkdown = (items) => items.map((item) => `- ${item}`).join('\n');

const analyzeUpload = ({ filename, text }) => {
  const rows = parseCsvText(text);
  if (!rows.length) throw new Error(`No usable CSV rows found in ${filename || 'upload'}`);
  const headers = rows[0];
  const dataRows = rows.slice(1);
  if (!headers.length || dataRows.length < 0) throw new Error(`Unable to parse CSV headers for ${filename || 'upload'}`);

  const fieldMap = buildFieldMap(headers);
  const platform = detectPlatformFromHints({ filename, headers, text });
  const records = [];
  const skippedRows = [];

  for (const row of dataRows) {
    const rowObject = {};
    headers.forEach((header, index) => {
      rowObject[header] = row[index] ?? '';
    });
    const record = extractRecord(rowObject, fieldMap, platform);
    const hasSignal = [record.spend, record.clicks, record.impressions, record.conversions, record.revenue].some((value) => value !== null && value !== undefined && value !== 0);
    if (!hasSignal && Object.values(record).every((value) => value === null || value === '' || value === undefined)) {
      skippedRows.push(rowObject);
      continue;
    }
    records.push(record);
  }

  const totals = records.reduce((acc, record) => {
    acc.rows += 1;
    acc.spend += Number(record.spend || 0);
    acc.clicks += Number(record.clicks || 0);
    acc.impressions += Number(record.impressions || 0);
    acc.conversions += Number(record.conversions || 0);
    acc.revenueSeen = acc.revenueSeen || Number.isFinite(Number(record.revenue));
    acc.revenue += Number(record.revenue || 0);
    return acc;
  }, { rows: 0, spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0, revenueSeen: false });

  const dimensionMap = new Map();
  for (const record of records) {
    const segmentLabel = chooseSegmentKey(record);
    const current = dimensionMap.get(segmentLabel) || {
      segment_label: segmentLabel,
      spend: 0,
      clicks: 0,
      impressions: 0,
      conversions: 0,
      revenue: 0,
      revenue_seen: false,
    };
    current.spend += Number(record.spend || 0);
    current.clicks += Number(record.clicks || 0);
    current.impressions += Number(record.impressions || 0);
    current.conversions += Number(record.conversions || 0);
    if (Number.isFinite(Number(record.revenue))) {
      current.revenue += Number(record.revenue || 0);
      current.revenue_seen = true;
    }
    current.campaign_name = current.campaign_name || record.campaign_name || '';
    current.ad_group = current.ad_group || record.ad_group || '';
    current.ad_name = current.ad_name || record.ad_name || '';
    current.keyword = current.keyword || record.keyword || '';
    current.search_term = current.search_term || record.search_term || '';
    current.device = current.device || record.device || '';
    current.country = current.country || record.country || '';
    current.campaign_type = current.campaign_type || record.campaign_type || '';
    current.platform = current.platform || record.platform || platform;
    dimensionMap.set(segmentLabel, current);
  }

  const segments = [...dimensionMap.values()].map((segment) => ({
    ...segment,
    ctr: safeRatio(segment.clicks, segment.impressions),
    cpc: safeRatio(segment.spend, segment.clicks),
    cpa: safeRatio(segment.spend, segment.conversions),
    roas: segment.revenue_seen ? safeRatio(segment.revenue, segment.spend) : null,
  })).sort((a, b) => b.spend - a.spend);

  const topSegments = segments.slice(0, 8);
  const missingFields = [];
  for (const [canonical, column] of Object.entries(fieldMap)) {
    if (!column && ['spend', 'clicks', 'impressions', 'conversions', 'revenue'].includes(canonical)) missingFields.push(canonical);
  }

  return {
    filename,
    platform,
    platform_label: platform === 'google_ads' ? 'Google Ads' : platform === 'meta_ads' ? 'Meta Ads' : 'Unknown ad export',
    headers,
    field_map: fieldMap,
    rows: records.length,
    totals: {
      rows: totals.rows,
      spend: totals.spend,
      clicks: totals.clicks,
      impressions: totals.impressions,
      conversions: totals.conversions,
      revenue: totals.revenueSeen ? totals.revenue : null,
    },
    records,
    top_segments: topSegments,
    missing_fields: missingFields,
    skipped_rows: skippedRows.length,
  };
};

const generatePortalReport = ({ files = [], workspace = null } = {}) => {
  if (!Array.isArray(files) || !files.length) throw new Error('No CSV files were supplied.');
  const analyses = files.map((file) => analyzeUpload(file));
  const allRecords = analyses.flatMap((file) => file.records.map((record) => ({ ...record, platform: record.platform || file.platform })));
  const overall = allRecords.reduce((acc, record) => {
    acc.rows += 1;
    acc.spend += Number(record.spend || 0);
    acc.clicks += Number(record.clicks || 0);
    acc.impressions += Number(record.impressions || 0);
    acc.conversions += Number(record.conversions || 0);
    acc.revenueSeen = acc.revenueSeen || Number.isFinite(Number(record.revenue));
    acc.revenue += Number(record.revenue || 0);
    return acc;
  }, { rows: 0, spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0, revenueSeen: false });

  const allSegments = new Map();
  for (const record of allRecords) {
    const key = chooseSegmentKey(record);
    const current = allSegments.get(key) || {
      segment_label: key,
      spend: 0,
      clicks: 0,
      impressions: 0,
      conversions: 0,
      revenue: 0,
      revenue_seen: false,
      platform: record.platform || 'unknown',
    };
    current.spend += Number(record.spend || 0);
    current.clicks += Number(record.clicks || 0);
    current.impressions += Number(record.impressions || 0);
    current.conversions += Number(record.conversions || 0);
    if (Number.isFinite(Number(record.revenue))) {
      current.revenue += Number(record.revenue || 0);
      current.revenue_seen = true;
    }
    current.platform = current.platform || record.platform || 'unknown';
    allSegments.set(key, current);
  }

  const topSegments = [...allSegments.values()]
    .map((segment) => ({
      ...segment,
      ctr: safeRatio(segment.clicks, segment.impressions),
      cpc: safeRatio(segment.spend, segment.clicks),
      cpa: safeRatio(segment.spend, segment.conversions),
      roas: segment.revenue_seen ? safeRatio(segment.revenue, segment.spend) : null,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 8);

  const platformSummaries = [
    summarizePlatform('google_ads', allRecords.filter((record) => record.platform === 'google_ads')),
    summarizePlatform('meta_ads', allRecords.filter((record) => record.platform === 'meta_ads')),
    summarizePlatform('unknown', allRecords.filter((record) => !['google_ads', 'meta_ads'].includes(record.platform))),
  ].filter((item) => item.rows > 0 || item.spend > 0 || item.clicks > 0 || item.impressions > 0 || item.conversions > 0);

  const missingFields = [...new Set(analyses.flatMap((file) => file.missing_fields || []))];
  const priorityItems = buildPriorityItems({ overall, topSegments, platformSummaries });
  const weakSignalNotes = buildWeakSignalNotes({ overall, missingFields, platformSummaries, topSegments });
  const tradeoffNotes = buildPlatformTradeoffNotes({ platformSummaries, overall });
  const recommendationItems = buildRecommendations({ overall, topSegments, platformSummaries });
  const scalingCaution = buildScalingCaution({ overall, platformSummaries, topSegments });
  const executiveSummary = buildExecutiveSummary({ overall, platformSummaries, topSegments });
  const howToRead = buildHowToRead({ overall });
  const expectedImpact = buildExpectedImpact({ overall, topSegments });
  const sourceFile = analyses.map((file) => file.filename).join(', ');
  const reportTitle = 'Gnomeo Review';
  const keyInsights = [
    overall.conversions > 0 ? 'At least some conversion signal is present, but the export still needs careful interpretation.' : 'Conversion signal is thin or absent in the processed exports.',
    overall.revenue !== null ? 'Value / revenue data is present, so ROAS can be reviewed cautiously.' : 'Revenue / value data is missing, so ROAS cannot be calculated.',
    ...tradeoffNotes.slice(0, 2),
  ];
  const campaignNames = [...new Set(allRecords.map((record) => cleanDisplayLabel(record.campaign_name || record.ad_group || record.ad_name || record.keyword || record.search_term || record.segment_label)).filter(Boolean))];
  const keySignals = buildKeySignals({ overall, topSegments });
  const executiveFinding = buildExecutiveFinding({ overall, topSegments, platformSummaries });

  const confidenceNotes = [
    overall.rows < 25 ? 'The dataset is small, so the report should be treated as directional rather than definitive.' : 'The row count is enough for a directional review, but not enough to claim statistical certainty.',
    overall.revenue === null ? 'Revenue was not supplied, so the analysis cannot evaluate actual return on spend.' : 'Revenue was supplied, but the value signal should still be checked against real business context.',
    missingFields.length ? `Some common fields were missing: ${missingFields.join(', ')}.` : 'The exports exposed at least the core spend and conversion fields.',
  ];

  const nextReviewFocus = [
    'Check the highest-spend rows first and confirm whether they are producing enough conversion signal.',
    overall.revenue === null ? 'Add conversion value / revenue fields to the next export so ROAS can be assessed.' : 'Compare cost per result and ROAS against the next export to see whether the account is improving or drifting.',
    'Re-run the review on the next time slice to see whether the same waste patterns repeat.',
  ];

  const summary = {
    report_title: reportTitle,
    executive_summary: executiveSummary,
    how_to_read: howToRead,
    confidence_and_limitations: confidenceNotes,
    key_insights: keyInsights,
    key_signals: keySignals,
    executive_finding: executiveFinding,
    key_decisions: priorityItems,
    expected_impact: expectedImpact,
    source_file: sourceFile,
    next_review_focus: nextReviewFocus,
    metrics: {
      rows: overall.rows,
      spend: overall.spend,
      clicks: overall.clicks,
      impressions: overall.impressions,
      conversions: overall.conversions,
      revenue: overall.revenueSeen ? overall.revenue : null,
      ctr: safeRatio(overall.clicks, overall.impressions),
      cpc: safeRatio(overall.spend, overall.clicks),
      cpa: safeRatio(overall.spend, overall.conversions),
      roas: overall.revenueSeen ? safeRatio(overall.revenue, overall.spend) : null,
      platforms: platformSummaries,
      campaign_names: campaignNames,
      files: analyses.map((file) => ({
        filename: file.filename,
        platform: file.platform,
        rows: file.totals.rows,
        spend: file.totals.spend,
        clicks: file.totals.clicks,
        impressions: file.totals.impressions,
        conversions: file.totals.conversions,
        revenue: file.totals.revenue,
      })),
    },
  };

  const markdown = [
    `# ${reportTitle}`,
    '',
    `Source file: ${sourceFile || 'Unknown'}`,
    '',
    '## Sources analyzed',
    buildSourceSummaries(analyses),
    '',
    '## Executive Summary',
    executiveSummary,
    '',
    '## Executive Finding',
    executiveFinding,
    '',
    '## Key Signals Detected',
    ...keySignals.map((item) => `- ${item.label}: ${item.title}${item.details ? ` — ${item.details}` : ''}`),
    '',
    '## Account Snapshot',
    `- Rows analyzed: ${formatNumber(overall.rows)}`,
    `- Spend: ${formatCurrency(overall.spend)}`,
    `- Impressions: ${formatNumber(overall.impressions)}`,
    `- Clicks: ${formatNumber(overall.clicks)}`,
    `- Conversions / results: ${formatNumber(overall.conversions)}`,
    overall.revenue !== null ? `- Revenue / value: ${formatCurrency(overall.revenue)}` : '- Revenue / value: not present in the export',
    overall.impressions ? `- CTR: ${formatPercent(safeRatio(overall.clicks, overall.impressions) * 100)}` : '- CTR: not available',
    overall.clicks ? `- CPC: ${formatCurrency(safeRatio(overall.spend, overall.clicks))}` : '- CPC: not available',
    overall.conversions ? `- CPA / cost per result: ${formatCurrency(safeRatio(overall.spend, overall.conversions))}` : '- CPA / cost per result: not available',
    overall.revenue !== null && overall.spend ? `- ROAS: ${formatNumber(safeRatio(overall.revenue, overall.spend), 2)}x` : '- ROAS: not available',
    '',
    '## Top Priorities',
    buildTopPriorityMarkdown(priorityItems),
    '',
    '## Waste / Weak Signal Notes',
    buildBulletMarkdown(weakSignalNotes),
    '',
    '## Platform Tradeoffs',
    buildBulletMarkdown(tradeoffNotes),
    '',
    '## Recommendations',
    buildBulletMarkdown(recommendationItems.map((item) => `${item.title}: ${item.details}`)),
    '',
    '## Scaling Caution',
    buildBulletMarkdown(scalingCaution),
    '',
    '## Next Review Focus',
    buildBulletMarkdown(nextReviewFocus),
    '',
    '## Key Insights',
    buildBulletMarkdown(keyInsights),
    '',
    '## Key Decisions',
    buildTopPriorityMarkdown(priorityItems),
    '',
    '## Expected Impact',
    expectedImpact,
    '',
    '## How to read this report',
    howToRead,
    '',
    '## Confidence & Limitations',
    buildBulletMarkdown(confidenceNotes),
  ].join('\n');

  return {
    markdown,
    summary,
    title: reportTitle,
    source_platforms: analyses.map((file) => file.platform).filter(Boolean),
    source_filenames: analyses.map((file) => file.filename),
    row_count: overall.rows,
    input_bytes: files.reduce((sum, file) => sum + Buffer.byteLength(String(file.text || ''), 'utf8'), 0),
    metrics: summary.metrics,
    top_segments: topSegments,
    platform_summaries: platformSummaries,
    overall,
  };
};

module.exports = {
  parseCsvText,
  detectPlatformFromHints,
  analyzeUpload,
  generatePortalReport,
};
