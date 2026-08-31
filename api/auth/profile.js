const {
  pool, requireAccountUser, sameOrigin, bodyOf, normalizeEmail, verifyPassword,
  validatePassword, hashPassword, createSession, clearSessionCookie, publicUser, audit
} = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = await requireAccountUser(req, res);
  if (!user) return;
  if (req.method !== 'PATCH') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origem da solicitação inválida.' });

  const body = bodyOf(req);
  const current = await pool.query('SELECT * FROM app_users WHERE id=$1', [user.id]);
  const record = current.rows[0];
  if (!await verifyPassword(body.currentPassword, record.password_hash)) {
    return res.status(401).json({ ok: false, error: 'Senha atual incorreta.' });
  }

  try {
    if (body.newPassword) {
      const passwordError = validatePassword(body.newPassword);
      if (passwordError) return res.status(400).json({ ok: false, error: passwordError });
      const passwordHash = await hashPassword(body.newPassword);
      await pool.query('UPDATE app_users SET password_hash=$2,updated_at=NOW() WHERE id=$1', [user.id, passwordHash]);
      await pool.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
      clearSessionCookie(res);
      await createSession(record, req, res);
      await audit(user.id, user.id, 'PASSWORD_CHANGED');
    } else {
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      if (name.length < 2 || name.length > 120) return res.status(400).json({ ok: false, error: 'Nome inválido.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'E-mail inválido.' });
      const updated = await pool.query(
        'UPDATE app_users SET name=$2,email=$3,updated_at=NOW() WHERE id=$1 RETURNING *',
        [user.id, name, email]
      );
      await audit(user.id, user.id, 'PROFILE_UPDATED');
      return res.status(200).json({ ok: true, user: publicUser(updated.rows[0]) });
    }
    return res.status(200).json({ ok: true, message: 'Senha alterada com segurança.' });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ ok: false, error: 'Este e-mail já está sendo utilizado.' });
    console.error('Profile error:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível atualizar a conta.' });
  }
};

