const crypto = require('crypto');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorizedCron(req, env = process.env) {
  const secret = String(env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const authorization = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  return safeEqual(authorization, `Bearer ${secret}`);
}

function cronConfigured(env = process.env) {
  return Boolean(String(env.CRON_SECRET || '').trim());
}

module.exports = { safeEqual, isAuthorizedCron, cronConfigured };
