const { createHash, randomBytes } = require('crypto');

const { restSelect, restInsert, restUpdate } = require('./_supabase');
const { FREE_REPORT_LIMITS, PRO_REPORT_LIMITS, AGENCY_REPORT_LIMITS } = require('./_limits');
const { generatePortalReport, detectPlatformFromHints } = require('./_reportGenerator');

const sha256Hex = (value) => createHash('sha256').update(String(value || ''), 'utf8').digest('hex');

const generatePortalToken = () => randomBytes(32).toString('base64url');
const hashPortalToken = (token) => sha256Hex(token);

const portalLimitsForPlan = (plan) => {
  switch (String(plan || '').toLowerCase()) {
    case 'agency':
      return AGENCY_REPORT_LIMITS;
    case 'free':
      return FREE_REPORT_LIMITS;
    case 'pro':
    case 'manual_beta':
    default:
      return PRO_REPORT_LIMITS;
  }
};

const getHeader = (req, name) => {
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
};

const getRequestBaseUrl = (req) => {
  const forwardedProto = String(getHeader(req, 'x-forwarded-proto') || '').trim();
  const proto = forwardedProto || (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' ? 'https' : 'http');
  const forwardedHost = String(getHeader(req, 'x-forwarded-host') || '').trim();
  const host = forwardedHost || String(getHeader(req, 'host') || '').trim();
  if (!host) return '';
  return `${proto}://${host}`;
};

const buildPortalUrl = (req, token) => {
  const relative = `/portal.html?token=${encodeURIComponent(token)}`;
  const baseUrl = getRequestBaseUrl(req);
  return baseUrl ? `${baseUrl}${relative}` : relative;
};

const safeWorkspace = (workspace) => ({
  id: workspace.id,
  profile_id: workspace.profile_id,
  owner_email: workspace.owner_email,
  workspace_name: workspace.workspace_name,
  business_type: workspace.business_type,
  primary_goal: workspace.primary_goal,
  risk_appetite: workspace.risk_appetite,
  budget_constraint: workspace.budget_constraint,
  notes: workspace.notes,
  plan: workspace.plan,
  status: workspace.status,
  website: workspace.website || null,
  platforms: workspace.platforms || [],
  review_goal: workspace.review_goal || null,
  is_agency: Boolean(workspace.is_agency),
  beta_request_id: workspace.beta_request_id || null,
  created_at: workspace.created_at,
  updated_at: workspace.updated_at,
  portal_token_created_at: workspace.portal_token_created_at || null,
  portal_token_last_used_at: workspace.portal_token_last_used_at || null,
  portal_token_revoked_at: workspace.portal_token_revoked_at || null,
  memory_summary: workspace.memory_summary || {},
  recurring_issues: workspace.recurring_issues || [],
  open_recommendations: workspace.open_recommendations || [],
  trend_snapshot: workspace.trend_snapshot || [],
  next_review_focus: workspace.next_review_focus || [],
  last_handover_at: workspace.last_handover_at || null,
  changed_since_last_review: workspace.changed_since_last_review || [],
  still_unresolved: workspace.still_unresolved || [],
  likely_actioned_or_improved: workspace.likely_actioned_or_improved || [],
  new_this_time: workspace.new_this_time || [],
  top_actions_now: workspace.top_actions_now || [],
  previous_recommendations_status: workspace.previous_recommendations_status || [],
  comparison_note: workspace.comparison_note || null,
});

const safeHistoryRun = (run) => ({
  id: run.id,
  workspace_id: run.workspace_id,
  status: run.status,
  report_title: run.report_title || 'Gnomeo report',
  created_at: run.created_at,
  source_count: run.source_count ?? null,
  source_platforms: run.source_platforms || run.platforms || [],
  source_filenames: run.source_filenames || [],
  row_count: run.row_count ?? null,
  input_bytes: run.input_bytes ?? null,
  summary: run.summary || {},
  top_recommendations: run.top_recommendations || [],
  trend_snapshot: run.trend_snapshot || [],
  sources: run.sources || [],
  recommendations: run.recommendations || [],
  top_priorities: run.top_priorities || [],
  trend_notes: run.trend_notes || '',
  completed_at: run.completed_at || null,
  error_message: run.error_message || null,
  metadata: run.metadata || {},
  comparison_summary: run.comparison_summary || {},
});

const safeLatestRun = (run) => run ? {
  ...safeHistoryRun(run),
  report_content: run.report_content || '',
  report_markdown: run.report_markdown || run.report_content || '',
  comparison_summary: run.comparison_summary || {},
} : null;

const safePortalReview = (row) => ({
  id: row.id,
  workspace_id: row.workspace_id,
  status: row.status,
  filenames: Array.isArray(row.filenames) ? row.filenames : [],
  platforms: Array.isArray(row.platforms) ? row.platforms : [],
  file_count: row.file_count ?? 0,
  report_run_id: row.report_run_id || null,
  created_at: row.created_at,
  completed_at: row.completed_at || null,
  notes: row.notes || null,
});

const segmentDisplayName = (segment = {}) => {
  const candidates = [segment.campaign_name, segment.ad_group, segment.ad_name, segment.keyword, segment.search_term, segment.segment_label];
  const selected = candidates.find((value) => String(value || '').trim()) || 'Unknown segment';
  return String(selected).trim();
};

const normalizeComparisonText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim();

const formatDelta = (current, previous, { format = 'number', label = '' } = {}) => {
  if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(previous))) return null;
  const cur = Number(current);
  const prev = Number(previous);
  const diff = cur - prev;
  const pct = prev !== 0 ? (diff / Math.abs(prev)) * 100 : null;
  const fmt = (value) => {
    if (format === 'currency') return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 }).format(value);
    if (format === 'ratio') return `${Number(value).toFixed(2)}x`;
    if (format === 'percent') return `${Number(value).toFixed(1)}%`;
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);
  };
  const direction = diff === 0 ? 'unchanged' : diff > 0 ? 'up' : 'down';
  const changeText = pct === null ? `${fmt(prev)} → ${fmt(cur)} (${direction})` : `${fmt(prev)} → ${fmt(cur)} (${direction} ${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%)`;
  return label ? `${label}: ${changeText}` : changeText;
};

const classifyRecommendation = ({ recommendation, currentSegments = [], previousSegments = [], currentMetrics = {}, previousMetrics = {} }) => {
  const text = normalizeComparisonText([recommendation?.title, recommendation?.details].filter(Boolean).join(' ')).toLowerCase();
  const currentLabels = currentSegments.map((segment) => segmentDisplayName(segment).toLowerCase());
  const previousLabels = previousSegments.map((segment) => segmentDisplayName(segment).toLowerCase());
  const matchedCurrent = currentSegments.find((segment) => currentLabels.some((label) => label && text.includes(label)));
  const matchedPrevious = previousSegments.find((segment) => previousLabels.some((label) => label && text.includes(label)));
  const currentFocus = matchedCurrent || currentSegments[0] || null;
  const previousFocus = matchedPrevious || previousSegments[0] || null;
  const previousConversions = Number(previousFocus?.conversions ?? previousMetrics.conversions ?? 0);
  const currentConversions = Number(currentFocus?.conversions ?? currentMetrics.conversions ?? 0);
  const previousSpend = Number(previousFocus?.spend ?? previousMetrics.spend ?? 0);
  const currentSpend = Number(currentFocus?.spend ?? currentMetrics.spend ?? 0);
  const previousCpa = Number(previousFocus?.cpa ?? previousMetrics.cpa ?? previousMetrics.cost_per_result ?? 0);
  const currentCpa = Number(currentFocus?.cpa ?? currentMetrics.cpa ?? currentMetrics.cost_per_result ?? 0);
  const previousRoas = Number(previousFocus?.roas ?? previousMetrics.roas ?? 0);
  const currentRoas = Number(currentFocus?.roas ?? currentMetrics.roas ?? 0);

  if (!matchedCurrent && !matchedPrevious) {
    return {
      status: 'not_enough_evidence',
      notes: 'The export does not include enough matching structure to confirm whether this recommendation was actioned.',
    };
  }

  if (matchedCurrent && !matchedPrevious) {
    return {
      status: 'still_open',
      notes: 'A similar segment is still present in the current export, so the recommendation remains relevant.',
    };
  }

  if (!matchedCurrent && matchedPrevious) {
    return {
      status: 'no_longer_visible',
      notes: 'The previously referenced segment is not visible in the current export, so it may have been changed or removed.',
    };
  }

  if (!Number.isFinite(previousSpend) || !Number.isFinite(currentSpend)) {
    return {
      status: 'not_enough_evidence',
      notes: 'Spend comparison is limited, so the report cannot confidently tell whether this recommendation improved.',
    };
  }

  const spendDown = currentSpend < previousSpend * 0.85;
  const cpaDown = previousCpa && currentCpa && currentCpa < previousCpa * 0.9;
  const roasUp = previousRoas && currentRoas && currentRoas > previousRoas * 1.1;
  const conversionsUp = currentConversions > previousConversions;

  if (spendDown || cpaDown || roasUp || conversionsUp) {
    return {
      status: 'appears_improved',
      notes: 'The current export suggests this area may have improved, but the export alone does not prove the change was caused by a specific action.',
    };
  }

  return {
    status: 'still_open',
    notes: 'The same area still looks relevant in the current export, so the recommendation remains open.',
  };
};

const buildComparisonSummary = ({ current = {}, previous = null, currentSummary = {}, currentTopSegments = [], currentPlatformSummaries = [] } = {}) => {
  const currentMetrics = current.metrics || currentSummary.metrics || {};
  const previousSummary = previous?.summary || {};
  const previousComparison = previous?.comparison_summary || {};
  const previousMetrics = previousSummary.metrics || previousComparison.current_metrics || {};
  const previousTopSegments = Array.isArray(previousComparison.top_segments) ? previousComparison.top_segments : [];
  const previousPlatformSummaries = Array.isArray(previousComparison.platform_summaries) ? previousComparison.platform_summaries : (Array.isArray(previousMetrics.platforms) ? previousMetrics.platforms : []);
  const previousRecommendations = Array.isArray(previousSummary.key_decisions) && previousSummary.key_decisions.length
    ? previousSummary.key_decisions
    : (Array.isArray(previousComparison.previous_recommendations) ? previousComparison.previous_recommendations : []);
  const currentRecommendations = Array.isArray(currentSummary.key_decisions) && currentSummary.key_decisions.length ? currentSummary.key_decisions : [];

  const changedSinceLastReview = [];
  const stillUnresolved = [];
  const likelyActionedOrImproved = [];
  const newThisTime = [];
  const previousRecommendationsStatus = [];

  if (!previous) {
    const baselineNote = 'This is the baseline review. Future reviews will compare against this export.';
    return {
      is_baseline: true,
      changed_since_last_review: [baselineNote],
      still_unresolved: currentRecommendations.slice(0, 3).map((item) => normalizeComparisonText([item.title, item.details].filter(Boolean).join(' — '))),
      likely_actioned_or_improved: [],
      new_this_time: [],
      top_actions_now: currentRecommendations.slice(0, 3),
      previous_recommendations_status: [],
      comparison_note: baselineNote,
      previous_recommendations: [],
      current_metrics: currentMetrics,
      previous_metrics: {},
      current_top_segments: currentTopSegments,
      previous_top_segments: [],
      platform_mix_current: currentPlatformSummaries,
      platform_mix_previous: [],
    };
  }

  const metricDeltas = [
    formatDelta(currentMetrics.spend, previousMetrics.spend, { format: 'currency', label: 'Spend' }),
    formatDelta(currentMetrics.conversions, previousMetrics.conversions, { format: 'number', label: 'Conversions' }),
    formatDelta(currentMetrics.revenue, previousMetrics.revenue, { format: 'currency', label: 'Revenue / value' }),
    formatDelta(currentMetrics.cpa, previousMetrics.cpa, { format: 'currency', label: 'CPA / cost per result' }),
    formatDelta(currentMetrics.roas, previousMetrics.roas, { format: 'ratio', label: 'ROAS' }),
  ].filter(Boolean);
  if (metricDeltas.length) changedSinceLastReview.push(...metricDeltas);

  const previousPlatformMap = new Map(previousPlatformSummaries.map((item) => [String(item.platform || '').toLowerCase(), item]));
  const currentPlatformMap = new Map(currentPlatformSummaries.map((item) => [String(item.platform || '').toLowerCase(), item]));
  for (const platform of ['google_ads', 'meta_ads']) {
    const currentPlatform = currentPlatformMap.get(platform);
    const prevPlatform = previousPlatformMap.get(platform);
    if (!currentPlatform || !prevPlatform) continue;
    const spendDelta = formatDelta(currentPlatform.spend, prevPlatform.spend, { format: 'currency', label: `${currentPlatform.platform === 'google_ads' ? 'Google Ads' : 'Meta Ads'} spend` });
    if (spendDelta) changedSinceLastReview.push(spendDelta);
  }

  const currentSegmentMap = new Map(currentTopSegments.map((segment) => [segmentDisplayName(segment).toLowerCase(), segment]));
  const previousSegmentMap = new Map(previousTopSegments.map((segment) => [segmentDisplayName(segment).toLowerCase(), segment]));

  for (const segment of currentTopSegments) {
    const label = segmentDisplayName(segment).toLowerCase();
    if (!previousSegmentMap.has(label)) {
      newThisTime.push(`New this time: ${segmentDisplayName(segment)} is visible in the current export.`);
    }
  }
  for (const segment of previousTopSegments) {
    const label = segmentDisplayName(segment).toLowerCase();
    if (!currentSegmentMap.has(label)) {
      likelyActionedOrImproved.push(`No longer visible: ${segmentDisplayName(segment)} no longer appears in the current top segments.`);
    }
  }

  for (const prevRec of previousRecommendations) {
    const classification = classifyRecommendation({ recommendation: prevRec, currentSegments: currentTopSegments, previousSegments: previousTopSegments, currentMetrics, previousMetrics });
    previousRecommendationsStatus.push({
      title: prevRec.title || prevRec.label || 'Previous recommendation',
      status: classification.status,
      notes: classification.notes,
    });
    if (classification.status === 'still_open') stillUnresolved.push(`${prevRec.title || prevRec.label || 'Previous recommendation'} — ${classification.notes}`);
    if (classification.status === 'appears_improved' || classification.status === 'no_longer_visible') likelyActionedOrImproved.push(`${prevRec.title || prevRec.label || 'Previous recommendation'} — ${classification.notes}`);
    if (classification.status === 'not_enough_evidence') changedSinceLastReview.push(`${prevRec.title || prevRec.label || 'Previous recommendation'} — ${classification.notes}`);
  }

  if (!stillUnresolved.length && currentRecommendations.length) {
    stillUnresolved.push(...currentRecommendations.slice(0, 3).map((item) => normalizeComparisonText([item.title, item.details].filter(Boolean).join(' — '))));
  }

  if (!newThisTime.length) {
    newThisTime.push('No clearly new segments were visible in the top results, so the current export looks like a continuation of the previous pattern.');
  }

  const topActionsNow = currentRecommendations.slice(0, 3).map((item) => ({
    title: item.title || item.label || 'Review latest segment',
    details: item.details || '',
  }));

  const comparisonNote = metricDeltas.length
    ? `The current export shows ${metricDeltas[0].toLowerCase()}.`
    : 'The current export can be compared to the previous review, but the movement is limited by the available fields.';

  return {
    is_baseline: false,
    changed_since_last_review: changedSinceLastReview.slice(0, 8),
    still_unresolved: stillUnresolved.slice(0, 8),
    likely_actioned_or_improved: likelyActionedOrImproved.slice(0, 8),
    new_this_time: newThisTime.slice(0, 8),
    top_actions_now: topActionsNow,
    previous_recommendations_status: previousRecommendationsStatus.slice(0, 8),
    comparison_note: comparisonNote,
    previous_recommendations: previousRecommendations,
    current_metrics: currentMetrics,
    previous_metrics: previousMetrics,
    current_top_segments: currentTopSegments,
    previous_top_segments: previousTopSegments,
    platform_mix_current: currentPlatformSummaries,
    platform_mix_previous: previousPlatformSummaries,
  };
};

const parseListItems = (lines) => {
  const items = [];
  for (const rawLine of lines) {
    const line = String(rawLine || '').replace(/\r/g, '');
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      items.push(bullet[1].trim());
    }
  }
  return items;
};

const parseDecisionSections = (lines) => {
  const decisions = [];
  let current = null;

  const pushCurrent = () => {
    if (current) decisions.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '').replace(/\r/g, '');
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      pushCurrent();
      current = {
        rank: Number(numbered[1]),
        title: numbered[2].trim(),
        details: [],
      };
      continue;
    }

    if (!current) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      current.details.push(bullet[1].trim());
      continue;
    }
    if (line.trim()) {
      current.details.push(line.trim());
    }
  }

  pushCurrent();
  return decisions;
};

const parseReportMarkdown = (markdown) => {
  const text = String(markdown || '').replace(/\r\n/g, '\n').trim();
  const lines = text ? text.split('\n') : [];
  const title = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : 'Gnomeo report';

  const sections = new Map();
  let currentSection = '';
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      currentSection = heading[1].trim();
      sections.set(currentSection, []);
      continue;
    }
    if (currentSection) {
      sections.get(currentSection).push(line);
    }
  }

  const sectionText = (name) => (sections.get(name) || []).map((line) => String(line || '').trim()).filter(Boolean).join('\n').trim();
  const executiveSummary = sectionText('Executive Summary');
  const keyInsights = parseListItems(sections.get('Key Insights') || []);
  const confidenceNotes = parseListItems(sections.get('Confidence & Limitations') || []);
  const decisionItems = parseDecisionSections(sections.get('Key Decisions') || []);
  const nextReviewFocus = decisionItems.slice(0, 3).map((item) => item.title || item.details[0] || 'Review recommendation').filter(Boolean);

  return {
    title,
    executive_summary: executiveSummary,
    key_decisions: decisionItems,
    key_insights: keyInsights,
    confidence_and_limitations: confidenceNotes,
    expected_impact: sectionText('Expected Impact'),
    how_to_read: sectionText('How to read this report'),
    source_file: (lines.find((line) => /^Source file:/i.test(line)) || '').split(':').slice(1).join(':').trim(),
    next_review_focus: nextReviewFocus,
  };
};

const platformDisplayName = (platform) => ({
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  mixed: 'Mixed',
  unknown: 'Unknown',
}[String(platform || '').toLowerCase()] || String(platform || '').replace(/_/g, ' ').trim() || 'Unknown');

const dedupeStrings = (values, limit = 10) => {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
};

const buildWorkspaceMemoryUpdate = ({ workspace, parsedReport, detectedPlatforms = [], sourceFilenames = [], reportRun = {}, currentMemory = {} }) => {
  const currentState = parsedReport.executive_summary || parsedReport.title || 'Report completed.';
  const platformNotes = dedupeStrings([
    detectedPlatforms.length ? `Analyzed: ${detectedPlatforms.map(platformDisplayName).join(' + ')}` : 'Platform detection was inconclusive.',
    sourceFilenames.length ? `Sources: ${sourceFilenames.join(', ')}` : '',
    reportRun.row_count ? `Rows analyzed: ${Number(reportRun.row_count).toLocaleString()}` : '',
  ], 4);
  const confidenceNotes = dedupeStrings(parsedReport.confidence_and_limitations, 5);
  const recurringIssues = dedupeStrings([
    ...confidenceNotes,
    ...parsedReport.key_insights,
  ], 8);
  const openRecommendations = dedupeStrings(parsedReport.key_decisions.map((item) => {
    const details = Array.isArray(item.details) ? item.details.filter(Boolean).join(' · ') : String(item.details || '').trim();
    return details ? `${item.title}: ${details}` : item.title;
  }), 8);
  const trendSnapshot = dedupeStrings(parsedReport.key_insights, 8);
  const nextReviewFocus = dedupeStrings(parsedReport.next_review_focus, 5);
  const memorySummary = {
    current_state: currentState,
    report_title: parsedReport.title || reportRun.report_title || 'Gnomeo report',
    last_report_date: reportRun.created_at || new Date().toISOString(),
    platform_notes: platformNotes,
    confidence_or_signal_notes: confidenceNotes,
    workspace_context: {
      workspace_name: workspace.workspace_name || '',
      business_type: workspace.business_type || '',
      primary_goal: workspace.primary_goal || '',
      risk_appetite: workspace.risk_appetite || '',
      budget_constraint: workspace.budget_constraint || '',
      plan: workspace.plan || '',
    },
  };

  return {
    memory_summary: memorySummary,
    recurring_issues: dedupeStrings([...(currentMemory.recurring_issues || []), ...recurringIssues], 10),
    open_recommendations: dedupeStrings([...(currentMemory.open_recommendations || []), ...openRecommendations], 10),
    trend_snapshot: dedupeStrings([...(currentMemory.trend_snapshot || []), ...trendSnapshot], 10),
    next_review_focus: nextReviewFocus.length ? nextReviewFocus : dedupeStrings(currentMemory.next_review_focus || [], 5),
    last_handover_at: new Date().toISOString(),
  };
};

const workspaceMemoryFromWorkspace = (workspace) => ({
  memory_summary: workspace.memory_summary || {},
  recurring_issues: workspace.recurring_issues || [],
  open_recommendations: workspace.open_recommendations || [],
  trend_snapshot: workspace.trend_snapshot || [],
  next_review_focus: workspace.next_review_focus || [],
  last_handover_at: workspace.last_handover_at || null,
});

const collectCsvText = (files, buffers) => files.map((file, index) => ({
  filename: String(file?.filename || `file-${index + 1}.csv`),
  contentType: String(file?.contentType || 'text/csv'),
  text: Buffer.isBuffer(buffers[index]) ? buffers[index].toString('utf8') : String(buffers[index] || ''),
  buffer: Buffer.isBuffer(buffers[index]) ? buffers[index] : Buffer.from(buffers[index] || '', 'utf8'),
}));

const detectSourcePlatform = ({ filename, text }) => {
  const combined = `${String(filename || '')} ${String(text || '').slice(0, 2048)}`.toLowerCase();
  const metaSignals = [
    'campaign name',
    'ad set name',
    'ad name',
    'amount spent',
    'results',
    'reach',
    'frequency',
    'facebook',
    'meta',
    'instagram',
  ];
  const googleSignals = [
    'campaign',
    'ad group',
    'clicks',
    'impr.',
    'impressions',
    'cost',
    'google ads',
    'search impression share',
    'converted clicks',
  ];

  const metaScore = metaSignals.reduce((score, signal) => score + (combined.includes(signal) ? 1 : 0), 0);
  const googleScore = googleSignals.reduce((score, signal) => score + (combined.includes(signal) ? 1 : 0), 0);

  if (metaScore && metaScore >= googleScore) return 'meta_ads';
  if (googleScore) return 'google_ads';
  return 'unknown';
};

const detectSourcePlatforms = (files, buffers) => {
  const inputs = collectCsvText(files, buffers);
  return inputs.map((input) => detectSourcePlatform({ filename: input.filename, text: input.text }));
};

const runReportGenerator = async ({ files = [] } = {}) => {
  const result = generatePortalReport({ files });
  return {
    markdown: result.markdown,
    html: '',
    title: result.title,
    summary: result.summary,
    source_platforms: result.source_platforms || [],
    source_filenames: result.source_filenames || [],
    row_count: result.row_count || 0,
    input_bytes: result.input_bytes || 0,
    metrics: result.metrics || {},
    top_segments: result.top_segments || [],
    platform_summaries: result.platform_summaries || [],
    overall: result.overall || {},
  };
};

const getPortalTokenFromRequest = (req, body = {}) => {
  const fromBody = String(body.token || body.portal_token || '').trim();
  if (fromBody) return fromBody;
  const fromQuery = String(req?.query?.token || req?.query?.portal_token || '').trim();
  if (fromQuery) return fromQuery;
  const fromHeader = String(getHeader(req, 'x-portal-token') || getHeader(req, 'authorization') || '').trim();
  if (fromHeader.startsWith('Bearer ')) return fromHeader.slice(7).trim();
  return fromHeader;
};

const getWorkspaceByPortalToken = async (token) => {
  const tokenHash = hashPortalToken(token);
  const workspaces = await restSelect('workspaces', {
    select: '*',
    portal_token_hash: `eq.${tokenHash}`, 
    portal_token_revoked_at: 'is.null',
    limit: 1,
  });
  return Array.isArray(workspaces) ? workspaces[0] || null : null;
};

const logUsageEvent = async ({ workspace_id, event_type, plan, metadata = {} }) => {
  try {
    await restInsert('usage_events', {
      id: randomBytes(16).toString('hex'),
      workspace_id,
      event_type,
      plan: plan || null,
      metadata,
      created_at: new Date().toISOString(),
    });
  } catch {
    // non-blocking telemetry
  }
};

const updatePortalTokenUse = async (workspaceId) => {
  try {
    await restUpdate('workspaces', { id: `eq.${workspaceId}` }, { portal_token_last_used_at: new Date().toISOString() });
  } catch {
    // non-blocking
  }
};

module.exports = {
  generatePortalToken,
  hashPortalToken,
  portalLimitsForPlan,
  getRequestBaseUrl,
  buildPortalUrl,
  safeWorkspace,
  safeHistoryRun,
  safeLatestRun,
  parseReportMarkdown,
  buildWorkspaceMemoryUpdate,
  workspaceMemoryFromWorkspace,
  detectSourcePlatforms,
  safePortalReview,
  runReportGenerator,
  getPortalTokenFromRequest,
  getWorkspaceByPortalToken,
  logUsageEvent,
  updatePortalTokenUse,
  buildComparisonSummary,
};
