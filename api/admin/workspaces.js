const {
  upsertProfileByEmail,
  createWorkspace,
  listWorkspaces,
  getWorkspaceByEmail,
  getWorkspaceById,
  updateWorkspaceById,
  getWorkspaceReports,
  logUsageEvent,
  ensureConfig,
} = require('../_supabase');
const { requireAdmin } = require('../_adminAuth');
const { generatePortalToken, hashPortalToken, buildPortalUrl, safeWorkspace, safeHistoryRun, safeLatestRun } = require('../_portal');

const readRequestBuffer = async (req) => {
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const parseJsonBody = async (req, rawBuffer) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (!rawBuffer.length) return {};
  try {
    return JSON.parse(rawBuffer.toString('utf8'));
  } catch {
    return null;
  }
};

const respond = (res, statusCode, payload) => res.status(statusCode).json(payload);
const normalize = (value) => String(value || '').trim();

const safeWorkspaceDetail = async (workspace) => {
  const reports = await getWorkspaceReports(workspace.id, { limit: 20 });
  return {
    workspace: safeWorkspace(workspace),
    latest_report: safeLatestRun(reports[0] || null),
    reports: Array.isArray(reports)
      ? reports.map((run) => ({
          ...safeHistoryRun(run),
          summary: run.summary || {},
          top_recommendations: run.top_recommendations || [],
          trend_snapshot: run.trend_snapshot || [],
        }))
      : [],
  };
};

const issuePortalToken = async (req, workspace, eventType) => {
  const token = generatePortalToken();
  const tokenHash = hashPortalToken(token);
  const now = new Date().toISOString();
  const [updated] = await updateWorkspaceById(workspace.id, {
    portal_token_hash: tokenHash,
    portal_token_created_at: now,
    portal_token_last_used_at: null,
    portal_token_revoked_at: null,
  });

  await logUsageEvent({
    workspace_id: workspace.id,
    event_type: eventType,
    plan: workspace.plan,
    metadata: {
      workspace_name: workspace.workspace_name,
      owner_email: workspace.owner_email,
    },
  });

  return {
    workspace: updated || workspace,
    portal_token: token,
    portal_url: buildPortalUrl(req, token),
  };
};

module.exports = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    ensureConfig();
  } catch (error) {
    return respond(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }

  const method = String(req.method || 'GET').toUpperCase();
  const rawBuffer = method === 'POST' ? await readRequestBuffer(req) : Buffer.alloc(0);
  const body = method === 'POST' ? await parseJsonBody(req, rawBuffer) : {};

  if (method === 'GET') {
    const workspaceId = normalize(req.query?.workspace_id || req.query?.id);
    const email = normalize(req.query?.email || req.query?.owner_email);

    if (workspaceId || email) {
      const workspace = workspaceId
        ? await getWorkspaceById(workspaceId)
        : await getWorkspaceByEmail(email);

      if (!workspace) {
        return respond(res, 404, { success: false, error: 'Workspace not found' });
      }

      const detail = await safeWorkspaceDetail(workspace);
      await logUsageEvent({
        workspace_id: workspace.id,
        event_type: 'portal_viewed',
        plan: workspace.plan,
        metadata: { owner_email: workspace.owner_email },
      });

      return respond(res, 200, {
        success: true,
        ...detail,
        portal: {
          has_token: Boolean(workspace.portal_token_hash) && !workspace.portal_token_revoked_at,
          created_at: workspace.portal_token_created_at || null,
          last_used_at: workspace.portal_token_last_used_at || null,
          revoked_at: workspace.portal_token_revoked_at || null,
        },
      });
    }

    const workspaces = await listWorkspaces({ limit: 20 });
    return respond(res, 200, {
      success: true,
      workspaces: Array.isArray(workspaces)
        ? workspaces.map((workspace) => ({
            ...safeWorkspace(workspace),
            portal: {
              has_token: Boolean(workspace.portal_token_hash) && !workspace.portal_token_revoked_at,
              created_at: workspace.portal_token_created_at || null,
              last_used_at: workspace.portal_token_last_used_at || null,
              revoked_at: workspace.portal_token_revoked_at || null,
            },
          }))
        : [],
    });
  }

  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return respond(res, 405, { success: false, error: 'Method not allowed' });
  }

  if (!body || typeof body !== 'object') {
    return respond(res, 400, { success: false, error: 'Invalid JSON payload' });
  }

  const action = normalize(body.action || body.mode || 'create').toLowerCase();

  if (action === 'revoke-portal-token' || action === 'revoke-token' || action === 'revoke') {
    const workspaceId = normalize(body.workspace_id || body.id);
    if (!workspaceId) return respond(res, 400, { success: false, error: 'workspace_id is required' });

    const workspace = await getWorkspaceById(workspaceId);
    if (!workspace) return respond(res, 404, { success: false, error: 'Workspace not found' });

    const [updated] = await updateWorkspaceById(workspaceId, {
      portal_token_hash: null,
      portal_token_revoked_at: new Date().toISOString(),
    });

    await logUsageEvent({
      workspace_id: workspace.id,
      event_type: 'portal_token_revoked',
      plan: workspace.plan,
      metadata: { owner_email: workspace.owner_email },
    });

    return respond(res, 200, {
      success: true,
      workspace: safeWorkspace(updated || workspace),
      portal: { has_token: false, revoked_at: (updated || workspace).portal_token_revoked_at || null },
    });
  }

  if (action === 'generate-portal-token' || action === 'regenerate-portal-token' || action === 'issue-token') {
    const workspaceId = normalize(body.workspace_id || body.id);
    if (!workspaceId) return respond(res, 400, { success: false, error: 'workspace_id is required' });

    const workspace = await getWorkspaceById(workspaceId);
    if (!workspace) return respond(res, 404, { success: false, error: 'Workspace not found' });

    const issued = await issuePortalToken(req, workspace, 'portal_token_generated');
    return respond(res, 200, {
      success: true,
      workspace: safeWorkspace(issued.workspace),
      portal: {
        has_token: true,
        token: issued.portal_token,
        url: issued.portal_url,
        created_at: issued.workspace.portal_token_created_at || null,
      },
    });
  }

  const ownerEmail = normalize(body.owner_email || body.email);
  const workspaceName = normalize(body.workspace_name || body.name);

  if (!ownerEmail) return respond(res, 400, { success: false, error: 'owner_email is required' });
  if (!workspaceName) return respond(res, 400, { success: false, error: 'workspace_name is required' });

  const profile = await upsertProfileByEmail({ email: ownerEmail.toLowerCase() });
  const workspace = await createWorkspace({
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

  await logUsageEvent({
    workspace_id: workspace.id,
    event_type: 'workspace_created',
    plan: workspace.plan,
    metadata: {
      owner_email: ownerEmail.toLowerCase(),
      workspace_name: workspaceName,
      business_type: normalize(body.business_type) || null,
      primary_goal: normalize(body.primary_goal) || null,
    },
  });

  const shouldIssueToken = body.issue_portal_token !== false && body.issue_portal_token !== 'false';
  if (!shouldIssueToken) {
    return respond(res, 201, { success: true, profile, workspace: safeWorkspace(workspace) });
  }

  const issued = await issuePortalToken(req, workspace, 'portal_token_generated');
  return respond(res, 201, {
    success: true,
    profile,
    workspace: safeWorkspace(issued.workspace),
    portal: {
      has_token: true,
      token: issued.portal_token,
      url: issued.portal_url,
      created_at: issued.workspace.portal_token_created_at || null,
    },
  });
};
