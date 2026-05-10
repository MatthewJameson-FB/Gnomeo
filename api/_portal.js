const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { restSelect, restInsert, restUpdate } = require('./_supabase');
const { FREE_REPORT_LIMITS, PRO_REPORT_LIMITS, AGENCY_REPORT_LIMITS } = require('./_limits');

const execFileAsync = promisify(execFile);
const AGENT_SCRIPT = path.join(process.cwd(), 'agent_mvp', 'agent_test.py');

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
  created_at: workspace.created_at,
  updated_at: workspace.updated_at,
  portal_token_created_at: workspace.portal_token_created_at || null,
  portal_token_last_used_at: workspace.portal_token_last_used_at || null,
  portal_token_revoked_at: workspace.portal_token_revoked_at || null,
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
});

const safeLatestRun = (run) => run ? {
  ...safeHistoryRun(run),
  report_content: run.report_content || '',
} : null;

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

const resolvePythonCommand = async () => {
  for (const command of ['python3', 'python']) {
    try {
      await execFileAsync(command, ['-c', 'import sys; sys.exit(0)'], { timeout: 5000 });
      return command;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (String(error?.message || '').includes('not found')) continue;
    }
  }
  throw new Error('Python runtime not available');
};

const runReportGenerator = async ({ csvPaths, timeoutMs = 180000 } = {}) => {
  const command = await resolvePythonCommand();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomeo-portal-'));
  const outputMarkdown = path.join(tempDir, 'report.md');
  const outputHtml = path.join(tempDir, 'report.html');

  try {
    const args = [
      AGENT_SCRIPT,
      '--graph',
      ...csvPaths,
      '--output-report',
      outputMarkdown,
      '--output-html',
      outputHtml,
    ];

    await execFileAsync(command, args, {
      cwd: path.dirname(AGENT_SCRIPT),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    const markdown = fs.readFileSync(outputMarkdown, 'utf8');
    const html = fs.existsSync(outputHtml) ? fs.readFileSync(outputHtml, 'utf8') : '';
    return { command, markdown, html };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  detectSourcePlatforms,
  runReportGenerator,
  getPortalTokenFromRequest,
  getWorkspaceByPortalToken,
  logUsageEvent,
  updatePortalTokenUse,
};
