const fs = require('fs');
const path = require('path');
const { isAdminAuthenticated } = require('../_adminAuth');

const ADMIN_ROOT = path.join(process.cwd(), 'admin');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const respondError = (res, statusCode, message) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
};

const normalizePath = (value) => {
  let filePath = String(value || '').trim();
  if (!filePath || filePath === '/') return 'index.html';
  if (filePath.endsWith('/')) filePath += 'index.html';
  if (filePath === 'login') filePath = 'login.html';
  const normal = path.posix.normalize(filePath).replace(/^\/+/, '');
  if (normal.startsWith('..') || path.isAbsolute(normal)) return null;
  return normal;
};

const contentTypeFor = (filePath) => MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

module.exports = async (req, res) => {
  try {
    const requested = normalizePath(req.query?.path || 'index.html');
    if (!requested) return respondError(res, 400, 'Invalid admin path');

    const loginPage = requested === 'login.html';
    if (!loginPage && !isAdminAuthenticated(req)) {
      res.statusCode = 302;
      res.setHeader('Location', '/admin/login.html');
      res.setHeader('Cache-Control', 'no-store');
      return res.end('Redirecting');
    }

    const filePath = path.join(ADMIN_ROOT, requested);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ADMIN_ROOT + path.sep) && resolved !== path.join(ADMIN_ROOT, requested)) {
      return respondError(res, 400, 'Invalid admin path');
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return respondError(res, 404, 'Admin page not found');
    }

    const buffer = fs.readFileSync(resolved);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeFor(resolved));
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buffer);
  } catch (error) {
    console.error('[gnomeo admin page] request failed:', error);
    return respondError(res, 500, 'Failed to load admin page');
  }
};