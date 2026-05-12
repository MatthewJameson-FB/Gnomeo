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
});

const safeLatestRun = (run) => run ? {
  ...safeHistoryRun(run),
  report_content: run.report_content || '',
  report_markdown: run.report_markdown || run.report_content || '',
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
};
