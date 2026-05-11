const { randomUUID } = require('crypto');
const { ensureConfig, restInsert } = require('./_supabase');
const { normalizeEmail } = require('./_limits');

const MAX_TEXT = {
  name: 120,
  email: 254,
  company: 160,
  website: 2048,
  reviewGoal: 2000,
  notes: 2000,
};

const ALLOWED_SPEND_RANGES = new Set([
  'under-5k',
  '5k-20k',
  '20k-50k',
  '50k-plus',
  'prefer-not-to-say',
]);

const ALLOWED_PLATFORMS = new Set(['Google Ads', 'Meta Ads']);

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

const respond = (res, statusCode, payload) => res.status(statusCode).json(payload);

const cleanText = (value, maxLength) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > maxLength) throw new Error(`Text field is too long (max ${maxLength} characters).`);
  return text;
};

const normalizeWebsite = (value) => {
  const raw = cleanText(value, MAX_TEXT.website);
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Website must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Website must be a valid URL.');
  }
  return parsed.toString().replace(/\/$/, '');
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
};

const parsePlatforms = (value) => {
  const items = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

  const normalized = [...new Set(items.map((item) => String(item).trim()).filter((item) => ALLOWED_PLATFORMS.has(item)))];
  if (!normalized.length) {
    throw new Error('Select at least one ad platform.');
  }
  return normalized;
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const sendResendEmail = async ({ apiKey, to, subject, html, text }) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'Gnomeo <onboarding@resend.dev>',
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

module.exports = async (req, res) => {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { success: false, error: 'Method not allowed' });
  }

  const rawBuffer = await readRequestBuffer(req);
  const contentType = String(getHeader(req, 'content-type') || '').toLowerCase();
  if (!/json/i.test(contentType)) {
    return respond(res, 415, { success: false, error: 'JSON body required' });
  }

  const body = await parseJsonBody(req, rawBuffer);
  if (!body || typeof body !== 'object') {
    return respond(res, 400, { success: false, error: 'Invalid JSON payload' });
  }

  let payload;
  try {
    const name = cleanText(body.name, MAX_TEXT.name);
    const email = normalizeEmail(cleanText(body.email, MAX_TEXT.email)).toLowerCase();
    const company = cleanText(body.company, MAX_TEXT.company);
    const website = normalizeWebsite(body.website);
    const platforms = parsePlatforms(body.platforms);
    const monthlySpendRange = cleanText(body.monthly_spend_range, 80);
    const isAgency = parseBoolean(body.is_agency);
    const reviewGoal = cleanText(body.review_goal, MAX_TEXT.reviewGoal);
    const notes = cleanText(body.notes, MAX_TEXT.notes) || null;
    const consent = parseBoolean(body.consent);

    if (!name) throw new Error('Name is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email is required and must be valid.');
    if (!company) throw new Error('Company or business name is required.');
    if (!website) throw new Error('Website is required.');
    if (!monthlySpendRange) throw new Error('Monthly ad spend range is required.');
    if (!ALLOWED_SPEND_RANGES.has(monthlySpendRange)) throw new Error('Monthly ad spend range is not valid.');
    if (isAgency === null) throw new Error('Please confirm whether you are an agency.');
    if (!reviewGoal) throw new Error('Tell us what you want reviewed.');
    if (!consent) throw new Error('Consent is required.');

    payload = {
      id: randomUUID(),
      name,
      email,
      company,
      website,
      platforms,
      monthly_spend_range: monthlySpendRange,
      is_agency: isAgency,
      review_goal: reviewGoal,
      notes,
      status: 'new',
      source: 'workspace_beta',
      consent_at: new Date().toISOString(),
    };
  } catch (error) {
    return respond(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }

  try {
    ensureConfig();
  } catch (error) {
    return respond(res, 500, { success: false, error: 'Server configuration is missing.' });
  }

  let inserted;
  try {
    [inserted] = await restInsert('beta_requests', payload);
  } catch (error) {
    console.error('[gnomeo beta-request] storage failed:', error instanceof Error ? error.message : String(error));
    return respond(res, 500, { success: false, error: 'Unable to store your request right now.' });
  }

  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim();
  const resendKey = String(process.env.RESEND_API_KEY || '').trim();
  let notificationSent = false;
  let notificationNote = 'stored';

  if (adminEmail && resendKey) {
    const subject = `New Gnomeo beta request: ${payload.company}`;
    const text = [
      `Name: ${payload.name}`,
      `Email: ${payload.email}`,
      `Company: ${payload.company}`,
      `Website: ${payload.website}`,
      `Platforms: ${payload.platforms.join(', ')}`,
      `Monthly spend range: ${payload.monthly_spend_range}`,
      `Agency: ${payload.is_agency ? 'yes' : 'no'}`,
      `Review goal: ${payload.review_goal}`,
      `Notes: ${payload.notes || '—'}`,
      `Consent at: ${payload.consent_at}`,
      `Request ID: ${payload.id}`,
    ].join('\n');
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
        <p><strong>Name:</strong> ${escapeHtml(payload.name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(payload.email)}</p>
        <p><strong>Company:</strong> ${escapeHtml(payload.company)}</p>
        <p><strong>Website:</strong> ${escapeHtml(payload.website)}</p>
        <p><strong>Platforms:</strong> ${escapeHtml(payload.platforms.join(', '))}</p>
        <p><strong>Monthly spend range:</strong> ${escapeHtml(payload.monthly_spend_range)}</p>
        <p><strong>Agency:</strong> ${payload.is_agency ? 'Yes' : 'No'}</p>
        <p><strong>Review goal:</strong> ${escapeHtml(payload.review_goal)}</p>
        ${payload.notes ? `<p><strong>Notes:</strong> ${escapeHtml(payload.notes)}</p>` : ''}
        <p><strong>Consent at:</strong> ${escapeHtml(payload.consent_at)}</p>
        <p><strong>Request ID:</strong> ${escapeHtml(payload.id)}</p>
        <p>Manual next step: review the request, create the workspace, then send the private portal link.</p>
      </div>
    `;

    try {
      await sendResendEmail({ apiKey: resendKey, to: adminEmail, subject, html, text });
      notificationSent = true;
      notificationNote = 'stored and emailed';
    } catch (error) {
      console.warn('[gnomeo beta-request] notification email failed (non-blocking):', error instanceof Error ? error.message : String(error));
    }
  } else {
    notificationNote = 'stored without email notification';
  }

  return respond(res, 201, {
    success: true,
    request: {
      id: inserted?.id || payload.id,
      created_at: inserted?.created_at || payload.consent_at,
      status: inserted?.status || payload.status,
    },
    notification_sent: notificationSent,
    note: notificationNote,
  });
};
