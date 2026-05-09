const { clearAdminSessionCookie } = require('../_adminAuth');

const respondError = (res, statusCode, error) => res.status(statusCode).json({ success: false, error });

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return respondError(res, 405, 'Method not allowed');
    }

    res.setHeader('Set-Cookie', clearAdminSessionCookie(req));
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[gnomeo admin logout] request failed:', error);
    return respondError(res, 500, 'Logout failed');
  }
};