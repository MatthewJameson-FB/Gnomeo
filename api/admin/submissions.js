const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(process.cwd(), 'data', 'submissions.json');
const ADMIN_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD || 'gnomeo-admin';

const respondError = (res, statusCode, step, error) =>
  res.status(statusCode).json({ success: false, step, error });

const readSubmissions = () => {
  try {
    if (!fs.existsSync(DATA_PATH)) return [];
    const raw = fs.readFileSync(DATA_PATH, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[gnomeo admin submissions] read failure:', error);
    return [];
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return respondError(res, 405, 'method', 'Method not allowed');
  }

  const providedPassword = String(req.headers['x-admin-password'] || '').trim();
  if (!providedPassword || providedPassword !== ADMIN_PASSWORD) {
    return respondError(res, 401, 'auth', 'Unauthorized');
  }

  const submissions = readSubmissions().sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));

  return res.status(200).json({
    success: true,
    submissions,
  });
};
