const DEFAULT_GUI = 'BR.GOV.BCB.PIX';
const DEFAULT_TXID = '***';

function textBytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function field(id, value) {
  const content = String(value);
  const length = textBytes(content);
  if (!/^\d{2}$/.test(String(id)) || length > 99) {
    throw new Error('Campo Pix inválido.');
  }
  return String(id) + String(length).padStart(2, '0') + content;
}

function normalizePixText(value, maxLength) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 $%*+\-./:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, maxLength);
}

function crc16(payload) {
  let crc = 0xffff;
  const bytes = Buffer.from(String(payload), 'utf8');
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function createPixPayload({ key, amountCents, merchantName, city, txid = DEFAULT_TXID }) {
  const pixKey = String(key || '').trim();
  const cents = Number(amountCents);
  const merchant = normalizePixText(merchantName, 25);
  const merchantCity = normalizePixText(city, 15);
  const transactionId = normalizePixText(txid || DEFAULT_TXID, 25) || DEFAULT_TXID;

  if (!pixKey || textBytes(pixKey) > 77) throw new Error('Chave Pix inválida.');
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Valor Pix inválido.');
  if (!merchant || !merchantCity) throw new Error('Dados do favorecido incompletos.');

  const merchantAccount = field('00', DEFAULT_GUI) + field('01', pixKey);
  const additionalData = field('05', transactionId);
  const amount = (cents / 100).toFixed(2);
  const withoutCrc =
    field('00', '01') +
    field('26', merchantAccount) +
    field('52', '0000') +
    field('53', '986') +
    field('54', amount) +
    field('58', 'BR') +
    field('59', merchant) +
    field('60', merchantCity) +
    field('62', additionalData) +
    '6304';

  return withoutCrc + crc16(withoutCrc);
}

function validatePixPayload(payload) {
  const value = String(payload || '');
  if (!value.startsWith('000201') || !/6304[0-9A-F]{4}$/.test(value)) return false;
  const body = value.slice(0, -4);
  return crc16(body) === value.slice(-4);
}

module.exports = {
  crc16,
  createPixPayload,
  normalizePixText,
  validatePixPayload
};
