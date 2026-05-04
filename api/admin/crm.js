const fs = require('fs');
const path = require('path');
const { parseMultipartForm } = require('../_multipart');
const {
  generateId,
  restSelect,
  restSingle,
  restInsert,
  restUpdate,
  storageUpload,
  storageDownload,
} = require('../_supabase');

const TEMPLATE_PATH = path.join(process.cwd(), 'agent_mvp', 'report_email_template.txt');
const REPORTS_BUCKET = 'reports';
const CSV_BUCKET = 'submissions';
const ADMIN_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD || 'gnomeo-admin';

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({ success: false, step, error });

const requireAdmin = (req) => String(req.headers['x-admin-password'] || '').trim() === ADMIN_PASSWORD;

const safeName = (value) => String(value || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-');

const latest = (items) => (Array.isArray(items) && items.length ? items[0] : null);

const fetchCRMData = async () => {
  const [customers, submissions, reports, emailEvents] = await Promise.all([
    restSelect('customers', { select: '*', order: 'created_at.desc' }),
    restSelect('submissions', { select: '*', order: 'created_at.desc' }),
    restSelect('reports', { select: '*', order: 'created_at.desc' }),
    restSelect('email_events', { select: '*', order: 'sent_at.desc' }),
  ]);

  return { customers, submissions, reports, emailEvents };
};

const bundleSubmission = (submission, customers, reports, emailEvents) => {
  const customer = customers.find((item) => item.id === submission.customer_id) || null;
  const submissionReports = reports.filter((item) => item.submission_id === submission.id);
  const submissionEvents = emailEvents.filter((item) => item.submission_id === submission.id);
  return {
    submission,
    customer,
    reports: submissionReports,
    email_events: submissionEvents,
    id: submission.id,
    original_filename: submission.original_filename,
    notes: submission.notes,
    status: submission.status,
    created_at: submission.created_at,
    customer_email: customer?.email || '',
    customer_status: customer?.status || 'lead',
  };
};

const loadTemplate = () => {
  const fallback = [
    'Subject: Your Gnomeo analysis',
    '',
    'Hey — I’ve run your data through Gnomeo.',
    '',
    'Attached is your report.',
    '',
    'It highlights:',
    '- where spend is likely being wasted',
    '- 3 specific decisions we’d make',
    '- expected impact + risks',
    '',
    'A quick note on context — this is based purely on the dataset you shared.',
    '',
    'Where this gets significantly more accurate is when we layer in:',
    '- your actual business goals',
    '- margin / LTV context',
    '- and track performance week to week',
    '',
    'That’s where Gnomeo starts to learn what actually works in your account over time.',
    '',
    'Happy to walk through this or run it on a weekly basis if useful.',
    '',
    'Curious what stands out / what feels off.',
  ].join('\n');
  const text = fs.existsSync(TEMPLATE_PATH) ? fs.readFileSync(TEMPLATE_PATH, 'utf8') : fallback;
  const lines = text.split(/\r?\n/);
  const hasSubject = lines[0]?.toLowerCase().startsWith('subject:');
  const body = hasSubject ? lines.slice(1).join('\n').trim() : text.trim();
  const safeSubject = hasSubject ? (lines[0].split(':').slice(1).join(':').trim() || 'Your Gnomeo analysis') : 'Your Gnomeo analysis';
  return { subject: safeSubject, body };
};

const buildEmailHtml = (body) => {
  const blocks = body.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const parts = blocks.map((block) => {
    const lines = block.split(/\n/).filter(Boolean);
    if (lines.every((line) => line.trim().startsWith('-'))) {
      return `<ul>${lines.map((line) => `<li>${line.replace(/^[-]\s*/, '')}</li>`).join('')}</ul>`;
    }
    return `<p>${block.replace(/\n/g, '<br />')}</p>`;
  });
  return `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">${parts.join('')}</div>`;
};

const resendSend = async ({ to, subject, body, attachments = [] }) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is missing');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Gnomeo <reports@gnomeo.nl>',
      reply_to: 'matt@gnomeo.nl',
      to: Array.isArray(to) ? to : [to],
      subject,
      html: buildEmailHtml(body),
      text: body,
      attachments,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
};

const ensureCustomer = async ({ email, company, notes }) => {
  const existing = await restSingle('customers', { select: '*', email: `eq.${email}`, limit: 1 });
  if (existing) return existing;
  const [created] = await restInsert('customers', {
    id: generateId(),
    email,
    company: company || null,
    status: 'lead',
    notes: notes || 'Created from public submission form.',
  });
  return created;
};

const listView = async () => {
  const { customers, submissions, reports, emailEvents } = await fetchCRMData();
  return submissions.map((submission) => bundleSubmission(submission, customers, reports, emailEvents));
};

const detailView = async (id) => {
  const [submission, customers, reports, emailEvents] = await Promise.all([
    restSingle('submissions', { select: '*', id: `eq.${id}`, limit: 1 }),
    restSelect('customers', { select: '*' }),
    restSelect('reports', { select: '*', order: 'created_at.desc' }),
    restSelect('email_events', { select: '*', order: 'sent_at.desc' }),
  ]);
  if (!submission) return null;
  return bundleSubmission(submission, customers, reports, emailEvents);
};

module.exports = async (req, res) => {
  if (!requireAdmin(req)) {
    return respondError(res, 401, 'auth', 'Unauthorized');
  }

  const query = req.query || {};
  const view = String(query.view || 'list');

  if (req.method === 'GET') {
    if (view === 'list') {
      return res.status(200).json({ success: true, submissions: await listView() });
    }
    if (view === 'detail') {
      const detail = await detailView(String(query.id || ''));
      if (!detail) return respondError(res, 404, 'not-found', 'Submission not found');
      return res.status(200).json({ success: true, ...detail });
    }
    return respondError(res, 400, 'view', 'Unknown view');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return respondError(res, 405, 'method', 'Method not allowed');
  }

  let body = {};
  let upload = null;
  const contentType = String(req.headers['content-type'] || '');
  const raw = await new Promise(async (resolve) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    resolve(Buffer.concat(chunks));
  });

  if (/multipart\/form-data/i.test(contentType)) {
    const parsed = parseMultipartForm(raw, contentType);
    body = parsed.fields || {};
    upload = parsed.file;
  } else if (raw.length) {
    try { body = JSON.parse(raw.toString('utf8')); } catch { body = {}; }
  }

  const action = String(body.action || '').trim();

  if (action === 'update-status') {
    const submissionId = String(body.submission_id || '').trim();
    const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
    if (!submission) return respondError(res, 404, 'not-found', 'Submission not found');
    const customer = await restSingle('customers', { select: '*', id: `eq.${submission.customer_id}`, limit: 1 });
    const updatedSubmission = await restUpdate('submissions', { id: `eq.${submissionId}` }, {
      status: body.submission_status || submission.status,
      notes: body.submission_notes ?? submission.notes,
    });
    const updatedCustomer = customer
      ? await restUpdate('customers', { id: `eq.${customer.id}` }, {
          status: body.customer_status || customer.status,
          notes: body.customer_notes ?? customer.notes,
        })
      : [];
    return res.status(200).json({ success: true, submission: updatedSubmission[0], customer: updatedCustomer[0] || customer });
  }

  if (action === 'upload-report') {
    const submissionId = String(body.submission_id || '').trim();
    const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
    if (!submission) return respondError(res, 404, 'not-found', 'Submission not found');
    if (!upload || !upload.filename) return respondError(res, 400, 'file', 'Report file is required');
    if (!/\.(html?|pdf)$/i.test(upload.filename)) return respondError(res, 400, 'file', 'Report must be HTML or PDF');

    const reportId = generateId();
    const reportName = `${Date.now()}-${safeName(upload.filename)}`;
    const reportPath = `reports/${submissionId}/${reportName}`;
    await storageUpload({
      bucket: REPORTS_BUCKET,
      objectPath: reportPath,
      content: Buffer.from(upload.content, 'latin1'),
      contentType: upload.contentType || (upload.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8'),
      upsert: true,
    });

    const [reportRow] = await restInsert('reports', {
      id: reportId,
      submission_id: submissionId,
      report_file_url: reportPath,
      summary: String(body.summary || '').trim() || null,
      sent_at: null,
    });

    await restUpdate('submissions', { id: `eq.${submissionId}` }, { status: 'report_ready' });
    return res.status(200).json({ success: true, report: reportRow, report_path: reportPath });
  }

  if (action === 'send-report') {
    const submissionId = String(body.submission_id || '').trim();
    const submission = await restSingle('submissions', { select: '*', id: `eq.${submissionId}`, limit: 1 });
    if (!submission) return respondError(res, 404, 'not-found', 'Submission not found');
    const customer = await restSingle('customers', { select: '*', id: `eq.${submission.customer_id}`, limit: 1 });
    const reports = await restSelect('reports', { select: '*', submission_id: `eq.${submissionId}`, order: 'created_at.desc', limit: 1 });
    const report = latest(reports);
    if (!report) return respondError(res, 400, 'report', 'No report uploaded yet');

    const downloaded = await storageDownload({ bucket: REPORTS_BUCKET, objectPath: report.report_file_url });
    const template = loadTemplate();
    const attachment = {
      filename: path.basename(report.report_file_url),
      content: downloaded.buffer.toString('base64'),
    };

    await resendSend({
      to: customer?.email,
      subject: template.subject,
      body: template.body,
      attachments: [attachment],
    });

    const sentAt = new Date().toISOString();
    await restUpdate('submissions', { id: `eq.${submissionId}` }, { status: 'report_sent' });
    await restUpdate('reports', { id: `eq.${report.id}` }, { sent_at: sentAt });
    await restInsert('email_events', {
      id: generateId(),
      customer_id: customer?.id || null,
      submission_id: submissionId,
      type: 'report_sent',
      status: 'sent',
      sent_at: sentAt,
    });
    return res.status(200).json({ success: true, sent_at: sentAt });
  }

  return respondError(res, 400, 'action', 'Unknown action');
};
