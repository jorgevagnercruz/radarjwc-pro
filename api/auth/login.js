const {
  pool, normalizeEmail, verifyPassword, bodyOf, sameOrigin,
  createSession, publicUser, audit
} = require('../../lib/auth');

// Mantém o custo de uma tentativa semelhante mesmo quando o e-mail não existe.
const DUMMY_PASSWORD_HASH = 'scrypt$16384$cmFkYXItandjLWR1bW15LXNhbHQ$LMPob9IYwRpSYKMi1sLRxV6KYpWEREW5K47N-q4dloo4cHUkKvU5gV-dh3WV9ZzB3pYu3PJIibW6di94teuxww';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origem da solicitação inválida.' });
  if (!pool) return res.status(503).json({ ok: false, error: 'Banco de dados indisponível.' });

  const body = bodyOf(req);
  const email = normalizeEmail(body.email);
  const result = email.length <= 254
    ? await pool.query('SELECT * FROM app_users WHERE LOWER(email)=$1 LIMIT 1', [email])
    : { rows: [] };
  const user = result.rows[0];

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(429).json({ ok: false, code: 'LOCKED', error: 'Conta temporariamente bloqueada. Tente novamente em 15 minutos.' });
  }

  const valid = await verifyPassword(body.password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    if (!user) {
      return res.status(401).json({ ok: false, code: 'INVALID_LOGIN', error: 'E-mail ou senha incorretos.' });
    }
    await pool.query(
      `UPDATE app_users
          SET failed_login_attempts=failed_login_attempts+1,
              locked_until=CASE WHEN failed_login_attempts+1>=5 THEN NOW()+INTERVAL '15 minutes' ELSE locked_until END,
              updated_at=NOW()
        WHERE id=$1`,
      [user.id]
    );
    return res.status(401).json({ ok: false, code: 'INVALID_LOGIN', error: 'E-mail ou senha incorretos.' });
  }

  await pool.query(
    'UPDATE app_users SET failed_login_attempts=0,locked_until=NULL,updated_at=NOW() WHERE id=$1',
    [user.id]
  );

  if (user.role !== 'ADMIN') {
    const messages = {
      REJECTED: ['REJECTED', 'Sua solicitação não foi aprovada.'],
      SUSPENDED: ['SUSPENDED', 'Seu acesso está suspenso.']
    };
    if (messages[user.status]) {
      return res.status(403).json({ ok: false, code: messages[user.status][0], error: messages[user.status][1] });
    }
  }

  await pool.query(
    'UPDATE app_users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1',
    [user.id]
  );
  await createSession(user, req, res);
  const limited = user.role !== 'ADMIN' && (user.status === 'PENDING' || !user.access_until || new Date(user.access_until) <= new Date());
  await audit(user.id, user.id, limited ? 'LOGIN_ACCOUNT_ONLY' : 'LOGIN');
  return res.status(200).json({ ok: true, user: publicUser(user) });
};
