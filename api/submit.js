const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(process.cwd(), 'data', 'submissions.json');
const TMP_DIR = '/tmp';

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

const parseContentDisposition = (value = '') => {
  const result = {};
  for (const part of value.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    if (!rawValue) continue;
    result[rawKey.trim().toLowerCase()] = rawValue.trim().replace(/^"|"$/g, '');
  }
  return result;
};

const parseMultipartForm = (buffer, contentType) => {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) return { fields: {}, file: null };

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const segments = buffer.toString('utf8').split(`--${boundary}`);
  const fields = {};
  let file = null;

  for (const segment of segments) {
    const trimmed = segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!trimmed || trimmed === '--') continue;

    const splitIndex = trimmed.indexOf('\r\n\r\n');
    if (splitIndex === -1) continue;

    const headerLines = trimmed.slice(0, splitIndex).split('\r\n');
    const value = trimmed.slice(splitIndex + 4).replace(/\r\n$/, '');
    const headers = {};

    for (const line of headerLines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition']);
    if (!disposition.name) continue;

    if (disposition.filename) {
      file = {
        fieldName: disposition.name,
        filename: disposition.filename,
        contentType: headers['content-type'] || 'text/csv',
        content: value,
      };
    } else {
      fields[disposition.name] = value;
    }
  }

  return { fields, file };
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

const sendResendEmail = async ({ apiKey, to, subject, html, text, reply_to }) => {
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
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
};

const ensureDataDir = () => {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
};

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

const createSubmission = ({ email, originalFilename, savedFilePath, timestamp }) => ({
  submission_id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  user_email: email,
  original_filename: originalFilename || 'not provided',
  uploaded_file_path: savedFilePath,
  timestamp: timestamp || new Date().toISOString(),
  status: 'received',
  notes: 'Waiting for manual report generation.',
});

const saveUploadedCsv = (file) => {
  const timestamp = Date.now();
  const filePath = path.join(TMP_DIR, `gnomeo-${timestamp}.csv`);
  fs.writeFileSync(filePath, file?.content ? Buffer.from(file.content, 'utf8') : Buffer.alloc(0));
  return filePath;
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
  let uploadedFile = null;

  if (/multipart\/form-data/i.test(contentType)) {
    const parsed = parseMultipartForm(rawBuffer, contentType);
    body = parsed.fields || {};
    uploadedFile = parsed.file;
  } else {
    body = await parseJsonBody(req, rawBuffer);
  }

  if (!body || typeof body !== 'object') {
    return respondError(res, 400, 'request-body', 'Invalid request payload');
  }

  const email = String(body.email || '').trim();
  const timestamp = String(body.timestamp || '').trim();
  const originalFilename = String(body.filename || uploadedFile?.filename || '').trim();

  console.log('[gnomeo submit] email received:', Boolean(email));
  console.log('[gnomeo submit] file received:', Boolean(uploadedFile));
  console.log('[gnomeo submit] file name:', originalFilename || '(missing)');

  if (!email) {
    return respondError(res, 400, 'validation', 'Email is required');
  }
  if (!uploadedFile) {
    return respondError(res, 400, 'file-upload', 'CSV file is required');
  }

  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!apiKey || !adminEmail) {
    return respondError(res, 500, 'configuration', 'Server email configuration is missing');
  }

  const savedFilePath = saveUploadedCsv(uploadedFile);
  console.log('[gnomeo submit] saved file path:', savedFilePath);

  const submission = createSubmission({
    email,
    originalFilename,
    savedFilePath,
    timestamp,
  });

  try {
    const submissions = readSubmissions();
    submissions.unshift(submission);
    writeSubmissions(submissions);
    console.log('[gnomeo submit] submission stored:', submission.submission_id);
  } catch (error) {
    console.error('[gnomeo submit] submission store failed:', error);
    return respondError(res, 500, 'submission-log', error instanceof Error ? error.message : String(error));
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

  const adminSubject = 'New Gnomeo Free Analysis Submission';
  const adminText = [
    `User email: ${email}`,
    `Original filename: ${originalFilename || 'not provided'}`,
    `Saved file path: ${savedFilePath}`,
    `Timestamp: ${timestamp || 'not provided'}`,
    'Run analysis manually and send report.',
    `Download or access this file and run: python3 agent_mvp/agent_test.py --graph ${savedFilePath}`,
  ].join('\n');

  const adminHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
      <p><strong>User email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Original filename:</strong> ${escapeHtml(originalFilename || 'not provided')}</p>
      <p><strong>Saved file path:</strong> ${escapeHtml(savedFilePath)}</p>
      <p><strong>Timestamp:</strong> ${escapeHtml(timestamp || 'not provided')}</p>
      <p>Run analysis manually and send report.</p>
      <p><code>python3 agent_mvp/agent_test.py --graph ${escapeHtml(savedFilePath)}</code></p>
    </div>
  `;

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
    console.log('[gnomeo submit] resend success: user email');
  } catch (error) {
    console.error('[gnomeo submit] resend failure: user email', error);
    const submissions = readSubmissions();
    const entry = submissions.find((item) => item.submission_id === submission.submission_id);
    if (entry) {
      entry.status = 'failed';
      entry.notes = `User email failed: ${error instanceof Error ? error.message : String(error)}`;
      writeSubmissions(submissions);
    }
    return respondError(res, 502, 'user-email', error instanceof Error ? error.message : String(error));
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
    });
    console.log('[gnomeo submit] resend success: admin email');
  } catch (error) {
    console.error('[gnomeo submit] resend failure: admin email', error);
    const submissions = readSubmissions();
    const entry = submissions.find((item) => item.submission_id === submission.submission_id);
    if (entry) {
      entry.status = 'failed';
      entry.notes = `Admin email failed: ${error instanceof Error ? error.message : String(error)}`;
      writeSubmissions(submissions);
    }
    return respondError(res, 502, 'admin-email', error instanceof Error ? error.message : String(error));
  }

  return respondSuccess(res, {
    step: 'emails-sent',
    submission_id: submission.submission_id,
    saved_file_reference: savedFilePath,
    original_filename: originalFilename,
  });
};
