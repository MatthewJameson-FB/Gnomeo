const { generateId, restSelect, restSingle, restInsert, restUpdate } = require('../_supabase');

const ADMIN_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD || 'gnomeo-admin';

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({ success: false, step, error });

const requireAdmin = (req) => String(req.headers['x-admin-password'] || '').trim() === ADMIN_PASSWORD;

const readJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const mapSchemaError = (error) => {
  const message = String(error?.message || error || 'Unknown error');
  if (/SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/i.test(message)) {
    return 'Supabase env vars are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';
  }
  if (/relation .* does not exist|schema cache/i.test(message)) {
    return 'Supabase tables are missing. Apply agent_mvp/admin_data/supabase_schema.sql.';
  }
  return message;
};

const upsertCustomer = async ({ email, company, notes }) => {
  const existing = await restSingle('customers', { select: '*', email: `eq.${email}`, limit: 1 });
  if (existing) {
    const updates = {};
    if (company) updates.company = company;
    if (notes) updates.notes = notes;
    if (Object.keys(updates).length) {
      const [updated] = await restUpdate('customers', { id: `eq.${existing.id}` }, updates);
      return updated || existing;
    }
    return existing;
  }

  const [created] = await restInsert('customers', {
    id: generateId(),
    email,
    company: company || null,
    status: 'lead',
    notes: notes || 'Created from manual submission form.',
  });
  return created;
};

const createSubmission = async ({ customerId, email, company, originalFilename, notes, status }) => {
  const [submission] = await restInsert('submissions', {
    id: generateId(),
    customer_id: customerId,
    original_filename: originalFilename || 'manual-submission.csv',
    csv_file_url: null,
    status: status || 'received',
    created_at: new Date().toISOString(),
    notes: notes || 'Created manually from the admin dashboard.',
  });
  return submission;
};

module.exports = async (req, res) => {
  if (!requireAdmin(req)) {
    return respondError(res, 401, 'auth', 'Unauthorized');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respondError(res, 405, 'method', 'Method not allowed');
  }

  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') {
      return respondError(res, 400, 'request-body', 'Invalid JSON body');
    }

    const email = String(body.email || '').trim();
    const company = String(body.company || '').trim();
    const originalFilename = String(body.original_filename || '').trim();
    const notes = String(body.notes || '').trim();
    const status = String(body.status || 'received').trim();

    if (!email) return respondError(res, 400, 'validation', 'Customer email is required');

    const customer = await upsertCustomer({ email, company, notes: notes || 'Created from manual submission form.' });
    const submission = await createSubmission({
      customerId: customer.id,
      email,
      company,
      originalFilename,
      notes,
      status,
    });

    return res.status(200).json({ success: true, customer, submission });
  } catch (error) {
    console.error('[gnomeo admin submissions] create failed:', error);
    return respondError(res, 500, 'supabase', mapSchemaError(error));
  }
};
