const { parseMultipartForm } = require('./_multipart');
const { generateId, restSelect, restInsert, updateWorkspaceById } = require('./_supabase');
const { validateCsvUploads } = require('./_limits');
const {
  portalLimitsForPlan,
  getPortalTokenFromRequest,
  getWorkspaceByPortalToken,
  logUsageEvent,
  updatePortalTokenUse,
  safeWorkspace,
  safeHistoryRun,
  safePortalReview,
  parseReportMarkdown,
  buildWorkspaceMemoryUpdate,
  workspaceMemoryFromWorkspace,
  detectSourcePlatforms,
  runReportGenerator,
} = require('./_portal');

const respond = (res, statusCode, payload) => res.status(statusCode).json(payload);
const normalize = (value) => String(value || '').trim();
const readBodyBuffer = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const monthStartIso = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
};

const listReportRuns = async (workspaceId, limit = 20) => {
  const rows = await restSelect('report_runs', { select: '*', workspace_id: `eq.${workspaceId}`, order: 'created_at.desc', limit });
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

const listPortalReviews = async (workspaceId, limit = 20) => {
  try {
    const rows = await restSelect('portal_review_submissions', { select: '*', workspace_id: `eq.${workspaceId}`, order: 'created_at.desc', limit });
    return Array.isArray(rows) ? rows.map((row) => safePortalReview(row)) : [];
  } catch (error) {
    console.warn('[gnomeo portal] portal review history unavailable:', String(error?.message || error || '').slice(0, 200));
    return [];
  }
};

const toSafeReportRun = (run, parsed) => ({
  ...safeHistoryRun(run),
  report_content: run.report_content || '',
  report_markdown: run.report_markdown || run.report_content || '',
  summary: run.summary || parsed || {},
  top_recommendations: run.top_recommendations || parsed?.key_decisions || [],
  trend_snapshot: run.trend_snapshot || parsed?.key_insights || [],
});

module.exports = async (req, res) => {
  const endpoint = normalize(req.query?.endpoint || req.query?.action || '');
  const method = String(req.method || '').toUpperCase();

  if (endpoint !== 'workspace' && endpoint !== 'run-report') {
    return respond(res, 404, { success: false, error: 'Unknown portal endpoint' });
  }

  if (endpoint === 'workspace') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return respond(res, 405, { success: false, error: 'Method not allowed' });
    }

    const token = getPortalTokenFromRequest(req);
    if (!token) return respond(res, 401, { success: false, error: 'Missing portal token' });
    const workspace = await getWorkspaceByPortalToken(token);
    if (!workspace || workspace.status === 'inactive' || workspace.status === 'cancelled') {
      return respond(res, 404, { success: false, error: 'Workspace not found' });
    }

    const runs = await listReportRuns(workspace.id, 20);
    const portalReviews = await listPortalReviews(workspace.id, 20);
    const latest = runs[0] || null;
    const latestMarkdown = latest?.report_markdown || latest?.report_content || '';
    const latestParsed = latestMarkdown ? parseReportMarkdown(latestMarkdown) : null;
    const limits = portalLimitsForPlan(workspace.plan);
    const reportsThisMonth = await countMonthlyReports(workspace.id);
    const remainingReports = typeof limits.maxReportsPerMonth === 'number' ? Math.max(0, limits.maxReportsPerMonth - reportsThisMonth) : null;

    await updatePortalTokenUse(workspace.id);
    await logUsageEvent({ workspace_id: workspace.id, event_type: 'portal_viewed', plan: workspace.plan, metadata: { workspace_name: workspace.workspace_name, report_count: runs.length } });

    const latestReport = latest ? {
      ...safeHistoryRun(latest),
      report_content: latestMarkdown,
      report_markdown: latest.report_markdown || latestMarkdown,
      summary: latest.summary || latestParsed || {},
      top_recommendations: latest.top_recommendations || latestParsed?.key_decisions || [],
      trend_snapshot: latest.trend_snapshot || latestParsed?.key_insights || [],
      next_review_focus: latestParsed?.next_review_focus || [],
    } : null;

    const reportHistory = runs.map((run) => ({ ...safeHistoryRun(run), summary: run.summary || {}, top_recommendations: run.top_recommendations || [], trend_snapshot: run.trend_snapshot || [] }));
    const publicWorkspace = safeWorkspace(workspace);
    delete publicWorkspace.owner_email;

    return respond(res, 200, {
      success: true,
      workspace: publicWorkspace,
      workspace_memory: workspaceMemoryFromWorkspace(workspace),
      workspace_context: {
        workspace_name: workspace.workspace_name,
        business_type: workspace.business_type,
        primary_goal: workspace.primary_goal,
        risk_appetite: workspace.risk_appetite,
        budget_constraint: workspace.budget_constraint,
        plan: workspace.plan,
        status: workspace.status,
      },
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
      portal_reviews: portalReviews,
      top_priorities: latestParsed?.key_decisions?.slice(0, 3) || [],
      trend_snapshot: latestReport?.trend_snapshot || latestParsed?.key_insights || [],
      next_review_focus: latestParsed?.next_review_focus || [
        'Upload the latest Google Ads and Meta Ads exports',
        'Check waste concentration and weak signal areas',
        'Review whether budget allocation should change',
      ],
    });
  }

  if (method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { success: false, error: 'Method not allowed' });
  }

  const contentType = String(req.headers['content-type'] || '');
  const rawBuffer = await readBodyBuffer(req);
  let body = {};
  let uploadedFiles = [];

  if (/multipart\/form-data/i.test(contentType)) {
    const parsed = parseMultipartForm(rawBuffer, contentType);
    body = parsed.fields || {};
    uploadedFiles = Array.isArray(parsed.files) && parsed.files.length ? parsed.files : (parsed.file ? [parsed.file] : []);
  } else if (rawBuffer.length) {
    try { body = JSON.parse(rawBuffer.toString('utf8')); } catch { body = {}; }
    uploadedFiles = Array.isArray(body.files) ? body.files : [];
  }

  const token = getPortalTokenFromRequest(req, body);
  if (!token) return respond(res, 401, { success: false, error: 'Missing portal token' });
  const workspace = await getWorkspaceByPortalToken(token);
  if (!workspace || workspace.status === 'inactive' || workspace.status === 'cancelled') {
    return respond(res, 404, { success: false, error: 'Workspace not found' });
  }

  const limits = portalLimitsForPlan(workspace.plan);
  const files = uploadedFiles.map((file, index) => ({ ...file, filename: String(file?.filename || `upload-${index + 1}.csv`).trim(), contentType: String(file?.contentType || 'text/csv').trim() || 'text/csv' })).filter((file) => file.filename);
  if (!files.length) return respond(res, 400, { success: false, error: 'Please upload one or more CSV files.' });

  const csvBuffers = files.map((file) => Buffer.from(file.content || '', 'latin1'));
  const validation = validateCsvUploads({ files, buffers: csvBuffers, limits });
  if (!validation.ok) return respond(res, 400, { success: false, error: validation.error });

  const monthlyReports = await countMonthlyReports(workspace.id);
  if (typeof limits.maxReportsPerMonth === 'number' && monthlyReports >= limits.maxReportsPerMonth) {
    return respond(res, 429, { success: false, error: `This workspace has reached its monthly portal report limit (${limits.maxReportsPerMonth}).` });
  }

  const portalFiles = files.map((file, index) => ({
    filename: String(file?.filename || `upload-${index + 1}.csv`),
    contentType: String(file?.contentType || 'text/csv'),
    text: Buffer.isBuffer(csvBuffers[index]) ? csvBuffers[index].toString('utf8') : String(csvBuffers[index] || ''),
  }));
  const detectedPlatforms = [...new Set(detectSourcePlatforms(files, csvBuffers).filter((value) => value && value !== 'unknown'))];
  const portalReviewId = generateId();
  let createdReview = null;
  try {
    const [row] = await restInsert('portal_review_submissions', {
      id: portalReviewId,
      workspace_id: workspace.id,
      status: 'received',
      filenames: files.map((file) => file.filename),
      platforms: detectedPlatforms,
      file_count: files.length,
      notes: 'Review received from portal upload.',
      created_at: new Date().toISOString(),
    });
    createdReview = row || null;
  } catch (error) {
    console.warn('[gnomeo portal] portal review queue insert failed (non-blocking):', String(error?.message || error || '').slice(0, 200));
  }

  const latestExistingRun = (await listReportRuns(workspace.id, 20))[0] || null;

  try {
    const reportResult = await runReportGenerator({ files: portalFiles });
    const parsedReport = {
      title: reportResult.title || 'Gnomeo Review',
      ...(reportResult.summary || {}),
    };
    const reportRunId = generateId();
    const totalBytes = csvBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const summary = {
      ...parsedReport,
      metrics: reportResult.metrics || parsedReport.metrics || {},
      report_title: parsedReport.title,
    };

    const [reportRun] = await restInsert('report_runs', {
      id: reportRunId,
      workspace_id: workspace.id,
      status: 'completed',
      report_title: parsedReport.title,
      report_markdown: reportResult.markdown,
      report_content: reportResult.markdown,
      source_count: files.length,
      source_platforms: detectedPlatforms.length ? detectedPlatforms : reportResult.source_platforms || [],
      platforms: detectedPlatforms.length ? detectedPlatforms : reportResult.source_platforms || [],
      source_filenames: files.map((file) => file.filename),
      sources: files.map((file, index) => ({
        filename: file.filename,
        content_type: file.contentType,
        platform: detectedPlatforms[index] || reportResult.source_platforms?.[index] || null,
      })),
      row_count: reportResult.row_count || validation.totalRows,
      input_bytes: reportResult.input_bytes || totalBytes,
      summary,
      top_priorities: parsedReport.key_decisions || [],
      top_recommendations: parsedReport.key_decisions || [],
      recommendations: parsedReport.key_decisions || [],
      trend_snapshot: parsedReport.key_insights || [],
      trend_notes: parsedReport.key_insights?.join(' · ') || '',
      completed_at: new Date().toISOString(),
      error_message: null,
      metadata: {
        source_count: files.length,
        row_count: reportResult.row_count || validation.totalRows,
        input_bytes: reportResult.input_bytes || totalBytes,
        generated_by: 'portal',
      },
      created_at: new Date().toISOString(),
    });

    const memoryUpdate = buildWorkspaceMemoryUpdate({
      workspace,
      parsedReport,
      detectedPlatforms: detectedPlatforms.length ? detectedPlatforms : reportResult.source_platforms || [],
      sourceFilenames: files.map((file) => file.filename),
      reportRun: { created_at: reportRun.created_at, report_title: parsedReport.title, row_count: reportResult.row_count || validation.totalRows },
      currentMemory: workspace,
    });
    let updatedWorkspace = workspace;
    try {
      const [savedWorkspace] = await updateWorkspaceById(workspace.id, memoryUpdate);
      if (savedWorkspace) updatedWorkspace = savedWorkspace;
    } catch (memoryError) {
      console.warn('[gnomeo portal] workspace memory update failed (non-blocking):', String(memoryError?.message || memoryError || '').slice(0, 200));
    }

    if (createdReview) {
      try {
        const [updatedReview] = await restUpdate('portal_review_submissions', { id: `eq.${createdReview.id}` }, {
          status: 'completed',
          report_run_id: reportRunId,
          completed_at: new Date().toISOString(),
          notes: 'Report generated in the portal.',
        });
        createdReview = updatedReview || createdReview;
      } catch (error) {
        console.warn('[gnomeo portal] portal review completion update failed (non-blocking):', String(error?.message || error || '').slice(0, 200));
      }
    }

    await logUsageEvent({ workspace_id: workspace.id, event_type: 'portal_report_generated', plan: workspace.plan, metadata: { workspace_name: workspace.workspace_name, source_count: files.length, source_platforms: detectedPlatforms.length ? detectedPlatforms : reportResult.source_platforms || [], row_count: reportResult.row_count || validation.totalRows } });
    await updatePortalTokenUse(workspace.id);

    const refreshedRuns = await listReportRuns(workspace.id, 20);
    const history = Array.isArray(refreshedRuns) ? refreshedRuns.map((run) => ({ ...safeHistoryRun(run), summary: run.summary || {}, top_recommendations: run.top_recommendations || [], trend_snapshot: run.trend_snapshot || [] })) : [];
    const latestRun = { ...toSafeReportRun(refreshedRuns[0] || reportRun, parsedReport), next_review_focus: parsedReport.next_review_focus || [] };
    const portalReviews = await listPortalReviews(workspace.id, 20);
    const publicWorkspace = safeWorkspace(updatedWorkspace);
    delete publicWorkspace.owner_email;

    return respond(res, 200, {
      success: true,
      status: 'generated',
      workspace: publicWorkspace,
      report_run: latestRun,
      latest_report: latestRun,
      report_history: history,
      portal_reviews: portalReviews,
      next_review_focus: parsedReport.next_review_focus || [],
      workspace_memory: workspaceMemoryFromWorkspace(updatedWorkspace),
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
    console.warn('[gnomeo portal] report generation failed; queued for manual processing:', String(error?.message || error || '').slice(0, 200));
    if (createdReview) {
      try {
        await restUpdate('portal_review_submissions', { id: `eq.${createdReview.id}` }, {
          notes: 'We could not finish the review immediately, so it has been queued for processing.',
        });
      } catch (queueError) {
        console.warn('[gnomeo portal] portal review queue update failed (non-blocking):', String(queueError?.message || queueError || '').slice(0, 200));
      }
    }
    await updatePortalTokenUse(workspace.id).catch(() => {});
    const portalReviews = await listPortalReviews(workspace.id, 20);
    const existingRuns = await listReportRuns(workspace.id, 20);
    const existingHistory = Array.isArray(existingRuns) ? existingRuns.map((run) => ({ ...safeHistoryRun(run), summary: run.summary || {}, top_recommendations: run.top_recommendations || [], trend_snapshot: run.trend_snapshot || [] })) : [];
    const existingLatest = latestExistingRun ? toSafeReportRun(latestExistingRun, parseReportMarkdown(latestExistingRun.report_markdown || latestExistingRun.report_content || '')) : null;
    const publicWorkspace = safeWorkspace(workspace);
    delete publicWorkspace.owner_email;
    return respond(res, 200, {
      success: true,
      queued: true,
      status: 'queued',
      message: 'We could not finish the review immediately, so it has been queued for processing.',
      workspace: publicWorkspace,
      report_run: existingLatest,
      latest_report: existingLatest,
      report_history: existingHistory,
      portal_reviews: portalReviews,
      queued_review: portalReviews[0] || null,
      workspace_memory: workspaceMemoryFromWorkspace(workspace),
      upload_limits: {
        plan_label: limits.planLabel,
        max_files: limits.maxFiles,
        max_file_bytes: limits.maxFileBytes,
        max_total_rows: limits.maxTotalRows,
        max_reports_per_month: limits.maxReportsPerMonth,
        allowed_platforms: limits.allowedPlatforms,
      },
    });
  }
};
