const { createHash } = require('crypto');

const MB = 1024 * 1024;

const FREE_REPORT_LIMITS = {
  planLabel: 'Free Snapshot',
  maxReportsPerMonth: 2,
  maxReportsPerDayByIp: 1,
  maxFiles: 2,
  maxFileBytes: 3 * MB,
  maxTotalRows: 5000,
  allowedPlatforms: ['google_ads', 'meta_ads'],
  recipientPolicy: 'uploader-only',
  tooManyFilesMessage: 'Free snapshots support up to 2 CSV exports per report. Pro workspaces will support more.',
  tooLargeFileMessage: 'This file is too large for a free snapshot. Please upload CSVs under 3 MB.',
  tooManyRowsMessage: 'Free snapshots support up to 5,000 rows across uploaded CSVs.',
};

const PRO_REPORT_LIMITS = {
  planLabel: 'Pro Workspace',
  maxReportsPerMonth: 20,
  maxReportsPerDayByIp: null,
  maxFiles: 5,
  maxFileBytes: 15 * MB,
  maxTotalRows: 75000,
  allowedPlatforms: ['google_ads', 'meta_ads'],
  recipientPolicy: 'workspace',
};

const AGENCY_REPORT_LIMITS = {
  planLabel: 'Agency',
  maxReportsPerMonth: 200,
  maxReportsPerDayByIp: null,
  maxFiles: 10,
  maxFileBytes: 25 * MB,
  maxTotalRows: 250000,
  allowedPlatforms: ['google_ads', 'meta_ads'],
  recipientPolicy: 'workspace',
};

const ACCEPTED_CSV_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
]);

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const hashValue = (value) => createHash('sha256').update(String(value || '').trim()).digest('hex').slice(0, 16);

const getClientIp = (req) => {
  const headers = req?.headers || {};
  const forwardedFor = headers['x-forwarded-for'] || headers['x-real-ip'] || headers['cf-connecting-ip'] || '';
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : String(forwardedFor || '');
  const forwardedIp = firstForwarded.split(',')[0].trim();
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return forwardedIp || remote || 'unknown';
};

const hasCsvExtension = (filename) => /\.csv$/i.test(String(filename || '').trim());

const hasAcceptedCsvMime = (contentType) => {
  const type = String(contentType || '').trim().toLowerCase();
  if (!type) return true;
  if (type.includes('csv')) return true;
  return ACCEPTED_CSV_MIME_TYPES.has(type);
};

const isCsvUpload = (file) => {
  if (!file) return false;
  const filename = String(file.filename || '').trim();
  const contentType = String(file.contentType || '').trim();
  return hasCsvExtension(filename) && hasAcceptedCsvMime(contentType);
};

const countCsvRows = (buffer) => {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  return Math.max(0, lines.length - 1);
};

const validateCsvUploads = ({ files = [], buffers = [], limits = FREE_REPORT_LIMITS } = {}) => {
  if (!Array.isArray(files) || !Array.isArray(buffers)) {
    return { ok: false, error: 'Invalid upload payload.' };
  }

  if (typeof limits.maxFiles === 'number' && files.length > limits.maxFiles) {
    return { ok: false, error: limits.tooManyFilesMessage || `Upload limit is ${limits.maxFiles} CSV files` };
  }

  for (const [index, file] of files.entries()) {
    if (!isCsvUpload(file)) {
      return {
        ok: false,
        error: `Unsupported file type: ${String(file?.filename || `file-${index + 1}`)}`,
      };
    }

    const buffer = buffers[index];
    if (!Buffer.isBuffer(buffer)) {
      return { ok: false, error: 'Invalid CSV file content.' };
    }

    if (typeof limits.maxFileBytes === 'number' && buffer.length > limits.maxFileBytes) {
      return {
        ok: false,
        error: limits.tooLargeFileMessage || `Each CSV must be under ${Math.round(limits.maxFileBytes / MB)}MB`,
      };
    }
  }

  const totalRows = buffers.reduce((sum, buffer) => sum + countCsvRows(buffer), 0);
  if (typeof limits.maxTotalRows === 'number' && totalRows > limits.maxTotalRows) {
    return { ok: false, error: limits.tooManyRowsMessage || `Rows exceed ${limits.maxTotalRows}` };
  }

  return { ok: true, totalRows };
};

module.exports = {
  FREE_REPORT_LIMITS,
  PRO_REPORT_LIMITS,
  AGENCY_REPORT_LIMITS,
  ACCEPTED_CSV_MIME_TYPES,
  normalizeEmail,
  hashValue,
  getClientIp,
  hasCsvExtension,
  hasAcceptedCsvMime,
  isCsvUpload,
  countCsvRows,
  validateCsvUploads,
};
