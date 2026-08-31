const {
  pool, requireAdmin, sameOrigin, bodyOf, publicUser, audit
} = require('../../lib/auth');
const { publicPayment } = require('../../lib/payments');

function futureDate(body, currentAccess) {
  if (body.accessUntil) {
    const date = new Date(body.accessUntil);
    if (Number.isNaN(date.getTime()) || date <= new Date()) return null;
    return date;
  }
  const days = Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 3660) return null;
  const current = currentAccess ? new Date(currentAccess) : null;
  const base = body.action === 'renew' && current && current > new Date()
    ? current.getTime()
    : Date.now();
  return new Date(base + days * 86400000);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const result = await pool.query(
      `SELECT u.id,u.name,u.email,u.role,u.status,u.access_until,u.requested_at,u.approved_at,u.last_login_at,
              CASE WHEN u.status='APPROVED' AND u.access_until<=NOW() THEN 'EXPIRED' ELSE u.status END AS effective_status,
              (SELECT l.details->>'plan'
                 FROM auth_audit_log l
                WHERE l.target_user_id=u.id AND l.action='REGISTRATION_REQUESTED'
                ORDER BY l.created_at DESC LIMIT 1) AS requested_plan
         FROM app_users u
        ORDER BY CASE u.status WHEN 'PENDING' THEN 0 ELSE 1 END,u.requested_at DESC`
    );
    const receipts = await pool.query(
      `SELECT id,user_id,plan_type,amount_cents,paid_at,reference_label,
              original_filename,content_type,file_size,status,reviewed_at,review_note,created_at
         FROM payment_receipts
        ORDER BY created_at DESC`
    );
    const paymentsByUser = new Map();
    for (const row of receipts.rows) {
      const key = String(row.user_id);
      if (!paymentsByUser.has(key)) paymentsByUser.set(key, []);
      paymentsByUser.get(key).push(publicPayment(row));
    }
    const users = result.rows.map(row => ({
      ...publicUser(row),
      effectiveStatus: row.effective_status,
      requestedPlan: row.requested_plan || null,
      payments: paymentsByUser.get(String(row.id)) || []
    }));
    const counts = users.reduce((out, user) => {
      out[user.effectiveStatus] = (out[user.effectiveStatus] || 0) + 1;
      return out;
    }, {});
    const paymentCounts = receipts.rows.reduce((out, row) => {
      out[row.status] = (out[row.status] || 0) + 1;
      return out;
    }, {});
    return res.status(200).json({ ok: true, users, counts, paymentCounts });
  }

  if (req.method !== 'PATCH') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origem da solicitação inválida.' });
  const body = bodyOf(req);
  const id = Number(body.userId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'Usuário inválido.' });

  const targetResult = await pool.query('SELECT * FROM app_users WHERE id=$1', [id]);
  const target = targetResult.rows[0];
  if (!target) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
  if (target.role === 'ADMIN') return res.status(400).json({ ok: false, error: 'O administrador principal não pode ser alterado aqui.' });

  let updated;
  if (body.action === 'approve' || body.action === 'renew') {
    const accessUntil = futureDate(body, target.access_until);
    if (!accessUntil) {
      return res.status(400).json({ ok: false, error: 'Informe um período ou vencimento futuro válido.' });
    }
    updated = await pool.query(
      `UPDATE app_users
          SET status='APPROVED',access_until=$2,approved_at=COALESCE(approved_at,NOW()),
              approved_by=$3,updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [id, accessUntil, admin.id]
    );
  } else if (body.action === 'reject') {
    updated = await pool.query(
      "UPDATE app_users SET status='REJECTED',access_until=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",
      [id]
    );
    await pool.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
  } else if (body.action === 'suspend') {
    updated = await pool.query(
      "UPDATE app_users SET status='SUSPENDED',updated_at=NOW() WHERE id=$1 RETURNING *",
      [id]
    );
    await pool.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
  } else if (body.action === 'revoke_sessions') {
    await pool.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    updated = { rows: [target] };
  } else {
    return res.status(400).json({ ok: false, error: 'Ação administrativa inválida.' });
  }

  await audit(admin.id, id, String(body.action).toUpperCase(), {
    accessUntil: updated.rows[0].access_until || null
  });
  return res.status(200).json({ ok: true, user: publicUser(updated.rows[0]) });
};
