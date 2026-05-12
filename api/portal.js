const { parseMultipartForm } = require('./_multipart');
const { generateId, restSelect, restInsert, restUpdate, updateWorkspaceById } = require('./_supabase');
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
  buildComparisonSummary,
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
  const rows = await restSelect('report_runs', { select: '*', workspace_id: `eq.${workspaceId}`, deleted_at: 'is.null', order: 'created_at.desc', limit });
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
    const rows = await restSelect('portal_review_submissions', { select: '*', workspace_id: `eq.${workspaceId}`, deleted_at: 'is.null', order: 'created_at.desc', limit });
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

const toPublicWorkspace = (workspace) => {
  const publicWorkspace = safeWorkspace(workspace);
  delete publicWorkspace.owner_email;
  return publicWorkspace;
};

const buildVisiblePortalState = async (workspace) => {
  const runs = await listReportRuns(workspace.id, 20);
  const portalReviews = await listPortalReviews(workspace.id, 20);
  const latest = runs[0] || null;
  const latestMarkdown = latest?.report_markdown || latest?.report_content || '';
  const latestParsed = latestMarkdown ? parseReportMarkdown(latestMarkdown) : null;
  const latestReport = latest ? {
    ...safeHistoryRun(latest),
    comparison_summary: latest.comparison_summary || {},
    report_content: latestMarkdown,
    report_markdown: latest.report_markdown || latestMarkdown,
    summary: latest.summary || latestParsed || {},
    top_recommendations: latest.top_recommendations || latestParsed?.key_decisions || [],
    trend_snapshot: latest.trend_snapshot || latestParsed?.key_insights || [],
    next_review_focus: latestParsed?.next_review_focus || [],
  } : null;
  const reportHistory = runs.map((run) => ({ ...safeHistoryRun(run), summary: run.summary || {}, top_recommendations: run.top_recommendations || [], trend_snapshot: run.trend_snapshot || [], comparison_summary: run.comparison_summary || {} }));
  return {
    publicWorkspace: toPublicWorkspace(workspace),
    workspace_memory: workspaceMemoryFromWorkspace(workspace),
    latestReport,
    reportHistory,
    portalReviews,
    latestParsed,
  };
};

const emptyWorkspaceComparison = () => ({
  memory_summary: {},
  recurring_issues: [],
  open_recommendations: [],
  trend_snapshot: [],
  next_review_focus: [],
  last_handover_at: null,
  changed_since_last_review: [],
  still_unresolved: [],
  likely_actioned_or_improved: [],
  new_this_time: [],
  top_actions_now: [],
  previous_recommendations_status: [],
  comparison_note: null,
});

const safeSupabaseError = (error) => ({
  code: String(error?.code || error?.status || '').trim() || null,
  message: String(error?.message || error || '').trim().slice(0, 200) || null,
  details: String(error?.details || '').trim().slice(0, 200) || null,
  hint: String(error?.hint || '').trim().slice(0, 200) || null,
});

const logRemoveReviewError = ({ detail, error, workspaceId, reportRunId }) => {
  const supabase = safeSupabaseError(error);
  console.error('[gnomeo portal] remove-review failed', {
    operation: 'portal.remove_review',
    detail,
    report_run_id: reportRunId || null,
    workspace_id: workspaceId || null,
    supabase,
  });
  return supabase;
};

const removeReviewFailure = ({ res, detail, error, workspaceId, reportRunId }) => {
  const supabase = logRemoveReviewError({ detail, error, workspaceId, reportRunId });
  return respond(res, 500, {
    success: false,
    error: 'We could not remove this review right now. Please try again or contact support.',
    code: 'remove_review_failed',
    operation: 'portal.remove_review',
    detail,
    supabase,
  });
};

const formatComparisonItem = (item) => {
  if (!item) return '';
  if (typeof item === 'string') return String(item).trim();
  if (typeof item === 'object') {
    return [item.title || item.label || item.name, item.details || item.notes]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .join(' — ');
  }
  return String(item).trim();
};

const buildComparisonMarkdown = (comparison = {}) => {
  const baseline = Boolean(comparison.is_baseline);
  const changed = Array.isArray(comparison.changed_since_last_review) ? comparison.changed_since_last_review : [];
  const unresolved = Array.isArray(comparison.still_unresolved) ? comparison.still_unresolved : [];
  const improved = Array.isArray(comparison.likely_actioned_or_improved) ? comparison.likely_actioned_or_improved : [];
  const fresh = Array.isArray(comparison.new_this_time) ? comparison.new_this_time : [];
  const previousStatus = Array.isArray(comparison.previous_recommendations_status) ? comparison.previous_recommendations_status : [];
  const topActions = Array.isArray(comparison.top_actions_now) ? comparison.top_actions_now : [];
  const lines = [];
  lines.push('## What changed since the last review');
  if (baseline) {
    lines.push('This is the baseline review. Future reviews will compare against this export.');
  } else if (changed.length) {
    changed.forEach((item) => lines.push(`- ${formatComparisonItem(item)}`));
  } else {
    lines.push('The export can be compared to the previous review, but the movement is limited by the available fields.');
  }
  lines.push('');
  lines.push('## Previous recommendations status');
  if (!previousStatus.length) {
    lines.push('No previous recommendations are available yet, so this review starts the comparison baseline.');
  } else {
    previousStatus.forEach((item) => {
      lines.push(`- ${formatComparisonItem(item)}${item.status ? ` (${item.status})` : ''}`);
    });
  }
  lines.push('');
  lines.push('## What to change now');
  if (topActions.length) {
    topActions.slice(0, 3).forEach((item, index) => {
      const text = formatComparisonItem(item);
      if (text) lines.push(`${index + 1}. ${text}`);
    });
  } else {
    lines.push('1. Read the latest review before changing budgets.');
  }
  lines.push('');
  lines.push('## Still needs attention');
  if (unresolved.length) {
    unresolved.forEach((item) => lines.push(`- ${formatComparisonItem(item)}`));
  } else {
    lines.push('No unresolved items were carried forward with enough evidence to keep them open.');
  }
  lines.push('');
  lines.push('## New this time');
  if (fresh.length) {
    fresh.forEach((item) => lines.push(`- ${formatComparisonItem(item)}`));
  } else if (improved.length) {
    lines.push('No clearly new items stood out beyond the improved or resolved areas.');
  } else {
    lines.push('No clearly new items were visible in the top results.');
  }
  return lines.join('\n');
};

module.exports = async (req, res) => {
  const endpoint = normalize(req.query?.endpoint || req.query?.action || '');
  const method = String(req.method || '').toUpperCase();

  if (endpoint !== 'workspace' && endpoint !== 'run-report' && endpoint !== 'remove-review') {
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

    const reportsThisMonth = await countMonthlyReports(workspace.id);
    const limits = portalLimitsForPlan(workspace.plan);
    const remainingReports = typeof limits.maxReportsPerMonth === 'number' ? Math.max(0, limits.maxReportsPerMonth - reportsThisMonth) : null;
    const state = await buildVisiblePortalState(workspace);

    await updatePortalTokenUse(workspace.id);
    await logUsageEvent({ workspace_id: workspace.id, event_type: 'portal_viewed', plan: workspace.plan, metadata: { workspace_name: workspace.workspace_name, report_count: state.reportHistory.length } });

    return respond(res, 200, {
      success: true,
      workspace: state.publicWorkspace,
      workspace_memory: state.workspace_memory,
      changed_since_last_review: workspace.changed_since_last_review || [],
      still_unresolved: workspace.still_unresolved || [],
      likely_actioned_or_improved: workspace.likely_actioned_or_improved || [],
      new_this_time: workspace.new_this_time || [],
      top_actions_now: workspace.top_actions_now || [],
      previous_recommendations_status: workspace.previous_recommendations_status || [],
      comparison_note: workspace.comparison_note || null,
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
      latest_report: state.latestReport,
      report_history: state.reportHistory,
      portal_reviews: state.portalReviews,
      top_priorities: state.latestParsed?.key_decisions?.slice(0, 3) || [],
      trend_snapshot: state.latestReport?.trend_snapshot || state.latestParsed?.key_insights || [],
      next_review_focus: state.latestParsed?.next_review_focus || [
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
  if (!token) {
    if (endpoint === 'remove-review') {
      return respond(res, 401, {
        success: false,
        error: 'We could not remove this review right now. Please try again or contact support.',
        code: 'remove_review_failed',
        operation: 'portal.remove_review',
        detail: 'token_invalid',
        supabase: null,
      });
    }
    return respond(res, 401, { success: false, error: 'Missing portal token' });
  }
  const workspace = await getWorkspaceByPortalToken(token);
  if (!workspace || workspace.status === 'inactive' || workspace.status === 'cancelled') {
    if (endpoint === 'remove-review') {
      return respond(res, 401, {
        success: false,
        error: 'We could not remove this review right now. Please try again or contact support.',
        code: 'remove_review_failed',
        operation: 'portal.remove_review',
        detail: 'token_invalid',
        supabase: null,
      });
    }
    return respond(res, 404, { success: false, error: 'Workspace not found' });
  }

  if (endpoint === 'remove-review') {
    const reportRunId = normalize(body.report_run_id || body.reportRunId || req.query?.report_run_id || req.query?.reportRunId || '');
    if (!reportRunId) {
      return respond(res, 400, {
        success: false,
        error: 'We could not remove this review right now. Please try again or contact support.',
        code: 'remove_review_failed',
        operation: 'portal.remove_review',
        detail: 'missing_report_id',
        supabase: null,
      });
    }

    let targetRun = null;
    try {
      const targetRows = await restSelect('report_runs', {
        select: 'id,workspace_id,deleted_at,created_at',
        id: `eq.${reportRunId}`,
        workspace_id: `eq.${workspace.id}`,
        deleted_at: 'is.null',
        limit: 1,
      });
      targetRun = Array.isArray(targetRows) ? targetRows[0] || null : null;
    } catch (error) {
      return removeReviewFailure({ res, detail: 'report_not_found', error, workspaceId: workspace.id, reportRunId });
    }

    if (!targetRun) {
      return respond(res, 404, {
        success: false,
        error: 'We could not remove this review right now. Please try again or contact support.',
        code: 'remove_review_failed',
        operation: 'portal.remove_review',
        detail: 'report_not_found',
        supabase: null,
      });
    }

    if (String(targetRun.workspace_id || '') !== String(workspace.id || '')) {
      return respond(res, 403, {
        success: false,
        error: 'We could not remove this review right now. Please try again or contact support.',
        code: 'remove_review_failed',
        operation: 'portal.remove_review',
        detail: 'workspace_mismatch',
        supabase: null,
      });
    }

    const deletedAt = new Date().toISOString();
    try {
      await restUpdate('report_runs', { id: `eq.${reportRunId}`, workspace_id: `eq.${workspace.id}` }, { deleted_at: deletedAt });
    } catch (error) {
      return removeReviewFailure({ res, detail: 'report_update_failed', error, workspaceId: workspace.id, reportRunId });
    }

    let submissionUpdateError = null;
    try {
      await restUpdate('portal_review_submissions', { workspace_id: `eq.${workspace.id}`, report_run_id: `eq.${reportRunId}` }, { deleted_at: deletedAt });
    } catch (error) {
      submissionUpdateError = error;
      logRemoveReviewError({ detail: 'submission_update_failed', error, workspaceId: workspace.id, reportRunId });
    }

    let updatedWorkspace = workspace;
    let refreshDetail = null;
    try {
      const refreshedRuns = await listReportRuns(workspace.id, 20);
      const refreshedLatest = refreshedRuns[0] || null;
      if (refreshedLatest) {
        const refreshedMarkdown = refreshedLatest.report_markdown || refreshedLatest.report_content || '';
        const refreshedParsed = refreshedMarkdown ? parseReportMarkdown(refreshedMarkdown) : null;
        const refreshedComparison = refreshedLatest.comparison_summary || {};
        const [savedWorkspace] = await updateWorkspaceById(workspace.id, {
          ...buildWorkspaceMemoryUpdate({
            workspace,
            parsedReport: refreshedParsed || {},
            detectedPlatforms: refreshedLatest.source_platforms || refreshedLatest.platforms || [],
            sourceFilenames: refreshedLatest.source_filenames || [],
            reportRun: refreshedLatest,
            currentMemory: workspace,
          }),
          changed_since_last_review: refreshedComparison.changed_since_last_review || [],
          still_unresolved: refreshedComparison.still_unresolved || [],
          likely_actioned_or_improved: refreshedComparison.likely_actioned_or_improved || [],
          new_this_time: refreshedComparison.new_this_time || [],
          top_actions_now: refreshedComparison.top_actions_now || [],
          previous_recommendations_status: refreshedComparison.previous_recommendations_status || [],
          comparison_note: refreshedComparison.comparison_note || null,
        });
        if (savedWorkspace) updatedWorkspace = savedWorkspace;
      } else {
        const [savedWorkspace] = await updateWorkspaceById(workspace.id, emptyWorkspaceComparison());
        if (savedWorkspace) updatedWorkspace = savedWorkspace;
      }
    } catch (error) {
      refreshDetail = 'workspace_refresh_failed';
      logRemoveReviewError({ detail: 'workspace_refresh_failed', error, workspaceId: workspace.id, reportRunId });
    }

    const refreshedState = await buildVisiblePortalState(updatedWorkspace).catch((error) => {
      refreshDetail = refreshDetail || 'workspace_refresh_failed';
      logRemoveReviewError({ detail: 'workspace_refresh_failed', error, workspaceId: workspace.id, reportRunId });
      return {
        publicWorkspace: safeWorkspace(updatedWorkspace),
        workspace_memory: workspaceMemoryFromWorkspace(updatedWorkspace),
        latestReport: null,
        reportHistory: [],
        portalReviews: [],
        latestParsed: null,
      };
    });
    const removalLimits = portalLimitsForPlan(updatedWorkspace.plan);
    const reportsThisMonth = await countMonthlyReports(updatedWorkspace.id);
    const remainingReports = typeof removalLimits.maxReportsPerMonth === 'number' ? Math.max(0, removalLimits.maxReportsPerMonth - reportsThisMonth) : null;

    await updatePortalTokenUse(updatedWorkspace.id).catch(() => {});
    await logUsageEvent({
      workspace_id: updatedWorkspace.id,
      event_type: 'portal_review_removed',
      plan: updatedWorkspace.plan,
      metadata: {
        workspace_name: updatedWorkspace.workspace_name,
        report_run_id: reportRunId,
      },
    });

    return respond(res, 200, {
      success: true,
      message: 'Review removed. Your workspace has been updated.',
      workspace: refreshedState.publicWorkspace,
      workspace_memory: refreshedState.workspace_memory,
      latest_report: refreshedState.latestReport,
      report_history: refreshedState.reportHistory,
      portal_reviews: refreshedState.portalReviews,
      top_priorities: refreshedState.latestParsed?.key_decisions?.slice(0, 3) || [],
      changed_since_last_review: refreshedState.publicWorkspace.changed_since_last_review || [],
      still_unresolved: refreshedState.publicWorkspace.still_unresolved || [],
      likely_actioned_or_improved: refreshedState.publicWorkspace.likely_actioned_or_improved || [],
      new_this_time: refreshedState.publicWorkspace.new_this_time || [],
      top_actions_now: refreshedState.publicWorkspace.top_actions_now || [],
      previous_recommendations_status: refreshedState.publicWorkspace.previous_recommendations_status || [],
      comparison_note: refreshedState.publicWorkspace.comparison_note || null,
      detail: refreshDetail || (submissionUpdateError ? 'submission_update_failed' : null),
      upload_limits: {
        plan_label: removalLimits.planLabel,
        max_files: removalLimits.maxFiles,
        max_file_bytes: removalLimits.maxFileBytes,
        max_total_rows: removalLimits.maxTotalRows,
        max_reports_per_month: removalLimits.maxReportsPerMonth,
        remaining_reports_this_month: remainingReports,
        allowed_platforms: removalLimits.allowedPlatforms,
      },
    });
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
  const latestExistingParsed = latestExistingRun ? parseReportMarkdown(latestExistingRun.report_markdown || latestExistingRun.report_content || '') : null;

  try {
    const reportResult = await runReportGenerator({ files: portalFiles });
    const parsedReport = {
      title: reportResult.title || 'Gnomeo Review',
      ...(reportResult.summary || {}),
    };
    const comparisonSummary = buildComparisonSummary({
      current: reportResult,
      previous: latestExistingRun,
      currentSummary: parsedReport,
      currentTopSegments: Array.isArray(reportResult.top_segments) ? reportResult.top_segments : [],
      currentPlatformSummaries: Array.isArray(reportResult.platform_summaries) ? reportResult.platform_summaries : [],
    });
    const reportRunId = generateId();
    const totalBytes = csvBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const summary = {
      ...parsedReport,
      metrics: reportResult.metrics || parsedReport.metrics || {},
      report_title: parsedReport.title,
    };
    const comparisonMarkdown = buildComparisonMarkdown(comparisonSummary);
    const reportMarkdown = [reportResult.markdown, '', comparisonMarkdown].join('\n');

    const [reportRun] = await restInsert('report_runs', {
      id: reportRunId,
      workspace_id: workspace.id,
      status: 'completed',
      report_title: parsedReport.title,
      report_markdown: reportMarkdown,
      report_content: reportMarkdown,
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
      comparison_summary: comparisonSummary,
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
      comparison: comparisonSummary,
    });
    let updatedWorkspace = workspace;
    try {
      const [savedWorkspace] = await updateWorkspaceById(workspace.id, {
        ...memoryUpdate,
        changed_since_last_review: comparisonSummary.changed_since_last_review || [],
        still_unresolved: comparisonSummary.still_unresolved || [],
        likely_actioned_or_improved: comparisonSummary.likely_actioned_or_improved || [],
        new_this_time: comparisonSummary.new_this_time || [],
        top_actions_now: comparisonSummary.top_actions_now || [],
        previous_recommendations_status: comparisonSummary.previous_recommendations_status || [],
        comparison_note: comparisonSummary.comparison_note || null,
      });
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
    const history = Array.isArray(refreshedRuns) ? refreshedRuns.map((run) => ({ ...safeHistoryRun(run), summary: run.summary || {}, top_recommendations: run.top_recommendations || [], trend_snapshot: run.trend_snapshot || [], comparison_summary: run.comparison_summary || {} })) : [];
    const latestRun = { ...toSafeReportRun(refreshedRuns[0] || reportRun, parsedReport), next_review_focus: parsedReport.next_review_focus || [], comparison_summary: comparisonSummary };
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
      changed_since_last_review: comparisonSummary.changed_since_last_review || [],
      still_unresolved: comparisonSummary.still_unresolved || [],
      likely_actioned_or_improved: comparisonSummary.likely_actioned_or_improved || [],
      new_this_time: comparisonSummary.new_this_time || [],
      top_actions_now: comparisonSummary.top_actions_now || [],
      previous_recommendations_status: comparisonSummary.previous_recommendations_status || [],
      comparison_note: comparisonSummary.comparison_note || null,
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
    const existingHistory = Array.isArray(existingRuns) ? existingRuns.map((run) => ({ ...safeHistoryRun(run), summary: run.summary || {}, top_recommendations: run.top_recommendations || [], trend_snapshot: run.trend_snapshot || [], comparison_summary: run.comparison_summary || {} })) : [];
    const existingLatest = latestExistingRun ? toSafeReportRun(latestExistingRun, latestExistingParsed || parseReportMarkdown(latestExistingRun.report_markdown || latestExistingRun.report_content || '')) : null;
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
      changed_since_last_review: workspace.changed_since_last_review || [],
      still_unresolved: workspace.still_unresolved || [],
      likely_actioned_or_improved: workspace.likely_actioned_or_improved || [],
      new_this_time: workspace.new_this_time || [],
      top_actions_now: workspace.top_actions_now || [],
      previous_recommendations_status: workspace.previous_recommendations_status || [],
      comparison_note: workspace.comparison_note || null,
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
