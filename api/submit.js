const readJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body;

  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const email = String(body.email || '').trim();
  const filename = String(body.filename || '').trim();
  const timestamp = String(body.timestamp || '').trim();

  if (!email || !filename) {
    return res.status(400).json({ error: 'email and filename are required' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!apiKey || !adminEmail) {
    return res.status(500).json({ error: 'Server email configuration is missing' });
  }

  const subject = 'New Gnomeo Free Analysis Submission';
  const lines = [
    'A new Free Analysis submission was received.',
    '',
    `User email: ${email}`,
    `File name: ${filename}`,
    `Timestamp: ${timestamp || 'not provided'}`,
    '',
    'Manually run analysis and reply with report.',
  ];

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Gnomeo <onboarding@resend.dev>',
      to: [adminEmail],
      subject,
      text: lines.join('\n'),
    }),
  });

  if (!emailResponse.ok) {
    const errorText = await emailResponse.text();
    return res.status(502).json({ error: 'Failed to send admin notification', details: errorText });
  }

  return res.status(200).json({ ok: true });
};
