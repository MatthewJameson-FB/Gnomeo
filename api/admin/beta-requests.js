const { restSelect, restUpdate, ensureConfig } = require('../_supabase');
const { requireAdmin } = require('../_adminAuth');

const ALLOWED_STATUSES = new Set(['new', 'contacted', 'workspace_created', 'declined']);

const respond = (res, statusCode, payload) => res.status(statusCode).json(payload);

const parseJsonBody = async (req, rawBuffer) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (!rawBuffer.length) return {};
  try {
    return JSON.parse(rawBuffer.toString('utf8'));
  } catch {
    return null;
  }
};

const readRequestBuffer = async (req) => {
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const normalize = (value) => String(value || '').trim();

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
    const rows = await restSelect('beta_requests', { select: '*', order: 'created_at.desc', limit: 100 });
    return respond(res, 200, { success: true, requests: Array.isArray(rows) ? rows : [] });
  }

  if (method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return respond(res, 405, { success: false, error: 'Method not allowed' });
  }

  if (!body || typeof body !== 'object') {
    return respond(res, 400, { success: false, error: 'Invalid JSON payload' });
  }

  const action = normalize(body.action || 'update-status').toLowerCase();
  if (action !== 'update-status' && action !== 'update') {
    return respond(res, 400, { success: false, error: 'Unsupported action' });
  }

  const requestId = normalize(body.id || body.request_id);
  if (!requestId) {
    return respond(res, 400, { success: false, error: 'id is required' });
  }

  const status = normalize(body.status).toLowerCase();
  if (!ALLOWED_STATUSES.has(status)) {
    return respond(res, 400, { success: false, error: 'Invalid status' });
  }

  const [updated] = await restUpdate('beta_requests', { id: `eq.${requestId}` }, { status });
  if (!updated) {
    return respond(res, 404, { success: false, error: 'Beta request not found' });
  }

  return respond(res, 200, { success: true, request: updated });
};
