const {
  pool, requireAccountUser, sameOrigin, bodyOf, audit
} = require('../lib/auth');
const { decodeReceipt, publicPayment } = require('../lib/payments');
const { getPlan, publicCommercialConfig } = require('../lib/plans');
const { createPixPayload } = require('../lib/pix');
const QRCode = require('qrcode');

let publicConfigPromise;

function isPublicConfigRequest(req) {
  if (req.method !== 'GET') return false;
  if (String(req.query?.config || '') === '1') return true;
  try {
    return new URL(req.url || '/', 'https://radarjwc-pro.local').searchParams.get('config') === '1';
  } catch (_) {
    return false;
  }
}

async function publicPaymentConfig() {
  if (!publicConfigPromise) {
    publicConfigPromise = (async () => {
      const commercial = publicCommercialConfig();
      const plans = await Promise.all(commercial.plans.map(async plan => {
        const payload = createPixPayload({
          key: commercial.pix.key,
          amountCents: plan.amountCents,
          merchantName: commercial.pix.merchantName,
          city: commercial.pix.city
        });
        const qrSvg = await QRCode.toString(payload, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 2,
          color: { dark: '#061019', light: '#FFFFFF' }
        });
        return { ...plan, pix: { payload, qrSvg } };
      }));
      return { plans, pix: commercial.pix };
    })().catch(error => {
      publicConfigPromise = null;
      throw error;
    });
  }
  return publicConfigPromise;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (isPublicConfigRequest(req)) {
    try {
      return res.status(200).json({ ok: true, ...(await publicPaymentConfig()) });
    } catch (error) {
      console.error('Pix config error:', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível gerar o QR Code Pix.' });
    }
  }

  const user = await requireAccountUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const result = await pool.query(
      `SELECT id,user_id,plan_type,amount_cents,paid_at,reference_label,
              original_filename,content_type,file_size,status,reviewed_at,review_note,created_at
         FROM payment_receipts
        WHERE user_id=$1
        ORDER BY created_at DESC`,
      [user.id]
    );
    return res.status(200).json({ ok: true, payments: result.rows.map(publicPayment) });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origem da solicitação inválida.' });
  if (user.role === 'ADMIN') return res.status(400).json({ ok: false, error: 'O administrador não precisa enviar comprovante.' });

  const body = bodyOf(req);
  const plan = getPlan(body.plan || 'MONTHLY');
  if (!plan) return res.status(400).json({ ok: false, error: 'Escolha o plano mensal ou anual.' });
  const receipt = decodeReceipt(body.receipt);
  if (receipt.error) return res.status(400).json({ ok: false, error: receipt.error });

  const recent = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE created_at>NOW()-INTERVAL '24 hours')::int AS recent,
            COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
            COUNT(*)::int AS total
       FROM payment_receipts
      WHERE user_id=$1`,
    [user.id]
  );
  if (recent.rows[0].recent >= 5) {
    return res.status(429).json({ ok: false, error: 'Limite diário de comprovantes atingido. Tente novamente amanhã.' });
  }
  if (recent.rows[0].pending >= 3) {
    return res.status(409).json({ ok: false, error: 'Você já possui três comprovantes aguardando conferência.' });
  }
  if (recent.rows[0].total >= 24) {
    return res.status(409).json({ ok: false, error: 'Limite do histórico atingido. Procure o administrador.' });
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO payment_receipts(
         user_id,plan_type,amount_cents,reference_label,
         original_filename,content_type,file_size,file_sha256,file_data
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id,user_id,plan_type,amount_cents,paid_at,reference_label,
                 original_filename,content_type,file_size,status,reviewed_at,review_note,created_at`,
      [
        user.id, plan.code, plan.amountCents, 'Nova assinatura ou renovação',
        receipt.fileName, receipt.contentType, receipt.fileSize,
        receipt.fileSha256, receipt.fileData
      ]
    );
    await audit(user.id, user.id, 'PAYMENT_RECEIPT_UPLOADED', {
      receiptId: String(inserted.rows[0].id),
      plan: plan.code,
      amountCents: plan.amountCents
    });
    return res.status(201).json({
      ok: true,
      message: 'Comprovante enviado para conferência.',
      payment: publicPayment(inserted.rows[0])
    });
  } catch (error) {
    console.error('Payment upload error:', error);
    return res.status(500).json({ ok: false, error: 'Não foi possível salvar o comprovante.' });
  }
};
