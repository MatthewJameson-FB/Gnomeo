const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { parseMultipartForm } = require('../_multipart');
const { restInsert, restSelect } = require('../_supabase');
const { validateCsvUploads } = require('../_limits');
const {
  portalLimitsForPlan,
  getPortalTokenFromRequest,
  getWorkspaceByPortalToken,
  logUsageEvent,
  updatePortalTokenUse,
  safeWorkspace,
  safeHistoryRun,
  safeLatestRun,
  parseReportMarkdown,
  detectSourcePlatforms,
  runReportGenerator,
} = require('../_portal');

const respond = (res, statusCode, payload) => res.status(statusCode).json(payload);

const readRequestBuffer = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const countMonthlyReports = async (workspaceId) => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const rows = await restSelect('usage_events', {
    select: 'id',
    workspace_id: `eq.${workspaceId}`,
    event_type: 'eq.portal_report_generated',
    created_at: `gte.${monthStart}`,
    limit: 250,
  });
  return Array.isArray(rows) ? rows.length : 0;
};

const toSafeReportRun = (run, parsed) => ({
  ...safeHistoryRun(run),
  report_content: run.report_content || '',
  summary: run.summary || parsed || {},
  top_recommendations: run.top_recommendations || parsed?.key_decisions || [],
  trend_snapshot: run.trend_snapshot || parsed?.key_insights || [],
});

module.exports = async (req, res) => {
  if (String(req.method || 'POST').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { success: false, error: 'Method not allowed' });
  }

  const contentType = String(req.headers['content-type'] || '');
  const rawBuffer = await readRequestBuffer(req);
  let body = {};
  let uploadedFiles = [];

  if (/multipart\/form-data/i.test(contentType)) {
    const parsed = parseMultipartForm(rawBuffer, contentType);
    body = parsed.fields || {};
    uploadedFiles = Array.isArray(parsed.files) && parsed.files.length ? parsed.files : (parsed.file ? [parsed.file] : []);
  } else if (rawBuffer.length) {
    try {
      body = JSON.parse(rawBuffer.toString('utf8'));
    } catch {
      body = {};
    }
    uploadedFiles = Array.isArray(body.files) ? body.files : [];
  }

  const token = getPortalTokenFromRequest(req, body);
  if (!token) {
    return respond(res, 401, { success: false, error: 'Missing portal token' });
  }

  const workspace = await getWorkspaceByPortalToken(token);
  if (!workspace || workspace.status === 'inactive' || workspace.status === 'cancelled') {
    return respond(res, 404, { success: false, error: 'Workspace not found' });
  }

  const limits = portalLimitsForPlan(workspace.plan);
  const files = uploadedFiles
    .map((file, index) => ({
      ...file,
      filename: String(file?.filename || `upload-${index + 1}.csv`).trim(),
      contentType: String(file?.contentType || 'text/csv').trim() || 'text/csv',
    }))
    .filter((file) => file.filename);

  if (!files.length) {
    return respond(res, 400, { success: false, error: 'Please upload one or more CSV files.' });
  }

  const csvBuffers = files.map((file) => Buffer.from(file.content || '', 'latin1'));
  const validation = validateCsvUploads({ files, buffers: csvBuffers, limits });
  if (!validation.ok) {
    return respond(res, 400, { success: false, error: validation.error });
  }

  const monthlyReports = await countMonthlyReports(workspace.id);
  if (typeof limits.maxReportsPerMonth === 'number' && monthlyReports >= limits.maxReportsPerMonth) {
    return respond(res, 429, {
      success: false,
      error: `This workspace has reached its monthly portal report limit (${limits.maxReportsPerMonth}).`,
    });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomeo-portal-upload-'));
  const tempPaths = [];
  try {
    for (const [index, file] of files.entries()) {
      const safeName = String(file.filename || `upload-${index + 1}.csv`).replace(/[^a-zA-Z0-9._-]+/g, '-');
      const tempPath = path.join(tempDir, `${String(index + 1).padStart(2, '0')}-${safeName}`);
      fs.writeFileSync(tempPath, csvBuffers[index]);
      tempPaths.push(tempPath);
    }

    const reportResult = await runReportGenerator({ csvPaths: tempPaths });
    const parsedReport = parseReportMarkdown(reportResult.markdown);
    const detectedPlatforms = [...new Set(detectSourcePlatforms(files, csvBuffers).filter((value) => value && value !== 'unknown'))];
    const reportRunId = randomUUID();
    const totalBytes = csvBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const summary = {
      executive_summary: parsedReport.executive_summary,
      expected_impact: parsedReport.expected_impact,
      how_to_read: parsedReport.how_to_read,
      confidence_and_limitations: parsedReport.confidence_and_limitations,
      key_insights: parsedReport.key_insights,
      source_file: parsedReport.source_file,
      report_title: parsedReport.title,
    };
    const topRecommendations = parsedReport.key_decisions.slice(0, 3);

    const [reportRun] = await restInsert('report_runs', {
      id: reportRunId,
      workspace_id: workspace.id,
      status: 'completed',
      report_title: parsedReport.title,
      report_content: reportResult.markdown,
      source_count: files.length,
      source_platforms: detectedPlatforms,
      platforms: detectedPlatforms,
      source_filenames: files.map((file) => file.filename),
      row_count: validation.totalRows,
      input_bytes: totalBytes,
      summary,
      top_recommendations: topRecommendations,
      trend_snapshot: parsedReport.key_insights,
      created_at: new Date().toISOString(),
    });

    await logUsageEvent({
      workspace_id: workspace.id,
      event_type: 'portal_report_generated',
      plan: workspace.plan,
      metadata: {
        workspace_name: workspace.workspace_name,
        source_count: files.length,
        source_platforms: detectedPlatforms,
        row_count: validation.totalRows,
      },
    });

    await updatePortalTokenUse(workspace.id);

    const refreshedRuns = await restSelect('report_runs', {
      select: '*',
      workspace_id: `eq.${workspace.id}`,
      order: 'created_at.desc',
      limit: 20,
    });

    const parsedLatest = parseReportMarkdown((refreshedRuns[0] || reportRun).report_content || reportResult.markdown);
    const latestRun = {
      ...toSafeReportRun(refreshedRuns[0] || reportRun, parsedLatest),
      next_review_focus: parsedReport.next_review_focus || [],
    };
    const history = Array.isArray(refreshedRuns)
      ? refreshedRuns.map((run) => ({
          ...safeHistoryRun(run),
          summary: run.summary || {},
          top_recommendations: run.top_recommendations || [],
          trend_snapshot: run.trend_snapshot || [],
        }))
      : [];

    const publicWorkspace = safeWorkspace(workspace);
    delete publicWorkspace.owner_email;

    return respond(res, 200, {
      success: true,
      workspace: publicWorkspace,
      report_run: latestRun,
      latest_report: latestRun,
      report_history: history,
      next_review_focus: parsedReport.next_review_focus || [],
      upload_limits: {
        plan_label: limits.planLabel,
        max_files: limits.maxFiles,
        max_file_bytes: limits.maxFileBytes,
        max_total_rows: limits.maxTotalRows,
        max_reports_per_month: limits.maxReportsPerMonth,
        allowed_platforms: limits.allowedPlatforms,
      },
    });
  } catch (error) {
    console.error('[gnomeo portal run-report] request failed:', error);
    return respond(res, 500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // non-blocking cleanup
    }
  }
};
