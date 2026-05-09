const { buildAdminSessionCookie, createAdminSessionToken, SESSION_TTL_SECONDS } = require('../_adminAuth');

const respondError = (res, statusCode, error) => res.status(statusCode).json({ success: false, error });

const readBody = async (req) => {
  const contentType = String(req.headers['content-type'] || '');
  const raw = await new Promise(async (resolve) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    resolve(Buffer.concat(chunks));
  });
  if (!raw.length) return {};
  if (/application\/json/i.test(contentType)) {
    try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
  }
  return {};
};

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return respondError(res, 405, 'Method not allowed');
    }

    const secret = String(process.env.ADMIN_SECRET || '').trim();
    if (!secret) return respondError(res, 500, 'Admin access is not configured.');

    const body = await readBody(req);
    const candidate = String(body.secret || body.password || '').trim();
    if (!candidate || candidate !== secret) return respondError(res, 401, 'Unauthorized.');

    const token = createAdminSessionToken(secret);
    res.setHeader('Set-Cookie', buildAdminSessionCookie(token, req, SESSION_TTL_SECONDS));
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[gnomeo admin login] request failed:', error);
    return respondError(res, 500, 'Login failed');
  }
};