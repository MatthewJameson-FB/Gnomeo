const crypto = require('crypto');

const SESSION_COOKIE = 'gnomeo_admin_session';
const SESSION_VERSION = 'v1';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

const getHeader = (req, name) => {
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
};

const parseCookies = (req) => {
  const cookieHeader = String(getHeader(req, 'cookie') || '');
  return cookieHeader.split(';').reduce((acc, pair) => {
    const index = pair.indexOf('=');
    if (index === -1) return acc;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) acc[key] = value;
    return acc;
  }, {});
};

const base64Url = (value) => Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const hmac = (secret, payload) => base64Url(crypto.createHmac('sha256', secret).update(payload).digest());

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const secretValue = () => String(process.env.ADMIN_SECRET || '').trim();

const isSecureRequest = (req) => {
  const proto = String(getHeader(req, 'x-forwarded-proto') || '').toLowerCase();
  return proto === 'https' || process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
};

const createAdminSessionToken = (secret, now = Date.now()) => {
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `${SESSION_VERSION}.${expires}`;
  const signature = hmac(secret, payload);
  return `${payload}.${signature}`;
};

const verifyAdminSessionToken = (token, secret, now = Date.now()) => {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const [version, expiresStr, signature] = parts;
  if (version !== SESSION_VERSION) return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires <= Math.floor(now / 1000)) return false;
  const expected = hmac(secret, `${version}.${expiresStr}`);
  return safeEqual(signature, expected);
};

const getAdminSessionToken = (req) => parseCookies(req)[SESSION_COOKIE] || '';

const isAdminAuthenticated = (req) => {
  const secret = secretValue();
  if (!secret) return false;

  const authorization = String(getHeader(req, 'authorization') || '').trim();
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (token && safeEqual(token, secret)) return true;

  return verifyAdminSessionToken(getAdminSessionToken(req), secret);
};

const buildAdminSessionCookie = (token, req, maxAgeSeconds = SESSION_TTL_SECONDS) => {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
};

const clearAdminSessionCookie = (req) => buildAdminSessionCookie('', req, 0);

const requireAdmin = (req, res) => {
  const secret = secretValue();
  if (!secret) {
    res.status(500).json({ error: 'Admin access is not configured.' });
    return false;
  }

  if (isAdminAuthenticated(req)) return true;

  res.status(401).json({ error: 'Unauthorized.' });
  return false;
};

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createAdminSessionToken,
  buildAdminSessionCookie,
  clearAdminSessionCookie,
  isAdminAuthenticated,
  requireAdmin,
};