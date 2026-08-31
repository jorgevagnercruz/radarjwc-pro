const { sessionUser, publicUser } = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: 'Sessão inválida ou expirada.' });
  return res.status(200).json({ ok: true, user: publicUser(user) });
};


