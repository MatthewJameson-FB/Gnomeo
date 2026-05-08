const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { parseMultipartForm } = require('./_multipart');
const {
  FREE_REPORT_LIMITS,
  normalizeEmail,
  hashValue,
  getClientIp,
  validateCsvUploads,
} = require('./_limits');
const {
  ensureConfig,
  restSingle,
  restInsert,
  restUpdate,
  storageUpload,
  storageDelete,
} = require('./_supabase');

const DATA_PATH = path.join(process.cwd(), 'data', 'submissions.json');
const FREE_USAGE_PATH = path.join(process.cwd(), 'data', 'free_snapshot_usage.json');
const IS_PRODUCTION = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
const HAS_SUPABASE = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const CSV_BUCKET = 'submissions';
const ADMIN_PASSWORD_FALLBACK = 'gnomeo-admin';
const MAX_UPLOAD_FILES = FREE_REPORT_LIMITS.maxFiles;
const MAX_UPLOAD_BYTES = FREE_REPORT_LIMITS.maxFileBytes;

const getHeader = (req, name) => {
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
};

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

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({ success: false, step, error });

const respondSuccess = (res, data = {}) =>
  res.status(200).json({ success: true, ...data });

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const resolveSender = () => {
  const configured = String(process.env.RESEND_FROM || '').trim();
  if (configured) return configured;
  return process.env.VERCEL_ENV ? 'Gnomeo <reports@gnomeo.nl>' : 'Gnomeo <onboarding@resend.dev>';
};

const sendResendEmail = async ({ apiKey, to, subject, html, text, reply_to, attachments }) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resolveSender(),
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      reply_to,
      attachments,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
};

const ensureDataDir = () => fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });

const readSubmissions = () => {
  try {
    if (!fs.existsSync(DATA_PATH)) return [];
    const raw = fs.readFileSync(DATA_PATH, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[gnomeo submit] submissions read failed:', error);
    return [];
  }
};

const writeSubmissions = (submissions) => {
  ensureDataDir();
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(submissions, null, 2)}\n`);
};

const localLogSubmission = (entry) => {
  if (IS_PRODUCTION) return;
  try {
    const submissions = readSubmissions();
    submissions.unshift(entry);
    writeSubmissions(submissions);
    console.log('[gnomeo submit] submission stored:', entry.submission_id);
  } catch (error) {
    console.error('[gnomeo submit] submission store failed (non-blocking):', error);
  }
};

const createSubmissionRecord = ({ submissionId, customerId, originalFilename, csvPath, timestamp }) => ({
  id: submissionId,
  customer_id: customerId,
  original_filename: originalFilename || 'not provided',
  csv_file_url: csvPath,
  status: 'received',
  created_at: timestamp || new Date().toISOString(),
  notes: 'Submitted from public form.',
});

const createLocalLogEntry = ({ submissionId, customerEmail, originalFilename, csvPath, timestamp }) => ({
  submission_id: submissionId,
  user_email: customerEmail,
  original_filename: originalFilename,
  uploaded_file_path: csvPath,
  timestamp,
  status: 'received',
  notes: 'Waiting for manual report generation.',
});

const readFreeUsageState = () => {
  try {
    if (!fs.existsSync(FREE_USAGE_PATH)) return { entries: [] };
    const raw = fs.readFileSync(FREE_USAGE_PATH, 'utf8').trim();
    if (!raw) return { entries: [] };
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { entries: [] };
  } catch (error) {
    console.error('[gnomeo submit] free usage read failed:', error);
    return { entries: [] };
  }
};

const writeFreeUsageState = (state) => {
  ensureDataDir();
  const payload = {
    entries: Array.isArray(state?.entries) ? state.entries : [],
  };
  fs.writeFileSync(FREE_USAGE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
};

const monthStartUtc = (value) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
const dayStartUtc = (value) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

const pruneFreeUsageEntries = (entries, cutoffMs) => entries.filter((entry) => {
  const timestamp = Date.parse(entry?.timestamp || '');
  return Number.isFinite(timestamp) ? timestamp >= cutoffMs : true;
});

const assessFreeSnapshotUsage = ({ emailHash, ipHash, now = new Date() } = {}) => {
  const state = readFreeUsageState();
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const monthStart = monthStartUtc(now);
  const dayStart = dayStartUtc(now);
  const monthCount = entries.filter((entry) => entry.emailHash === emailHash && Date.parse(entry.timestamp || '') >= monthStart.getTime()).length;
  const dayCount = entries.filter((entry) => entry.ipHash === ipHash && Date.parse(entry.timestamp || '') >= dayStart.getTime()).length;

  if (monthCount >= FREE_REPORT_LIMITS.maxReportsPerMonth) {
    return { ok: false, error: 'Free snapshots are limited to 2 reports per month per email. Please use a Pro workspace for more.' };
  }
  if (dayCount >= FREE_REPORT_LIMITS.maxReportsPerDayByIp) {
    return { ok: false, error: 'Free snapshots are limited to 1 report per day per IP. Please try again tomorrow or use a Pro workspace.' };
  }

  return { ok: true, monthCount, dayCount };
};

const recordFreeSnapshotUsage = ({ emailHash, ipHash, fileCount, rowCount, status = 'sent', now = new Date() } = {}) => {
  try {
    const state = readFreeUsageState();
    const cutoffMs = now.getTime() - (90 * 24 * 60 * 60 * 1000);
    const entries = pruneFreeUsageEntries(Array.isArray(state.entries) ? state.entries : [], cutoffMs);
    entries.unshift({
      plan: 'free',
      planLabel: FREE_REPORT_LIMITS.planLabel,
      emailHash,
      ipHash,
      timestamp: now.toISOString(),
      status,
      fileCount,
      rowCount,
    });
    writeFreeUsageState({ entries });
  } catch (error) {
    console.error('[gnomeo submit] free usage record failed (non-blocking):', error);
  }
};

const cleanFilename = (value) => String(value || 'submission.csv').replace(/[^a-zA-Z0-9._-]+/g, '_');

const upsertCustomer = async ({ email }) => {
  const existing = await restSingle('customers', { select: '*', email: `eq.${email}`, limit: 1 });
  if (existing) return existing;
  const [created] = await restInsert('customers', {
    id: randomUUID(),
    email,
    company: null,
    status: 'lead',
    notes: 'Created from public submission form.',
  });
  return created;
};

const logEmailEvent = async ({ customerId, submissionId, type, status }) => {
  if (!HAS_SUPABASE) return;
  try {
    await restInsert('email_events', {
      id: randomUUID(),
      customer_id: customerId,
      submission_id: submissionId,
      type,
      status,
      sent_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[gnomeo submit] email event log failed (non-blocking):', error);
  }
};

const cleanupSubmissionCsvs = async (objectPaths) => {
  if (!IS_PRODUCTION || !HAS_SUPABASE) return false;
  const uniquePaths = [...new Set((Array.isArray(objectPaths) ? objectPaths : [objectPaths]).filter(Boolean))];
  if (!uniquePaths.length) return false;
  let deleted = false;
  for (const objectPath of uniquePaths) {
    try {
      await storageDelete({ bucket: CSV_BUCKET, objectPath });
      deleted = true;
    } catch (error) {
      console.warn('[gnomeo submit] csv cleanup failed (non-blocking):', error);
    }
  }
  return deleted;
};

const listUploadedFiles = (parsed) => {
  if (Array.isArray(parsed?.files) && parsed.files.length) return parsed.files;
  if (parsed?.file) return [parsed.file];
  return [];
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respondError(res, 405, 'method', 'Method not allowed');
  }

  const contentType = getHeader(req, 'content-type');
  console.log('[gnomeo submit] request method:', req.method);
  console.log('[gnomeo submit] content-type:', contentType || '(missing)');

  const rawBuffer = await readRequestBuffer(req);
  let body = {};
  let uploadedFiles = [];

  if (/multipart\/form-data/i.test(contentType)) {
    const parsed = parseMultipartForm(rawBuffer, contentType);
    body = parsed.fields || {};
    uploadedFiles = listUploadedFiles(parsed);
  } else {
    body = await parseJsonBody(req, rawBuffer) || {};
    uploadedFiles = listUploadedFiles(body);
  }

  if (!body || typeof body !== 'object') {
    return respondError(res, 400, 'request-body', 'Invalid request payload');
  }

  uploadedFiles = uploadedFiles
    .map((file, index) => ({
      ...file,
      filename: String(file?.filename || body.filename || `submission-${index + 1}.csv`).trim(),
    }))
    .filter((file) => file.filename);

  const email = String(body.email || '').trim();
  const timestamp = String(body.timestamp || '').trim();
  const originalFilename = uploadedFiles.map((file) => file.filename).join(', ');

  console.log('[gnomeo submit] email received:', Boolean(email));
  console.log('[gnomeo submit] file count received:', uploadedFiles.length);
  console.log('[gnomeo submit] file names:', originalFilename || '(missing)');

  if (!email) return respondError(res, 400, 'validation', 'Email is required');
  if (!uploadedFiles.length) return respondError(res, 400, 'file-upload', 'CSV file is required');

  const csvBuffers = uploadedFiles.map((file) => Buffer.from(file.content || '', 'latin1'));
  const validation = validateCsvUploads({ files: uploadedFiles, buffers: csvBuffers, limits: FREE_REPORT_LIMITS });
  if (!validation.ok) {
    return respondError(res, 400, 'file-upload', validation.error);
  }

  const requestIp = getClientIp(req);
  const emailHash = hashValue(normalizeEmail(email));
  const ipHash = hashValue(requestIp);
  const rateLimitCheck = assessFreeSnapshotUsage({ emailHash, ipHash, now: new Date() });
  if (!rateLimitCheck.ok) {
    return respondError(res, 429, 'rate-limit', rateLimitCheck.error);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!apiKey || !adminEmail) {
    return respondError(res, 500, 'configuration', 'Server email configuration is missing');
  }
  if (IS_PRODUCTION && !HAS_SUPABASE) {
    return respondError(res, 500, 'configuration', 'Supabase configuration is missing');
  }

  const submissionId = randomUUID();
  console.log('[gnomeo submit] submission_id generated:', submissionId);
  const csvPaths = [];
  let customer = { id: randomUUID(), email };
  let supabaseLoggingError = null;

  if (HAS_SUPABASE) {
    ensureConfig();

    try {
      customer = await upsertCustomer({ email });
      console.log('[gnomeo submit] customer row created:', customer.id);
    } catch (error) {
      supabaseLoggingError = supabaseLoggingError || (error instanceof Error ? error.message : String(error));
      console.error('[gnomeo submit] supabase error details: customer row failed', error);
      customer = { id: randomUUID(), email };
    }

    for (const [index, file] of uploadedFiles.entries()) {
      const proposedCsvPath = `submissions/${submissionId}/${String(index + 1).padStart(2, '0')}-${cleanFilename(file.filename)}`;
      try {
        await storageUpload({
          bucket: CSV_BUCKET,
          objectPath: proposedCsvPath,
          content: csvBuffers[index],
          contentType: file.contentType || 'text/csv',
          upsert: true,
        });
        csvPaths.push(proposedCsvPath);
      } catch (error) {
        console.error('[gnomeo submit] step=supabase-storage csv upload failed (non-blocking):', error);
        supabaseLoggingError = supabaseLoggingError || (error instanceof Error ? error.message : String(error));
      }
    }

    const submissionRecord = createSubmissionRecord({
      submissionId,
      customerId: customer.id,
      originalFilename,
      csvPath: csvPaths[0] || null,
      timestamp: timestamp || new Date().toISOString(),
    });

    try {
      await restInsert('submissions', submissionRecord);
      console.log('[gnomeo submit] submission row created:', submissionId);
    } catch (error) {
      supabaseLoggingError = supabaseLoggingError || (error instanceof Error ? error.message : String(error));
      console.error('[gnomeo submit] supabase error details: submission row failed', error);
    }
  }

  try {
    localLogSubmission(createLocalLogEntry({
      submissionId,
      customerEmail: email,
      originalFilename,
      csvPath: csvPaths[0] || null,
      timestamp: timestamp || new Date().toISOString(),
    }));
  } catch {
    // non-blocking local/dev log only
  }

  const userSubject = 'We’re analysing your ad account';
  const userText = [
    'Hey — got your data, thanks for sending it through.',
    '',
    'We’re running it through Gnomeo now.',
    '',
    'You’ll receive a report shortly that shows:',
    '- where budget is likely being wasted',
    '- 3 decisions we’d make',
    '- expected impact + trade-offs',
    '',
    'Quick note — this is a snapshot based on the data provided.',
    '',
    'Decisions get much stronger when we include:',
    '- your business goals (growth vs efficiency)',
    '- margin / LTV context',
    '- and track performance week to week',
    '',
    'Will send the report shortly.',
  ].join('\n');

  const userHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
      <p>Hey — got your data, thanks for sending it through.</p>
      <p>We’re running it through Gnomeo now.</p>
      <p>You’ll receive a report shortly that shows:</p>
      <ul>
        <li>where budget is likely being wasted</li>
        <li>3 decisions we’d make</li>
        <li>expected impact + trade-offs</li>
      </ul>
      <p>Quick note — this is a snapshot based on the data provided.</p>
      <p>Decisions get much stronger when we include:</p>
      <ul>
        <li>your business goals (growth vs efficiency)</li>
        <li>margin / LTV context</li>
        <li>and track performance week to week</li>
      </ul>
      <p>Will send the report shortly.</p>
    </div>
  `;

  const csvStoragePathLabel = csvPaths[0] || 'storage unavailable (use the email attachment)';
  const analysisRunHint = csvPaths.length > 1
    ? 'Use the CSV attachments from the admin email to run the local report tool.'
    : (csvPaths[0]
        ? `python3 agent_mvp/agent_test.py --graph ${csvStoragePathLabel}`
        : 'Use the CSV attachment from the admin email to run the local report tool.');
  const warningLine = supabaseLoggingError ? `Supabase logging failed: ${supabaseLoggingError}` : '';
  const adminSubject = 'New Gnomeo Free Analysis Submission';
  const adminText = [
    `User email: ${email}`,
    `Submission ID: ${submissionId}`,
    `Original filename: ${originalFilename || 'not provided'}`,
    `CSV storage path: ${csvStoragePathLabel}`,
    warningLine,
    `Timestamp: ${timestamp || 'not provided'}`,
    'Run analysis manually and send report.',
    analysisRunHint,
  ].filter(Boolean).join('\n');

  const adminHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
      <p><strong>User email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Submission ID:</strong> ${escapeHtml(submissionId)}</p>
      <p><strong>Original filename:</strong> ${escapeHtml(originalFilename || 'not provided')}</p>
      <p><strong>CSV storage path:</strong> ${escapeHtml(csvStoragePathLabel)}</p>
      ${warningLine ? `<p><strong>Warning:</strong> ${escapeHtml(warningLine)}</p>` : ''}
      <p><strong>Timestamp:</strong> ${escapeHtml(timestamp || 'not provided')}</p>
      <p>Run analysis manually and send report.</p>
      <p>The CSV files are attached to this email for direct access.</p>
      <p>${escapeHtml(analysisRunHint)}</p>
    </div>
  `;

  let userEmailSent = false;
  try {
    console.log('[gnomeo submit] sending user confirmation email');
    await sendResendEmail({
      apiKey,
      to: email,
      subject: userSubject,
      html: userHtml,
      text: userText,
      reply_to: 'matt@gnomeo.nl',
    });
    userEmailSent = true;
    console.log('[gnomeo submit] resend success: user email');
    await logEmailEvent({ customerId: customer.id, submissionId, type: 'submission_confirmation', status: 'sent' });
  } catch (error) {
    console.error('[gnomeo submit] resend failure: user email', error);
    return respondError(res, 502, 'user-email', error instanceof Error ? error.message : String(error));
  } finally {
    await cleanupSubmissionCsvs(csvPaths);
  }

  if (userEmailSent) {
    recordFreeSnapshotUsage({
      emailHash,
      ipHash,
      fileCount: uploadedFiles.length,
      rowCount: validation.totalRows || 0,
      status: 'sent',
      now: new Date(),
    });
  }

  try {
    console.log('[gnomeo submit] sending admin notification email');
    await sendResendEmail({
      apiKey,
      to: adminEmail,
      subject: adminSubject,
      html: adminHtml,
      text: adminText,
      reply_to: 'matt@gnomeo.nl',
      attachments: uploadedFiles.map((file, index) => ({
        filename: file.filename,
        content: csvBuffers[index].toString('base64'),
        content_type: file.contentType || 'text/csv',
      })),
    });
    console.log('[gnomeo submit] resend success: admin email');
    await logEmailEvent({ customerId: customer.id, submissionId, type: 'submission_notification', status: 'sent' });
    await cleanupSubmissionCsvs(csvPaths);
  } catch (error) {
    console.error('[gnomeo submit] resend failure: admin email', error);
    return respondError(res, 502, 'admin-email', error instanceof Error ? error.message : String(error));
  } finally {
    await cleanupSubmissionCsvs(csvPaths);
  }

  return respondSuccess(res, {
    step: 'emails-sent',
    submission_id: submissionId,
    csv_file_url: csvPaths[0] || null,
    csv_file_urls: csvPaths,
    original_filename: originalFilename,
    warning: supabaseLoggingError ? 'supabase_logging_failed' : null,
  });
};
