const parseContentDisposition = (value = '') => {
  const result = {};
  for (const part of value.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    if (!rawValue) continue;
    result[rawKey.trim().toLowerCase()] = rawValue.trim().replace(/^"|"$/g, '');
  }
  return result;
};

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

const sendResendEmail = async ({ apiKey, to, subject, html, text }) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Gnomeo <reports@gnomeo.nl>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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
  const filename = String(body.filename || uploadedFile?.filename || '').trim();
  const timestamp = String(body.timestamp || '').trim();

  console.log('[gnomeo submit] email received:', Boolean(email));
  console.log('[gnomeo submit] file received:', Boolean(uploadedFile));
  console.log('[gnomeo submit] file name:', filename || '(missing)');

  if (!email) {
    return respondError(res, 400, 'validation', 'Email is required');
  }

  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!apiKey || !adminEmail) {
    return respondError(res, 500, 'configuration', 'Server email configuration is missing');
  }

  const userSubject = 'Your Gnomeo analysis request';
  const userText = [
    'Hey — thanks for sending your data through.',
    '',
    'We\'ve received it and will run it through Gnomeo.',
    '',
    'You\'ll receive your report within 24 hours.',
    '',
    'Worth noting: this first report is a one-off snapshot. Decisions become much stronger when we include business goals, margin/LTV context, and track performance week to week.',
  ].join('\n');

  const adminSubject = 'New Gnomeo Free Analysis Submission';
  const adminText = [
    `User email: ${email}`,
    `File name: ${filename || 'not provided'}`,
    `Timestamp: ${timestamp || 'not provided'}`,
    'Run analysis manually and send report.',
  ].join('\n');

  try {
    console.log('[gnomeo submit] sending user confirmation email');
    await sendResendEmail({
      apiKey,
      to: email,
      subject: userSubject,
      html: `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;"><p>Hey — thanks for sending your data through.</p><p>We\'ve received it and will run it through Gnomeo.</p><p>You\'ll receive your report within 24 hours.</p><p>Worth noting: this first report is a one-off snapshot. Decisions become much stronger when we include business goals, margin/LTV context, and track performance week to week.</p></div>`,
      text: userText,
    });
    console.log('[gnomeo submit] resend success: user email');
  } catch (error) {
    console.error('[gnomeo submit] resend failure: user email', error);
    return respondError(res, 502, 'user-email', error instanceof Error ? error.message : String(error));
  }

  try {
    console.log('[gnomeo submit] sending admin notification email');
    await sendResendEmail({
      apiKey,
      to: adminEmail,
      subject: adminSubject,
      html: `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;"><p><strong>User email:</strong> ${escapeHtml(email)}</p><p><strong>File name:</strong> ${escapeHtml(filename || 'not provided')}</p><p><strong>Timestamp:</strong> ${escapeHtml(timestamp || 'not provided')}</p><p>Run analysis manually and send report.</p></div>`,
      text: adminText,
    });
    console.log('[gnomeo submit] resend success: admin email');
  } catch (error) {
    console.error('[gnomeo submit] resend failure: admin email', error);
    return respondError(res, 502, 'admin-email', error instanceof Error ? error.message : String(error));
  }

  return respondSuccess(res, {
    step: 'emails-sent',
  });
};
