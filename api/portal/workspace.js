const { restSelect } = require('../_supabase');
const {
  portalLimitsForPlan,
  getPortalTokenFromRequest,
  getWorkspaceByPortalToken,
  logUsageEvent,
  updatePortalTokenUse,
  safeWorkspace,
  safeHistoryRun,
  parseReportMarkdown,
  workspaceMemoryFromWorkspace,
} = require('../_portal');

const respond = (res, statusCode, payload) => res.status(statusCode).json(payload);

const monthStartIso = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
};

const listReportRuns = async (workspaceId, limit = 20) => {
  const rows = await restSelect('report_runs', {
    select: '*',
    workspace_id: `eq.${workspaceId}`,
    order: 'created_at.desc',
    limit,
  });
  return Array.isArray(rows) ? rows : [];
};

const countMonthlyReports = async (workspaceId) => {
  const rows = await restSelect('usage_events', {
    select: 'id',
    workspace_id: `eq.${workspaceId}`,
    event_type: 'eq.portal_report_generated',
    created_at: `gte.${monthStartIso()}`,
    limit: 250,
  });
  return Array.isArray(rows) ? rows.length : 0;
};

const workspaceContext = (workspace) => ({
  workspace_name: workspace.workspace_name,
  business_type: workspace.business_type,
  primary_goal: workspace.primary_goal,
  risk_appetite: workspace.risk_appetite,
  budget_constraint: workspace.budget_constraint,
  plan: workspace.plan,
  status: workspace.status,
});

module.exports = async (req, res) => {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    return respond(res, 405, { success: false, error: 'Method not allowed' });
  }

  const token = getPortalTokenFromRequest(req);
  if (!token) {
    return respond(res, 401, { success: false, error: 'Missing portal token' });
  }

  const workspace = await getWorkspaceByPortalToken(token);
  if (!workspace || workspace.status === 'inactive' || workspace.status === 'cancelled') {
    return respond(res, 404, { success: false, error: 'Workspace not found' });
  }

  const runs = await listReportRuns(workspace.id, 20);
  const latest = runs[0] || null;
  const latestMarkdown = latest?.report_content || '';
  const latestParsed = latestMarkdown ? parseReportMarkdown(latestMarkdown) : null;
  const limits = portalLimitsForPlan(workspace.plan);
  const reportsThisMonth = await countMonthlyReports(workspace.id);
  const remainingReports = typeof limits.maxReportsPerMonth === 'number'
    ? Math.max(0, limits.maxReportsPerMonth - reportsThisMonth)
    : null;

  await updatePortalTokenUse(workspace.id);
  await logUsageEvent({
    workspace_id: workspace.id,
    event_type: 'portal_viewed',
    plan: workspace.plan,
    metadata: {
      workspace_name: workspace.workspace_name,
      report_count: runs.length,
    },
  });

  const latestReport = latest ? {
    ...safeHistoryRun(latest),
    report_content: latestMarkdown,
    summary: latest.summary || latestParsed || {},
    top_recommendations: latest.top_recommendations || latestParsed?.key_decisions || [],
    trend_snapshot: latest.trend_snapshot || latestParsed?.key_insights || [],
    next_review_focus: latestParsed?.next_review_focus || [],
  } : null;

  const reportHistory = runs.map((run) => ({
    ...safeHistoryRun(run),
    summary: run.summary || {},
    top_recommendations: run.top_recommendations || [],
    trend_snapshot: run.trend_snapshot || [],
  }));

  const publicWorkspace = safeWorkspace(workspace);
  delete publicWorkspace.owner_email;

  return respond(res, 200, {
    success: true,
    workspace: publicWorkspace,
    workspace_memory: workspaceMemoryFromWorkspace(workspace),
    workspace_context: workspaceContext(workspace),
    upload_limits: {
      plan_label: limits.planLabel,
      max_files: limits.maxFiles,
      max_file_bytes: limits.maxFileBytes,
      max_total_rows: limits.maxTotalRows,
      max_reports_per_month: limits.maxReportsPerMonth,
      remaining_reports_this_month: remainingReports,
      allowed_platforms: limits.allowedPlatforms,
    },
    latest_report: latestReport,
    report_history: reportHistory,
    top_priorities: latestParsed?.key_decisions?.slice(0, 3) || [],
    trend_snapshot: latestReport?.trend_snapshot || latestParsed?.key_insights || [],
    next_review_focus: latestParsed?.next_review_focus || [
      'Upload the latest Google Ads and Meta Ads exports',
      'Check waste concentration and weak signal areas',
      'Review whether budget allocation should change',
    ],
  });
};
