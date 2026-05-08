const { upsertProfileByEmail, createWorkspace, listWorkspaces, logUsageEvent, ensureConfig, getWorkspaceByEmail, getWorkspaceReports } = require('../_supabase');
const { requireAdmin } = require('../_adminAuth');

const readRequestBuffer = async (req) => {
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

module.exports = async (req, res) => {
  // TODO: protect this endpoint before public production use.
  // Intended for manual concierge beta admin workflows only.

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
    const email = normalize(req.query?.email || req.query?.owner_email);
    if (email) {
      const workspace = await getWorkspaceByEmail(email);
      if (!workspace) {
        return respond(res, 404, { success: false, error: 'Workspace not found' });
      }
      const reports = await getWorkspaceReports(workspace.id, { limit: 20 });
      await logUsageEvent({
        workspace_id: workspace.id,
        event_type: 'portal_viewed',
        plan: workspace.plan,
        metadata: { owner_email: email.toLowerCase() },
      });
      return respond(res, 200, { success: true, workspace, reports });
    }

    const workspaces = await listWorkspaces({ limit: 20 });
    return respond(res, 200, { success: true, workspaces });
  }

  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return respond(res, 405, { success: false, error: 'Method not allowed' });
  }

  if (!body || typeof body !== 'object') {
    return respond(res, 400, { success: false, error: 'Invalid JSON payload' });
  }

  const ownerEmail = normalize(body.owner_email);
  const workspaceName = normalize(body.workspace_name);

  if (!ownerEmail) return respond(res, 400, { success: false, error: 'owner_email is required' });
  if (!workspaceName) return respond(res, 400, { success: false, error: 'workspace_name is required' });

  const profile = await upsertProfileByEmail({ email: ownerEmail });
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

  return respond(res, 201, { success: true, profile, workspace });
};
