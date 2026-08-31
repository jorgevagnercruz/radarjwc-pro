const crypto = require('crypto');

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

function detectedType(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decodeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return { error: 'Selecione o comprovante.' };
  const encoded = String(receipt.data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return { error: 'O arquivo enviado é inválido.' };
  const fileData = Buffer.from(encoded, 'base64');
  if (!fileData.length) return { error: 'O comprovante está vazio.' };
  if (fileData.length > MAX_RECEIPT_BYTES) return { error: 'O comprovante deve ter no máximo 2 MB.' };
  const contentType = detectedType(fileData);
  if (!contentType) return { error: 'Envie um comprovante PDF, JPG, PNG ou WebP válido.' };

  const original = String(receipt.name || 'comprovante').replace(/\.[^.]*$/, '');
  const safeBase = original.replace(/[^a-zA-Z0-9._ -]/g, '_').trim().slice(0, 110) || 'comprovante';
  return {
    fileData,
    contentType,
    fileSize: fileData.length,
    fileName: safeBase + '.' + EXTENSIONS[contentType],
    fileSha256: crypto.createHash('sha256').update(fileData).digest('hex')
  };
}

function publicPayment(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    planType: row.plan_type || null,
    amountCents: row.amount_cents == null ? null : Number(row.amount_cents),
    paidAt: row.paid_at || null,
    referenceLabel: row.reference_label || null,
    fileName: row.original_filename,
    contentType: row.content_type,
    fileSize: Number(row.file_size),
    status: row.status,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || null,
    submittedAt: row.created_at
  };
}

module.exports = {
  MAX_RECEIPT_BYTES,
  decodeReceipt,
  publicPayment
};
