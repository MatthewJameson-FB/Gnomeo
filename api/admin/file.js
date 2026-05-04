const path = require('path');
const { restSingle, restSelect, storageDownload } = require('../_supabase');

const ADMIN_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD || 'gnomeo-admin';

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({ success: false, step, error });

const requireAdmin = (req) => String(req.headers['x-admin-password'] || '').trim() === ADMIN_PASSWORD;

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

module.exports = async (req, res) => {
  try {
    if (!requireAdmin(req)) {
      return respondError(res, 401, 'auth', 'Unauthorized');
    }

    const query = req.query || {};
    const kind = String(query.kind || '').trim();

    if (kind === 'csv') {
      const submissionId = String(query.submission_id || '').trim();
      const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
      if (!submission) return respondError(res, 404, 'not-found', 'Submission not found');
      if (!submission.csv_file_url) return respondError(res, 404, 'missing-file', 'CSV file not linked to this submission yet');
      const file = await storageDownload({ bucket: 'submissions', objectPath: submission.csv_file_url });
      res.statusCode = 200;
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(submission.csv_file_url || submission.original_filename || 'submission.csv')}"`);
      return res.end(file.buffer);
    }

    if (kind === 'report') {
      const reportId = String(query.report_id || '').trim();
      const submissionId = String(query.submission_id || '').trim();
      let report = null;
      if (reportId) {
        report = await restSingle('reports', { select: '*', id: `eq.${reportId}`, limit: 1 });
      } else if (submissionId) {
        const reports = await restSelect('reports', { select: '*', submission_id: `eq.${submissionId}`, order: 'created_at.desc', limit: 1 });
        report = Array.isArray(reports) ? reports[0] || null : null;
      }
      if (!report) return respondError(res, 404, 'not-found', 'Report not found');
      const file = await storageDownload({ bucket: 'reports', objectPath: report.report_file_url });
      res.statusCode = 200;
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(report.report_file_url)}"`);
      return res.end(file.buffer);
    }

    return respondError(res, 400, 'kind', 'Unknown file kind');
  } catch (error) {
    console.error('[gnomeo admin file] request failed:', error);
    return respondError(res, 500, 'supabase', mapSchemaError(error));
  }
};
