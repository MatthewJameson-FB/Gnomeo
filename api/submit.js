const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENT_SCRIPT = path.join(REPO_ROOT, 'agent_mvp', 'agent_test.py');
const SAMPLE_DATA = path.join(REPO_ROOT, 'agent_mvp', 'sample_ads_data.csv');

const readRequestBuffer = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const getHeader = (req, name) => {
  const target = String(name).toLowerCase();
  const headers = req.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
};

const parseContentDisposition = (value = '') => {
  const result = {};
  for (const part of value.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    if (!rawValue) continue;
    const key = rawKey.trim().toLowerCase();
    const cleaned = rawValue.trim().replace(/^"|"$/g, '');
    result[key] = cleaned;
  }
  return result;
};

const parseMultipartForm = (buffer, contentType) => {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) return { fields: {}, file: null };

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const delimiter = `--${boundary}`;
  const body = buffer.toString('utf8');
  const segments = body.split(delimiter);
  const fields = {};
  let file = null;

  for (const segment of segments) {
    const trimmed = segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!trimmed || trimmed === '--') continue;

    const splitIndex = trimmed.indexOf('\r\n\r\n');
    if (splitIndex === -1) continue;

    const headerBlock = trimmed.slice(0, splitIndex);
    const valueBlock = trimmed.slice(splitIndex + 4);
    const headerLines = headerBlock.split('\r\n');
    const headers = {};

    for (const line of headerLines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition']);
    const fieldName = disposition.name;
    if (!fieldName) continue;

    const content = valueBlock.replace(/\r\n$/, '');
    if (disposition.filename) {
      file = {
        fieldName,
        filename: disposition.filename,
        contentType: headers['content-type'] || 'text/csv',
        content,
      };
    } else {
      fields[fieldName] = content;
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

const safeFilename = (filename) => {
  const base = path.basename(filename || 'gnomeo-analysis.csv');
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'gnomeo-analysis.csv';
};

const makeTempWorkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gnomeo-'));

const ensureInputFile = ({ file, filename }) => {
  const workdir = makeTempWorkdir();
  const inputName = safeFilename(filename || file?.filename || 'gnomeo-analysis.csv');
  const inputPath = path.join(workdir, inputName);

  if (file?.content) {
    fs.writeFileSync(inputPath, file.content, 'utf8');
  } else {
    fs.copyFileSync(SAMPLE_DATA, inputPath);
  }

  return { workdir, inputPath, inputName };
};

const runAgent = ({ inputPath, outputReportPath, outputHtmlPath }) => {
  execFileSync(
    'python3',
    [AGENT_SCRIPT, '--graph', inputPath, '--output-report', outputReportPath, '--output-html', outputHtmlPath],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }
  );
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatInline = (value) =>
  escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

function convert_report_to_html(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${formatInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    blocks.push(`<${tag}>${listItems.map((item) => `<li>${formatInline(item)}</li>`).join('')}</${tag}>`);
    listType = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      continue;
    }

    if (bullet || numbered) {
      flushParagraph();
      const nextType = bullet ? 'ul' : 'ol';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((bullet || numbered)[1]);
      continue;
    }

    if (listType) flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gnomeo analysis report</title>
    <style>
      body {
        margin: 0;
        padding: 32px 20px;
        background: #f7f8fb;
        color: #0f172a;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.6;
      }
      .page {
        max-width: 900px;
        margin: 0 auto;
        background: #fff;
        border: 1px solid #e6e8ef;
        border-radius: 20px;
        padding: 32px;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
      }
      h1, h2, h3 { line-height: 1.2; letter-spacing: -0.03em; margin: 1.2em 0 0.45em; }
      h1 { margin-top: 0; }
      p { margin: 0.6em 0; }
      ul, ol { padding-left: 1.3rem; }
      li { margin: 0.25rem 0; }
      code {
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        padding: 0.1rem 0.35rem;
        border-radius: 6px;
        font-size: 0.95em;
      }
      strong { font-weight: 700; }
    </style>
  </head>
  <body>
    <main class="page">
      ${blocks.join('\n      ')}
    </main>
  </body>
</html>`;
}

const sendResendEmail = async ({ apiKey, to, subject, html, text, attachments = [] }) => {
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
      attachments,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Resend request failed');
  }
};

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({
    success: false,
    step,
    error,
  });

const respondSuccess = (res, data = {}) =>
  res.status(200).json({
    success: true,
    ...data,
  });

const buildUserEmail = ({ email, filename, timestamp }) => {
  const intro = `Your Gnomeo analysis for ${escapeHtml(filename)} is ready.`;
  const meta = [
    `Submitted: ${escapeHtml(timestamp || 'not provided')}`,
    `Email: ${escapeHtml(email)}`,
  ];

  return {
    subject: 'Your Gnomeo analysis',
    html: `
      <div style="font-family: Inter, Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <h1 style="margin:0 0 12px; font-size: 24px;">${intro}</h1>
        <p style="margin:0 0 12px;">Attached is your generated HTML report.</p>
        <p style="margin:0 0 18px; color:#475569; font-size:14px;">${meta.join('<br />')}</p>
        <hr style="border:0; border-top:1px solid #e2e8f0; margin: 20px 0;" />
      </div>
    `,
    text: [
      `Your Gnomeo analysis for ${filename} is ready.`,
      '',
      `Submitted: ${timestamp || 'not provided'}`,
      `Email: ${email}`,
      '',
      'Attached: output_report.html',
    ].join('\n'),
  };
};

const buildFallbackEmail = ({ filename }) => ({
  subject: 'Your Gnomeo analysis',
  html: `
    <div style="font-family: Inter, Arial, sans-serif; color: #0f172a; line-height: 1.6;">
      <p>Something went wrong generating your report — we’ll follow up shortly.</p>
      <p style="color:#475569; font-size:14px;">File: ${escapeHtml(filename)}</p>
    </div>
  `,
  text: `Something went wrong generating your report — we’ll follow up shortly.\nFile: ${filename}`,
});

const buildAdminEmail = ({ email, filename, timestamp, status, details }) => ({
  subject: status === 'failed' ? 'Gnomeo report generation failed' : 'New Gnomeo Free Analysis Submission',
  text: [
    `Status: ${status}`,
    `User email: ${email}`,
    `File name: ${filename}`,
    `Timestamp: ${timestamp || 'not provided'}`,
    details ? `Details: ${details}` : null,
  ]
    .filter(Boolean)
    .join('\n'),
  html: `
    <div style="font-family: Inter, Arial, sans-serif; color: #0f172a; line-height: 1.6;">
      <h1 style="margin:0 0 12px; font-size:20px;">Gnomeo submission ${escapeHtml(status)}</h1>
      <p style="margin:0 0 6px;"><strong>User email:</strong> ${escapeHtml(email)}</p>
      <p style="margin:0 0 6px;"><strong>File name:</strong> ${escapeHtml(filename)}</p>
      <p style="margin:0 0 6px;"><strong>Timestamp:</strong> ${escapeHtml(timestamp || 'not provided')}</p>
      ${details ? `<p style="margin:12px 0 0;"><strong>Details:</strong><br />${escapeHtml(details).replace(/\n/g, '<br />')}</p>` : ''}
    </div>
  `,
});

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
    console.error('[gnomeo submit] invalid payload');
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

  const { workdir, inputPath } = ensureInputFile({ file: uploadedFile, filename });
  const outputReportPath = path.join(workdir, 'output_report.md');
  const outputHtmlPath = path.join(workdir, 'output_report.html');
  const pythonCommand = ['python3', AGENT_SCRIPT, '--graph', inputPath, '--output-report', outputReportPath, '--output-html', outputHtmlPath];

  try {
    console.log('[gnomeo submit] python command being executed:', pythonCommand.join(' '));
    runAgent({ inputPath, outputReportPath, outputHtmlPath });
    console.log('[gnomeo submit] report generation success');

    const reportMarkdown = fs.readFileSync(outputReportPath, 'utf8');
    const reportHtml = fs.existsSync(outputHtmlPath)
      ? fs.readFileSync(outputHtmlPath, 'utf8')
      : convert_report_to_html(reportMarkdown);
    if (!fs.existsSync(outputHtmlPath)) {
      fs.writeFileSync(outputHtmlPath, reportHtml, 'utf8');
    }

    const userEmail = buildUserEmail({ email, filename: filename || path.basename(inputPath), timestamp });
    const attachment = {
      filename: 'output_report.html',
      content: Buffer.from(reportHtml, 'utf8').toString('base64'),
    };

    await sendResendEmail({
      apiKey,
      to: email,
      subject: userEmail.subject,
      html: userEmail.html,
      text: userEmail.text,
      attachments: [attachment],
    });
    console.log('[gnomeo submit] resend success: user email');

    try {
      const adminSuccess = buildAdminEmail({ email, filename, timestamp, status: 'completed' });
      await sendResendEmail({
        apiKey,
        to: adminEmail,
        subject: adminSuccess.subject,
        text: adminSuccess.text,
        html: adminSuccess.html,
      });
      console.log('[gnomeo submit] resend success: admin email');
    } catch (adminError) {
      console.error('[gnomeo submit] resend failure: admin email', adminError);
    }

    return respondSuccess(res, {
      step: 'complete',
      reportHtmlPath: outputHtmlPath,
    });
  } catch (error) {
    const agentError = error instanceof Error ? error.message : String(error || 'Unknown error');
    console.error('[gnomeo submit] report generation failure:', agentError);

    const fallback = buildFallbackEmail({ filename: filename || path.basename(inputPath) });
    try {
      await sendResendEmail({
        apiKey,
        to: email,
        subject: fallback.subject,
        html: fallback.html,
        text: fallback.text,
      });
      console.log('[gnomeo submit] resend success: fallback user email');
    } catch (fallbackEmailError) {
      console.error('[gnomeo submit] resend failure: fallback user email', fallbackEmailError);
    }

    const adminFailure = buildAdminEmail({ email, filename: filename || path.basename(inputPath), timestamp, status: 'failed', details: agentError });
    try {
      await sendResendEmail({
        apiKey,
        to: adminEmail,
        subject: adminFailure.subject,
        text: adminFailure.text,
        html: adminFailure.html,
      });
      console.log('[gnomeo submit] resend success: admin failure email');
    } catch (adminError) {
      console.error('[gnomeo submit] resend failure: admin failure email', adminError);
    }

    return respondError(res, 500, 'report-generation', agentError);
  }
};

module.exports.convert_report_to_html = convert_report_to_html;
