const path = require('path');
const { parseMultipartForm } = require('../_multipart');
const { generateId, restSingle, restSelect, restInsert, restUpdate, storageUpload } = require('../_supabase');
const { requireAdmin } = require('../_adminAuth');
const REPORTS_BUCKET = 'reports';

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({ success: false, step, error });

const mapSchemaError = (error) => {
  const message = String(error?.message || error || 'Unknown error');
  if (/SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/i.test(message)) {
    return 'Supabase env vars are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';
  }
  if (/relation .* does not exist|schema cache/i.test(message)) {
    return 'Supabase tables are missing. Apply agent_mvp/admin_data/supabase_schema.sql.';
  }
  if (/bucket.*not found|storage/i.test(message) && /not found/i.test(message)) {
    return 'Supabase storage buckets are missing. Create the private submissions and reports buckets.';
  }
  return message;
};

const latest = (items) => (Array.isArray(items) && items.length ? items[0] : null);
const safeName = (value) => String(value || 'report').replace(/[^a-zA-Z0-9._-]+/g, '-');

module.exports = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) {
      return respondError(res, 401, 'auth', 'Unauthorized');
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return respondError(res, 405, 'method', 'Method not allowed');
    }

    const contentType = String(req.headers['content-type'] || '');
    const raw = await new Promise(async (resolve) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      resolve(Buffer.concat(chunks));
    });

    let body = {};
    let upload = null;
    if (/multipart\/form-data/i.test(contentType)) {
      const parsed = parseMultipartForm(raw, contentType);
      body = parsed.fields || {};
      upload = parsed.file;
    } else if (raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = {}; }
    }

    const submissionId = String(body.submission_id || '').trim();
    if (!submissionId) return respondError(res, 400, 'validation', 'Submission is required');
    if (!upload || !upload.filename) return respondError(res, 400, 'file', 'Report file is required');
    if (!/\.(html?|pdf)$/i.test(upload.filename)) return respondError(res, 400, 'file', 'Report must be HTML or PDF');

    const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
    if (!submission) return respondError(res, 404, 'not-found', 'Submission not found');

    const reportName = `${Date.now()}-${safeName(upload.filename)}`;
    const reportPath = `reports/${submissionId}/${reportName}`;
    await storageUpload({
      bucket: REPORTS_BUCKET,
      objectPath: reportPath,
      content: Buffer.from(upload.content, 'latin1'),
      contentType: upload.contentType || (upload.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8'),
      upsert: true,
    });

    const existing = await restSelect('reports', { select: '*', submission_id: `eq.${submissionId}`, order: 'created_at.desc', limit: 1 });
    const current = latest(existing);
    const summary = String(body.summary || '').trim() || null;

    let reportRow = null;
    if (current) {
      const [updated] = await restUpdate('reports', { id: `eq.${current.id}` }, {
        report_file_url: reportPath,
        summary,
        sent_at: null,
      });
      reportRow = updated || current;
    } else {
      const [inserted] = await restInsert('reports', {
        id: generateId(),
        submission_id: submissionId,
        report_file_url: reportPath,
        summary,
        sent_at: null,
      });
      reportRow = inserted;
    }

    await restUpdate('submissions', { id: `eq.${submissionId}` }, { status: 'report_ready' });

    return res.status(200).json({
      success: true,
      report: reportRow,
      report_path: reportPath,
      report_file_name: path.basename(reportPath),
    });
  } catch (error) {
    console.error('[gnomeo admin upload-report] request failed:', error);
    return respondError(res, 500, 'supabase', mapSchemaError(error));
  }
};
