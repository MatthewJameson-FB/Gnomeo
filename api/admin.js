const fs = require('fs');
const path = require('path');
const { parseMultipartForm } = require('./_multipart');
const { generateId, restSelect, restSingle, restInsert, restUpdate, storageUpload, storageDownload, storageDelete, ensureConfig } = require('./_supabase');
const { requireAdmin, buildAdminSessionCookie, createAdminSessionToken, clearAdminSessionCookie, SESSION_TTL_SECONDS } = require('./_adminAuth');
const { generatePortalToken, hashPortalToken, buildPortalUrl, safeWorkspace, safeHistoryRun, safeLatestRun, safePortalReview } = require('./_portal');

const ADMIN_ROOT = path.join(process.cwd(), 'admin');
const CSV_BUCKET = 'submissions';
const REPORTS_BUCKET = 'reports';
const ALLOWED_BETA_STATUSES = new Set(['new', 'contacted', 'workspace_created', 'declined']);
const ALLOWED_WORKSPACE_STATUSES = new Set(['active', 'inactive', 'cancelled', 'pending']);
const ALLOWED_WORKSPACE_PLANS = new Set(['manual_beta', 'pro', 'agency', 'free']);
const SCHEMA_EXPECTATIONS = {
  profiles: ['id', 'email', 'created_at'],
  workspaces: [
    'id',
    'profile_id',
    'owner_email',
    'workspace_name',
    'business_type',
    'primary_goal',
    'risk_appetite',
    'budget_constraint',
    'notes',
    'plan',
    'status',
    'created_at',
    'updated_at',
    'portal_token_hash',
    'portal_token_created_at',
    'portal_token_last_used_at',
    'portal_token_revoked_at',
    'memory_summary',
    'recurring_issues',
    'open_recommendations',
    'trend_snapshot',
    'next_review_focus',
    'last_handover_at',
    'changed_since_last_review',
    'still_unresolved',
    'likely_actioned_or_improved',
    'new_this_time',
    'top_actions_now',
    'previous_recommendations_status',
    'comparison_note',
    'beta_request_id',
    'website',
    'platforms',
    'review_goal',
    'is_agency',
  ],
  report_runs: [
    'id',
    'workspace_id',
    'status',
    'source_count',
    'platforms',
    'spend_analysed',
    'revenue_analysed',
    'roas',
    'wasted_spend',
    'report_url',
    'report_html_path',
    'report_title',
    'report_content',
    'report_markdown',
    'source_platforms',
    'source_filenames',
    'row_count',
    'input_bytes',
    'summary',
    'top_recommendations',
    'trend_snapshot',
    'sources',
    'top_priorities',
    'recommendations',
    'trend_notes',
    'completed_at',
    'error_message',
    'metadata',
    'comparison_summary',
    'created_at',
  ],
  usage_events: ['id', 'workspace_id', 'event_type', 'plan', 'metadata', 'created_at'],
  beta_requests: ['id', 'created_at', 'name', 'email', 'company', 'website', 'platforms', 'monthly_spend_range', 'is_agency', 'review_goal', 'notes', 'status', 'source', 'consent_at', 'workspace_id', 'workspace_created_at', 'portal_link_created_at'],
  portal_review_submissions: ['id', 'created_at', 'workspace_id', 'status', 'filenames', 'platforms', 'file_count', 'report_run_id', 'completed_at', 'notes'],
};

const getHeader = (req, name) => {
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
};

const normalize = (value) => String(value || '').trim();
const readBodyBuffer = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const parseJsonBody = async (req, rawBuffer) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (!rawBuffer.length) return {};
  try { return JSON.parse(rawBuffer.toString('utf8')); } catch { return null; }
};
const respond = (res, statusCode, payload) => res.status(statusCode).json(payload);
const respondError = (res, statusCode, error) => res.status(statusCode).json({ success: false, error });

const safeName = (value) => String(value || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-');
const loadTemplate = () => {
  const templatePath = path.join(process.cwd(), 'agent_mvp', 'report_email_template.txt');
  const fallback = [
    'Subject: Your Gnomeo analysis',
    '',
    'Hey — I’ve run your data through Gnomeo.',
    '',
    'Attached is your report.',
  ].join('\n');
  const text = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : fallback;
  const lines = text.split(/\r?\n/);
  const hasSubject = lines[0]?.toLowerCase().startsWith('subject:');
  return {
    subject: hasSubject ? (lines[0].split(':').slice(1).join(':').trim() || 'Your Gnomeo analysis') : 'Your Gnomeo analysis',
    body: (hasSubject ? lines.slice(1).join('\n') : text).trim(),
  };
};
const buildEmailHtml = (body) => `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">${String(body || '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => `<p>${block.replace(/\n/g, '<br />')}</p>`).join('')}</div>`;
const resendSend = async ({ to, subject, body, attachments = [] }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is missing');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Gnomeo <reports@gnomeo.nl>', reply_to: 'matt@gnomeo.nl', to: Array.isArray(to) ? to : [to], subject, html: buildEmailHtml(body), text: body, attachments }),
  });
  if (!response.ok) throw new Error(await response.text());
};

const safeSupabaseError = (error) => ({
  code: error?.code || null,
  message: String(error?.message || error || 'Unknown error'),
  details: error?.details || null,
  hint: error?.hint || null,
});

const mapSchemaError = (error) => {
  const message = String(error?.message || error || 'Unknown error');
  if (/SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/i.test(message)) return 'Supabase env vars are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';
  if (/relation .* does not exist|schema cache/i.test(message)) return 'Supabase tables are missing. Apply the migration files.';
  if (/bucket.*not found|storage/i.test(message) && /not found/i.test(message)) return 'Supabase storage buckets are missing. Create the private submissions and reports buckets.';
  return message;
};

const schemaProbe = async (table, column) => {
  try {
    await restSelect(table, { select: column, limit: 1 });
    return true;
  } catch {
    return false;
  }
};

const checkSchemaHealth = async () => {
  const env = {
    supabase_url: Boolean(String(process.env.SUPABASE_URL || '').trim()),
    service_role: Boolean(String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()),
    admin_secret: Boolean(String(process.env.ADMIN_SECRET || '').trim()),
    resend_api_key: Boolean(String(process.env.RESEND_API_KEY || '').trim()),
    admin_email: Boolean(String(process.env.ADMIN_EMAIL || '').trim()),
  };

  const missing = [];
  if (!env.supabase_url || !env.service_role) {
    return { ok: false, missing, env, schema_checks_skipped: true };
  }

  for (const [table, columns] of Object.entries(SCHEMA_EXPECTATIONS)) {
    const tableExists = await schemaProbe(table, 'id');
    if (!tableExists) {
      missing.push({ table, column: null, kind: 'table' });
      continue;
    }
    for (const column of columns) {
      const exists = await schemaProbe(table, column);
      if (!exists) missing.push({ table, column, kind: 'column' });
    }
  }

  return { ok: missing.length === 0, missing, env };
};

const listCRM = async () => {
  const [customers, submissions, reports, emailEvents] = await Promise.all([
    restSelect('customers', { select: '*', order: 'created_at.desc' }),
    restSelect('submissions', { select: '*', order: 'created_at.desc' }),
    restSelect('reports', { select: '*', order: 'created_at.desc' }),
    restSelect('email_events', { select: '*', order: 'sent_at.desc' }),
  ]);
  return (Array.isArray(submissions) ? submissions : []).map((submission) => {
    const customer = (Array.isArray(customers) ? customers : []).find((item) => item.id === submission.customer_id) || null;
    const submissionReports = (Array.isArray(reports) ? reports : []).filter((item) => item.submission_id === submission.id);
    const latestReport = submissionReports[0] || null;
    return {
      submission,
      customer,
      reports: submissionReports,
      email_events: (Array.isArray(emailEvents) ? emailEvents : []).filter((item) => item.submission_id === submission.id),
      id: submission.id,
      original_filename: submission.original_filename,
      notes: submission.notes,
      status: submission.status,
      created_at: submission.created_at,
      customer_email: customer?.email || '',
      customer_company: customer?.company || '',
      customer_status: customer?.status || 'lead',
      submission_status: submission.status,
      report_file_url: latestReport?.report_file_url || '',
      report_id: latestReport?.id || '',
    };
  });
};

const detailCRM = async (id) => {
  const [submission, customers, reports, emailEvents] = await Promise.all([
    restSingle('submissions', { select: '*', id: `eq.${id}`, limit: 1 }),
    restSelect('customers', { select: '*' }),
    restSelect('reports', { select: '*', order: 'created_at.desc' }),
    restSelect('email_events', { select: '*', order: 'sent_at.desc' }),
  ]);
  if (!submission) return null;
  const customer = (Array.isArray(customers) ? customers : []).find((item) => item.id === submission.customer_id) || null;
  const submissionReports = (Array.isArray(reports) ? reports : []).filter((item) => item.submission_id === submission.id);
  return {
    submission,
    customer,
    reports: submissionReports,
    email_events: (Array.isArray(emailEvents) ? emailEvents : []).filter((item) => item.submission_id === submission.id),
    id: submission.id,
    original_filename: submission.original_filename,
    notes: submission.notes,
    status: submission.status,
    created_at: submission.created_at,
    customer_email: customer?.email || '',
    customer_company: customer?.company || '',
    customer_status: customer?.status || 'lead',
    submission_status: submission.status,
    report_file_url: submissionReports[0]?.report_file_url || '',
    report_id: submissionReports[0]?.id || '',
  };
};

const issuePortalToken = async (req, workspace, eventType) => {
  const token = generatePortalToken();
  const tokenHash = hashPortalToken(token);
  const now = new Date().toISOString();
  const [updated] = await restUpdate('workspaces', { id: `eq.${workspace.id}` }, {
    portal_token_hash: tokenHash,
    portal_token_created_at: now,
    portal_token_last_used_at: null,
    portal_token_revoked_at: null,
  });
  return {
    workspace: updated || workspace,
    portal_token: token,
    portal_url: buildPortalUrl(req, token),
    eventType,
  };
};

const cleanupSubmissionCsv = async (submission) => {
  if (!submission?.csv_file_url) return;
  try { await storageDelete({ bucket: CSV_BUCKET, objectPath: submission.csv_file_url }); } catch {}
};

const getOrCreateProfile = async (email) => {
  const normalizedEmail = normalize(email).toLowerCase();
  const existing = await restSingle('profiles', { select: '*', email: `eq.${normalizedEmail}`, limit: 1 });
  if (existing) return existing;
  const [created] = await restInsert('profiles', { email: normalizedEmail });
  return created || null;
};

const buildWorkspaceNotes = (betaRequest) => {
  const parts = [
    `Beta request: ${betaRequest.id}`,
    betaRequest.website ? `Website: ${betaRequest.website}` : null,
    Array.isArray(betaRequest.platforms) && betaRequest.platforms.length ? `Platforms: ${betaRequest.platforms.join(', ')}` : null,
    betaRequest.monthly_spend_range ? `Monthly spend range: ${betaRequest.monthly_spend_range}` : null,
    betaRequest.is_agency ? 'Agency request: yes' : 'Agency request: no',
    betaRequest.review_goal ? `Review goal: ${betaRequest.review_goal}` : null,
    betaRequest.notes ? `Beta notes: ${betaRequest.notes}` : null,
  ].filter(Boolean);
  return parts.join('\n');
};

const createWorkspaceFromBetaRequest = async (betaRequest, req) => {
  const profile = await getOrCreateProfile(betaRequest.email);
  const workspaceName = betaRequest.company || betaRequest.name || betaRequest.email;
  const existingWorkspace = betaRequest.workspace_id
    ? await restSingle('workspaces', { select: '*', id: `eq.${betaRequest.workspace_id}`, limit: 1 })
    : await restSingle('workspaces', { select: '*', beta_request_id: `eq.${betaRequest.id}`, limit: 1 });

  let workspace = existingWorkspace || null;
  if (!workspace) {
    const [createdWorkspace] = await restInsert('workspaces', {
      profile_id: profile?.id || null,
      owner_email: betaRequest.email,
      workspace_name: workspaceName,
      business_type: betaRequest.is_agency ? 'agency' : 'manual_beta',
      primary_goal: betaRequest.review_goal,
      notes: buildWorkspaceNotes(betaRequest),
      plan: 'manual_beta',
      status: 'active',
      website: betaRequest.website,
      platforms: betaRequest.platforms,
      review_goal: betaRequest.review_goal,
      is_agency: Boolean(betaRequest.is_agency),
      beta_request_id: betaRequest.id,
    });
    workspace = createdWorkspace;
  }

  if (!workspace) {
    throw new Error('Failed to create workspace');
  }

  const issued = await issuePortalToken(req, workspace, 'portal_token_generated');
  const updatedWorkspace = issued.workspace || workspace;
  const now = new Date().toISOString();

  const [updatedRequest] = await restUpdate('beta_requests', { id: `eq.${betaRequest.id}` }, {
    status: 'workspace_created',
    workspace_id: updatedWorkspace.id,
    workspace_created_at: betaRequest.workspace_created_at || updatedWorkspace.created_at || now,
    portal_link_created_at: now,
  });

  return {
    workspace: updatedWorkspace,
    request: updatedRequest || betaRequest,
    portal: {
      has_token: true,
      token: issued.portal_token,
      url: issued.portal_url,
      created_at: updatedWorkspace.portal_token_created_at || null,
    },
  };
};

const requireProtectedAdmin = (req, res) => {
  if (!requireAdmin(req, res)) return false;
  return true;
};

module.exports = async (req, res) => {
  const endpoint = normalize(req.query?.endpoint || req.query?.action || req.query?.view || req.query?.kind || '');
  const method = String(req.method || '').toUpperCase();

  try {
    if (endpoint === 'login') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return respondError(res, 405, 'Method not allowed');
      }
      const secret = String(process.env.ADMIN_SECRET || '').trim();
      if (!secret) return respondError(res, 500, 'Admin access is not configured.');
      const raw = await readBodyBuffer(req);
      const body = await parseJsonBody(req, raw) || {};
      const candidate = String(body.secret || body.password || '').trim();
      if (!candidate || candidate !== secret) return respondError(res, 401, 'Unauthorized.');
      const token = createAdminSessionToken(secret);
      res.setHeader('Set-Cookie', buildAdminSessionCookie(token, req, SESSION_TTL_SECONDS));
      return respond(res, 200, { success: true });
    }

    if (endpoint === 'logout') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return respondError(res, 405, 'Method not allowed');
      }
      res.setHeader('Set-Cookie', clearAdminSessionCookie(req));
      return respond(res, 200, { success: true });
    }

    if (!requireProtectedAdmin(req, res)) return;

    if (endpoint === 'schema-health') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return respondError(res, 405, 'Method not allowed');
      }
      const health = await checkSchemaHealth();
      return respond(res, 200, {
        success: true,
        ok: health.ok,
        missing: health.missing,
        env: health.env,
        schema_checks_skipped: health.schema_checks_skipped || false,
      });
    }

    ensureConfig();

    if (endpoint === 'beta-requests') {
      if (method === 'GET') {
        const [requests, reviews] = await Promise.all([
          restSelect('beta_requests', { select: '*', order: 'created_at.desc', limit: 100 }),
          restSelect('portal_review_submissions', { select: '*', order: 'created_at.desc', limit: 100 }).catch(() => []),
        ]);
        return respond(res, 200, {
          success: true,
          requests: Array.isArray(requests) ? requests : [],
          portal_reviews: Array.isArray(reviews) ? reviews.map((row) => safePortalReview(row)) : [],
        });
      }
      if (method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return respondError(res, 405, 'Method not allowed');
      }
      const raw = await readBodyBuffer(req);
      const body = await parseJsonBody(req, raw);
      if (!body || typeof body !== 'object') return respondError(res, 400, 'Invalid JSON payload');
      const action = normalize(body.action || 'update-status').toLowerCase();
      const requestId = normalize(body.id || body.request_id);
      if (!requestId) return respondError(res, 400, 'id is required');

      if (action === 'create-workspace' || action === 'create') {
        const betaRequest = await restSingle('beta_requests', { select: '*', id: `eq.${requestId}`, limit: 1 });
        if (!betaRequest) return respondError(res, 404, 'Beta request not found');
        try {
          const result = await createWorkspaceFromBetaRequest(betaRequest, req);
          return respond(res, 200, {
            success: true,
            request: result.request,
            workspace: safeWorkspace(result.workspace),
            portal: result.portal,
          });
        } catch (error) {
          const supabase = safeSupabaseError(error);
          const safeError = {
            code: 'beta_request_workspace_create_failed',
            operation: 'beta_requests.create_workspace',
            supabase,
          };
          console.error('[gnomeo admin] create-workspace failed:', {
            operation: safeError.operation,
            request_id: requestId,
            supabase,
          });
          return respond(res, 500, { success: false, error: safeError });
        }
      }

      if (action !== 'update-status' && action !== 'update') return respondError(res, 400, 'Unsupported action');
      const status = normalize(body.status).toLowerCase();
      if (!ALLOWED_BETA_STATUSES.has(status)) return respondError(res, 400, 'Invalid status');
      const [updated] = await restUpdate('beta_requests', { id: `eq.${requestId}` }, { status });
      if (!updated) return respondError(res, 404, 'Beta request not found');
      return respond(res, 200, { success: true, request: updated });
    }

    if (endpoint === 'workspaces') {
      if (method === 'GET') {
        const workspaceId = normalize(req.query?.workspace_id || req.query?.id);
        const email = normalize(req.query?.email || req.query?.owner_email);
        if (workspaceId || email) {
          const workspace = workspaceId ? await restSingle('workspaces', { select: '*', id: `eq.${workspaceId}`, limit: 1 }) : await restSingle('workspaces', { select: '*', owner_email: `eq.${email}`, limit: 1 });
          if (!workspace) return respondError(res, 404, 'Workspace not found');
          const reports = await restSelect('report_runs', { select: '*', workspace_id: `eq.${workspace.id}`, order: 'created_at.desc', limit: 20 });
          return respond(res, 200, {
            success: true,
            workspace: safeWorkspace(workspace),
            latest_report: safeLatestRun((Array.isArray(reports) ? reports : [])[0] || null),
            reports: Array.isArray(reports) ? reports.map((run) => ({ ...safeHistoryRun(run), summary: run.summary || {}, top_recommendations: run.top_recommendations || [], trend_snapshot: run.trend_snapshot || [] })) : [],
            portal: {
              has_token: Boolean(workspace.portal_token_hash) && !workspace.portal_token_revoked_at,
              created_at: workspace.portal_token_created_at || null,
              last_used_at: workspace.portal_token_last_used_at || null,
              revoked_at: workspace.portal_token_revoked_at || null,
            },
          });
        }
        const workspaces = await restSelect('workspaces', { select: '*', order: 'created_at.desc', limit: 20 });
        return respond(res, 200, { success: true, workspaces: Array.isArray(workspaces) ? workspaces.map((workspace) => ({ ...safeWorkspace(workspace), portal: { has_token: Boolean(workspace.portal_token_hash) && !workspace.portal_token_revoked_at, created_at: workspace.portal_token_created_at || null, last_used_at: workspace.portal_token_last_used_at || null, revoked_at: workspace.portal_token_revoked_at || null } })) : [] });
      }
      if (method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return respondError(res, 405, 'Method not allowed');
      }
      const raw = await readBodyBuffer(req);
      const body = await parseJsonBody(req, raw);
      if (!body || typeof body !== 'object') return respondError(res, 400, 'Invalid JSON payload');
      const action = normalize(body.action || 'create').toLowerCase();
      if (action === 'revoke-portal-token' || action === 'revoke-token' || action === 'revoke') {
        const workspaceId = normalize(body.workspace_id || body.id);
        if (!workspaceId) return respondError(res, 400, 'workspace_id is required');
        const workspace = await restSingle('workspaces', { select: '*', id: `eq.${workspaceId}`, limit: 1 });
        if (!workspace) return respondError(res, 404, 'Workspace not found');
        const [updated] = await restUpdate('workspaces', { id: `eq.${workspaceId}` }, { portal_token_hash: null, portal_token_revoked_at: new Date().toISOString() });
        return respond(res, 200, { success: true, workspace: safeWorkspace(updated || workspace), portal: { has_token: false, revoked_at: (updated || workspace).portal_token_revoked_at || null } });
      }
      if (action === 'generate-portal-token' || action === 'regenerate-portal-token' || action === 'issue-token') {
        const workspaceId = normalize(body.workspace_id || body.id);
        if (!workspaceId) return respondError(res, 400, 'workspace_id is required');
        const workspace = await restSingle('workspaces', { select: '*', id: `eq.${workspaceId}`, limit: 1 });
        if (!workspace) return respondError(res, 404, 'Workspace not found');
        const issued = await issuePortalToken(req, workspace, 'portal_token_generated');
        return respond(res, 200, { success: true, workspace: safeWorkspace(issued.workspace), portal: { has_token: true, token: issued.portal_token, url: issued.portal_url, created_at: issued.workspace.portal_token_created_at || null } });
      }
      const ownerEmail = normalize(body.owner_email || body.email);
      const workspaceName = normalize(body.workspace_name || body.name);
      if (!ownerEmail) return respondError(res, 400, 'owner_email is required');
      if (!workspaceName) return respondError(res, 400, 'workspace_name is required');
      const [profile] = await restInsert('profiles', { email: ownerEmail.toLowerCase() }).catch(async () => [await restSingle('profiles', { select: '*', email: `eq.${ownerEmail.toLowerCase()}`, limit: 1 })]);
      const [workspace] = await restInsert('workspaces', {
        profile_id: profile?.id || null,
        owner_email: ownerEmail.toLowerCase(),
        workspace_name: workspaceName,
        business_type: normalize(body.business_type) || null,
        primary_goal: normalize(body.primary_goal) || null,
        risk_appetite: normalize(body.risk_appetite) || null,
        budget_constraint: normalize(body.budget_constraint) || null,
        notes: normalize(body.notes) || null,
        plan: normalize(body.plan) || 'manual_beta',
        status: normalize(body.status) || 'active',
      });
      if (!body.issue_portal_token || body.issue_portal_token === 'false') return respond(res, 201, { success: true, profile, workspace: safeWorkspace(workspace) });
      const issued = await issuePortalToken(req, workspace, 'portal_token_generated');
      return respond(res, 201, { success: true, profile, workspace: safeWorkspace(issued.workspace), portal: { has_token: true, token: issued.portal_token, url: issued.portal_url, created_at: issued.workspace.portal_token_created_at || null } });
    }

    if (endpoint === 'file') {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return respondError(res, 405, 'Method not allowed');
      }
      const kind = normalize(req.query?.kind || '');
      if (kind === 'csv') {
        const submissionId = normalize(req.query?.submission_id);
        const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
        if (!submission) return respondError(res, 404, 'Submission not found');
        if (!submission.csv_file_url) return respondError(res, 404, 'CSV file not linked to this submission yet');
        const file = await storageDownload({ bucket: CSV_BUCKET, objectPath: submission.csv_file_url });
        res.statusCode = 200;
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(submission.csv_file_url || submission.original_filename || 'submission.csv')}"`);
        return res.end(file.buffer);
      }
      if (kind === 'report') {
        const reportId = normalize(req.query?.report_id);
        const submissionId = normalize(req.query?.submission_id);
        let report = null;
        if (reportId) report = await restSingle('reports', { select: '*', id: `eq.${reportId}`, limit: 1 });
        else if (submissionId) {
          const reports = await restSelect('reports', { select: '*', submission_id: `eq.${submissionId}`, order: 'created_at.desc', limit: 1 });
          report = Array.isArray(reports) ? reports[0] || null : null;
        }
        if (!report) return respondError(res, 404, 'Report not found');
        const file = await storageDownload({ bucket: REPORTS_BUCKET, objectPath: report.report_file_url });
        res.statusCode = 200;
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(report.report_file_url)}"`);
        return res.end(file.buffer);
      }
      return respondError(res, 400, 'Unknown file kind');
    }

    if (endpoint === 'submissions') {
      if (method === 'GET') {
        const view = normalize(req.query?.view || 'list');
        if (view === 'list') {
          const [customers, submissions, reports, emailEvents] = await Promise.all([
            restSelect('customers', { select: '*', order: 'created_at.desc' }),
            restSelect('submissions', { select: '*', order: 'created_at.desc' }),
            restSelect('reports', { select: '*', order: 'created_at.desc' }),
            restSelect('email_events', { select: '*', order: 'sent_at.desc' }),
          ]);
          const rows = (Array.isArray(submissions) ? submissions : []).map((submission) => {
            const customer = (Array.isArray(customers) ? customers : []).find((item) => item.id === submission.customer_id) || null;
            const submissionReports = (Array.isArray(reports) ? reports : []).filter((item) => item.submission_id === submission.id);
            return {
              submission,
              customer,
              reports: submissionReports,
              email_events: (Array.isArray(emailEvents) ? emailEvents : []).filter((item) => item.submission_id === submission.id),
              id: submission.id,
              original_filename: submission.original_filename,
              notes: submission.notes,
              status: submission.status,
              created_at: submission.created_at,
              customer_email: customer?.email || '',
              customer_company: customer?.company || '',
              customer_status: customer?.status || 'lead',
              submission_status: submission.status,
              report_file_url: submissionReports[0]?.report_file_url || '',
              report_id: submissionReports[0]?.id || '',
            };
          });
          return respond(res, 200, { success: true, submissions: rows });
        }
        if (view === 'detail') {
          const detail = await detailCRM(normalize(req.query?.id));
          if (!detail) return respondError(res, 404, 'Submission not found');
          return respond(res, 200, { success: true, ...detail });
        }
        return respondError(res, 400, 'Unknown view');
      }
      if (method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return respondError(res, 405, 'Method not allowed');
      }
      const body = await parseJsonBody(req, await readBodyBuffer(req));
      if (!body || typeof body !== 'object') return respondError(res, 400, 'Invalid JSON body');
      const email = normalize(body.email);
      if (!email) return respondError(res, 400, 'Customer email is required');
      const company = normalize(body.company);
      const originalFilename = normalize(body.original_filename);
      const notes = normalize(body.notes);
      const status = normalize(body.status) || 'received';
      const [existingCustomer] = await restSelect('customers', { select: '*', email: `eq.${email}`, limit: 1 });
      let customer = existingCustomer || null;
      if (!customer) {
        const [createdCustomer] = await restInsert('customers', { id: generateId(), email, company: company || null, status: 'lead', notes: notes || 'Created from manual submission form.' });
        customer = createdCustomer;
      }
      const [submission] = await restInsert('submissions', {
        id: generateId(),
        customer_id: customer.id,
        original_filename: originalFilename || 'manual-submission.csv',
        csv_file_url: null,
        status,
        created_at: new Date().toISOString(),
        notes: notes || 'Created manually from the admin dashboard.',
      });
      return respond(res, 200, { success: true, customer, submission });
    }

    if (endpoint === 'crm' || endpoint === 'upload-report') {
      if (method === 'GET') {
        const view = normalize(req.query?.view || 'list');
        if (view === 'list') {
          return respond(res, 200, { success: true, submissions: await listCRM() });
        }
        if (view === 'detail') {
          const detail = await detailCRM(normalize(req.query?.id));
          if (!detail) return respondError(res, 404, 'Submission not found');
          return respond(res, 200, { success: true, ...detail });
        }
        return respondError(res, 400, 'Unknown view');
      }
      if (method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return respondError(res, 405, 'Method not allowed');
      }
      const contentType = String(req.headers['content-type'] || '');
      const raw = await readBodyBuffer(req);
      let body = {};
      let upload = null;
      if (/multipart\/form-data/i.test(contentType)) {
        const parsed = parseMultipartForm(raw, contentType);
        body = parsed.fields || {};
        upload = parsed.file;
      } else if (raw.length) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { body = {}; }
      }
      const action = normalize(body.action || endpoint || '');
      if (action === 'update-status' || action === 'update') {
        const submissionId = normalize(body.submission_id || body.id);
        const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
        if (!submission) return respondError(res, 404, 'Submission not found');
        const customer = await restSingle('customers', { select: '*', id: `eq.${submission.customer_id}`, limit: 1 });
        const [updatedSubmission] = await restUpdate('submissions', { id: `eq.${submissionId}` }, { status: body.submission_status || submission.status, notes: body.submission_notes ?? submission.notes });
        const updatedCustomer = customer ? (await restUpdate('customers', { id: `eq.${customer.id}` }, { status: body.customer_status || customer.status, notes: body.customer_notes ?? customer.notes }))[0] : null;
        return respond(res, 200, { success: true, submission: updatedSubmission || submission, customer: updatedCustomer || customer });
      }
      if (action === 'upload-report') {
        const submissionId = normalize(body.submission_id || body.id);
        const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
        if (!submission) return respondError(res, 404, 'Submission not found');
        if (!upload || !upload.filename) return respondError(res, 400, 'Report file is required');
        if (!/\.(html?|pdf)$/i.test(upload.filename)) return respondError(res, 400, 'Report must be HTML or PDF');
        const reportName = `${Date.now()}-${safeName(upload.filename)}`;
        const reportPath = `reports/${submissionId}/${reportName}`;
        await storageUpload({ bucket: REPORTS_BUCKET, objectPath: reportPath, content: Buffer.from(upload.content, 'latin1'), contentType: upload.contentType || (upload.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8'), upsert: true });
        const [reportRow] = await restInsert('reports', { id: generateId(), submission_id: submissionId, report_file_url: reportPath, summary: normalize(body.summary) || null, sent_at: null });
        await restUpdate('submissions', { id: `eq.${submissionId}` }, { status: 'report_ready' });
        return respond(res, 200, { success: true, report: reportRow, report_path: reportPath, report_file_name: path.basename(reportPath) });
      }
      if (action === 'send-report') {
        const submissionId = normalize(body.submission_id || body.id);
        const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
        if (!submission) return respondError(res, 404, 'Submission not found');
        const customer = await restSingle('customers', { select: '*', id: `eq.${submission.customer_id}`, limit: 1 });
        const reports = await restSelect('reports', { select: '*', submission_id: `eq.${submissionId}`, order: 'created_at.desc', limit: 1 });
        const report = Array.isArray(reports) ? reports[0] || null : null;
        if (!report) return respondError(res, 400, 'No report uploaded yet');
        const downloaded = await storageDownload({ bucket: REPORTS_BUCKET, objectPath: report.report_file_url });
        const template = loadTemplate();
        const attachment = { filename: path.basename(report.report_file_url), content: downloaded.buffer.toString('base64') };
        try {
          await resendSend({ to: customer?.email, subject: template.subject, body: template.body, attachments: [attachment] });
          const sentAt = new Date().toISOString();
          await restUpdate('submissions', { id: `eq.${submissionId}` }, { status: 'report_sent' });
          await restUpdate('reports', { id: `eq.${report.id}` }, { sent_at: sentAt });
          await restInsert('email_events', { id: generateId(), customer_id: customer?.id || null, submission_id: submissionId, type: 'report_sent', status: 'sent', sent_at: sentAt });
          await cleanupSubmissionCsv(submission);
          return respond(res, 200, { success: true, sent_at: sentAt });
        } finally {
          await cleanupSubmissionCsv(submission);
        }
      }
      return respondError(res, 400, 'Unknown action');
    }

    return respondError(res, 404, 'Unknown admin endpoint');
  } catch (error) {
    console.error('[gnomeo admin] request failed:', error);
    return respond(res, 500, { success: false, error: mapSchemaError(error) });
  }
};
