const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_RECEIPT_BYTES,
  decodeReceipt
} = require('../lib/payments');

test('aceita somente arquivos cuja assinatura corresponde ao formato', () => {
  const pdf = Buffer.from('%PDF-1.7\ncomprovante');
  const decoded = decodeReceipt({ name: 'recibo estranho.exe', data: pdf.toString('base64') });
  assert.equal(decoded.contentType, 'application/pdf');
  assert.equal(decoded.fileName, 'recibo estranho.pdf');
  assert.equal(decoded.fileSize, pdf.length);
  assert.equal(decoded.fileSha256.length, 64);

  assert.match(decodeReceipt({ name: 'falso.pdf', data: Buffer.from('<html>').toString('base64') }).error, /PDF/i);
  assert.match(decodeReceipt({ name: 'grande.pdf', data: Buffer.alloc(MAX_RECEIPT_BYTES + 1).toString('base64') }).error, /2 MB/i);
});
