const {
  pool, validateIdentity, hashPassword, bodyOf, sameOrigin, clientIp
} = require('../../lib/auth');
const { decodeReceipt } = require('../../lib/payments');
const { getPlan } = require('../../lib/plans');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origem da solicitação inválida.' });
  if (!pool) return res.status(503).json({ ok: false, error: 'Banco de dados indisponível.' });

  const body = bodyOf(req);
  const identity = validateIdentity(body.name, body.email, body.password);
  if (identity.error) return res.status(400).json({ ok: false, error: identity.error });
  const plan = getPlan(body.plan || 'MONTHLY');
  if (!plan) return res.status(400).json({ ok: false, error: 'Escolha o plano mensal ou anual.' });
  let receipt = null;
  if (body.receipt) {
    receipt = decodeReceipt(body.receipt);
    if (receipt.error) return res.status(400).json({ ok: false, error: receipt.error });
  }

  let client;
  try {
    const ip = clientIp(req);
    const recent = await pool.query(
      "SELECT COUNT(*)::int AS total FROM app_users WHERE request_ip=$1 AND requested_at>NOW()-INTERVAL '24 hours'",
      [ip]
    );
    if (recent.rows[0].total >= 5) {
      return res.status(429).json({ ok: false, error: 'Muitas solicitações deste endereço. Tente novamente amanhã.' });
    }

    const passwordHash = await hashPassword(body.password);
    client = await pool.connect();
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO app_users(name,email,password_hash,role,status,request_ip)
       VALUES($1,$2,$3,'USER','PENDING',$4)
       RETURNING id`,
      [identity.name, identity.email, passwordHash, ip]
    );
    const userId = inserted.rows[0].id;
    if (receipt) {
      await client.query(
        `INSERT INTO payment_receipts(
           user_id,plan_type,amount_cents,reference_label,
           original_filename,content_type,file_size,file_sha256,file_data
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          userId, plan.code, plan.amountCents, 'Solicitação de cadastro',
          receipt.fileName, receipt.contentType, receipt.fileSize,
          receipt.fileSha256, receipt.fileData
        ]
      );
    }
    await client.query(
      'INSERT INTO auth_audit_log(actor_user_id,target_user_id,action,details) VALUES(NULL,$1,$2,$3)',
      [userId, 'REGISTRATION_REQUESTED', JSON.stringify({
        email: identity.email,
        receipt: Boolean(receipt),
        plan: plan.code,
        amountCents: plan.amountCents
      })]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      message: receipt
        ? `Solicitação do ${plan.name.toLowerCase()} e comprovante enviados. O administrador fará a conferência.`
        : `Solicitação do ${plan.name.toLowerCase()} enviada. O administrador precisa aprovar seu acesso.`
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Este e-mail já possui cadastro ou solicitação.' });
    }
    console.error('Register error:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível solicitar o cadastro.' });
  } finally {
    if (client) client.release();
  }
};
