const {
  pool, requireAdmin, sameOrigin, bodyOf, audit
} = require('../../lib/auth');
const { publicPayment } = require('../../lib/payments');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'Comprovante inválido.' });
    const result = await pool.query(
      'SELECT original_filename,content_type,file_size,file_data FROM payment_receipts WHERE id=$1',
      [id]
    );
    const receipt = result.rows[0];
    if (!receipt) return res.status(404).json({ ok: false, error: 'Comprovante não encontrado.' });
    const filename = String(receipt.original_filename || 'comprovante').replace(/[^a-zA-Z0-9._ -]/g, '_');
    const disposition = receipt.content_type === 'application/pdf' ? 'attachment' : 'inline';
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', receipt.content_type);
    res.setHeader('Content-Length', String(receipt.file_size));
    res.setHeader('Content-Disposition', disposition + '; filename="' + filename + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(receipt.file_data);
  }

  if (req.method !== 'PATCH') return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Origem da solicitação inválida.' });

  const body = bodyOf(req);
  const paymentId = Number(body.paymentId);
  const status = body.action === 'confirm' ? 'CONFIRMED' : body.action === 'reject' ? 'REJECTED' : null;
  const note = String(body.note || '').trim();
  if (!Number.isInteger(paymentId) || paymentId < 1) return res.status(400).json({ ok: false, error: 'Comprovante inválido.' });
  if (!status) return res.status(400).json({ ok: false, error: 'Ação de pagamento inválida.' });
  if (note.length > 500) return res.status(400).json({ ok: false, error: 'A observação deve ter no máximo 500 caracteres.' });

  const updated = await pool.query(
    `UPDATE payment_receipts
        SET status=$2,reviewed_by=$3,reviewed_at=NOW(),review_note=$4,updated_at=NOW()
      WHERE id=$1
      RETURNING id,user_id,plan_type,amount_cents,paid_at,reference_label,
                original_filename,content_type,file_size,status,reviewed_at,review_note,created_at`,
    [paymentId, status, admin.id, note || null]
  );
  if (!updated.rows[0]) return res.status(404).json({ ok: false, error: 'Comprovante não encontrado.' });

  await audit(admin.id, updated.rows[0].user_id, 'PAYMENT_' + status, {
    receiptId: String(paymentId),
    note: note || null
  });
  return res.status(200).json({ ok: true, payment: publicPayment(updated.rows[0]) });
};
