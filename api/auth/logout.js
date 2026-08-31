const { sameOrigin, revokeCurrentSession, clearSessionCookie } = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origem da solicitação inválida.' });
  await revokeCurrentSession(req);
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
};


