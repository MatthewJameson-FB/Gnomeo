const path = require('path');
const { restSingle, restSelect, storageDownload } = require('../_supabase');

const ADMIN_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD || 'gnomeo-admin';

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({ success: false, step, error });

const requireAdmin = (req) => String(req.headers['x-admin-password'] || '').trim() === ADMIN_PASSWORD;

module.exports = async (req, res) => {
  if (!requireAdmin(req)) {
    return respondError(res, 401, 'auth', 'Unauthorized');
  }

  const query = req.query || {};
  const kind = String(query.kind || '').trim();

  if (kind === 'csv') {
    const submissionId = String(query.submission_id || '').trim();
    const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
    if (!submission) return respondError(res, 404, 'not-found', 'Submission not found');
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
};
