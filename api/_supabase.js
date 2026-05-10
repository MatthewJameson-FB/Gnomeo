const { randomUUID } = require('crypto');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const ensureConfig = () => {
  if (!SUPABASE_URL) throw new Error('SUPABASE_URL is missing');
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing');
};

const authHeaders = (headers = {}) => ({
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  ...headers,
});

const encodePath = (value) => String(value).split('/').map(encodeURIComponent).join('/');

const toQuery = (params = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const output = query.toString();
  return output ? `?${output}` : '';
};

const request = async (pathname, { method = 'GET', query, headers = {}, body, json = true } = {}) => {
  ensureConfig();
  const response = await fetch(`${SUPABASE_URL}${pathname}${toQuery(query)}`, {
    method,
    headers: authHeaders(headers),
    body,
  });

  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  const payload = json && text && contentType.includes('application/json') ? JSON.parse(text) : text;

  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : payload?.message || payload?.error || text || `Supabase request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
};

const restSelect = async (table, query = {}) => request(`/rest/v1/${table}`, { query, json: true });
const restSingle = async (table, query = {}) => {
  const rows = await request(`/rest/v1/${table}`, { query, json: true });
  return Array.isArray(rows) ? rows[0] || null : rows;
};
const restInsert = async (table, rows) => request(`/rest/v1/${table}`, {
  method: 'POST',
  query: { select: '*' },
  headers: {
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  },
  body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  json: true,
});
const restUpsert = async (table, rows, onConflict) => request(`/rest/v1/${table}`, {
  method: 'POST',
  query: { on_conflict: onConflict, select: '*' },
  headers: {
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  },
  body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  json: true,
});
const restUpdate = async (table, filters, values) => request(`/rest/v1/${table}`, {
  method: 'PATCH',
  query: { ...filters, select: '*' },
  headers: {
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  },
  body: JSON.stringify(values),
  json: true,
});

const restDelete = async (table, filters) => request(`/rest/v1/${table}`, {
  method: 'DELETE',
  query: { ...filters, select: '*' },
  headers: {
    Prefer: 'return=representation',
  },
  json: true,
});

const upsertProfileByEmail = async ({ email }) => {
  const existing = await restSingle('profiles', { select: '*', email: `eq.${email}`, limit: 1 });
  if (existing) return existing;
  const [created] = await restInsert('profiles', { email });
  return created;
};

const createWorkspace = async (values) => {
  const [created] = await restInsert('workspaces', values);
  return created;
};

const listWorkspaces = async ({ limit = 20 } = {}) => restSelect('workspaces', { select: '*', order: 'created_at.desc', limit });

const getWorkspaceByEmail = async (email) => restSingle('workspaces', { select: '*', owner_email: `eq.${email}`, limit: 1 });

const getWorkspaceById = async (workspaceId) => restSingle('workspaces', { select: '*', id: `eq.${workspaceId}`, limit: 1 });

const updateWorkspaceById = async (workspaceId, values) => restUpdate('workspaces', { id: `eq.${workspaceId}` }, values);

const getWorkspaceReports = async (workspaceId, { limit = 20 } = {}) => restSelect('report_runs', { select: '*', workspace_id: `eq.${workspaceId}`, order: 'created_at.desc', limit });

const logUsageEvent = async (values) => {
  const payload = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    ...values,
  };
  const [created] = await restInsert('usage_events', payload);
  return created;
};

const storageUpload = async ({ bucket, objectPath, content, contentType, upsert = false }) => request(`/storage/v1/object/${bucket}/${encodePath(objectPath)}`, {
  method: 'POST',
  headers: {
    'Content-Type': contentType || 'application/octet-stream',
    'x-upsert': upsert ? 'true' : 'false',
  },
  body: content,
  json: true,
});

const storageDownload = async ({ bucket, objectPath }) => {
  ensureConfig();
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${bucket}/${encodePath(objectPath)}`, {
    headers: authHeaders(),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(buffer.toString('utf8') || `Storage download failed (${response.status})`);
  }
  return {
    buffer,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    contentDisposition: response.headers.get('content-disposition') || '',
  };
};

const storageDelete = async ({ bucket, objectPath }) => request(`/storage/v1/object/${bucket}/${encodePath(objectPath)}`, {
  method: 'DELETE',
  json: true,
});

const generateId = () => randomUUID();

module.exports = {
  generateId,
  restSelect,
  restSingle,
  restInsert,
  restUpsert,
  restUpdate,
  restDelete,
  upsertProfileByEmail,
  createWorkspace,
  listWorkspaces,
  getWorkspaceByEmail,
  getWorkspaceById,
  updateWorkspaceById,
  getWorkspaceReports,
  logUsageEvent,
  storageUpload,
  storageDownload,
  storageDelete,
  ensureConfig,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
};
