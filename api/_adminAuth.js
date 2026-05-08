const getHeader = (req, name) => {
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
};

const requireAdmin = (req, res) => {
  const secret = String(process.env.ADMIN_SECRET || '').trim();
  if (!secret) {
    res.status(500).json({ error: 'Admin access is not configured.' });
    return false;
  }

  const authorization = String(getHeader(req, 'authorization') || '').trim();
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || token !== secret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }

  return true;
};

module.exports = { requireAdmin };
