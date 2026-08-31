const crypto = require('crypto');
const { promisify } = require('util');
const { createPool } = require('./db');

const scrypt = promisify(crypto.scrypt);
const pool = createPool();
const COOKIE_NAME = process.env.VERCEL ? '__Host-radar_session' : 'radar_session';
const SESSION_DAYS = 30;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateIdentity(name, email, password) {
  const cleanName = String(name || '').trim();
  const cleanEmail = normalizeEmail(email);
  if (cleanName.length < 2 || cleanName.length > 120) {
    return { error: 'Informe um nome entre 2 e 120 caracteres.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) {
    return { error: 'Informe um e-mail válido.' };
  }
  const passwordError = validatePassword(password);
  if (passwordError) return { error: passwordError };
  return { name: cleanName, email: cleanEmail };
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 200) {
    return 'A senha deve ter entre 10 e 200 caracteres.';
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Use ao menos uma letra maiúscula, uma minúscula e um número.';
  }
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', '16384', salt.toString('base64url'), Buffer.from(derived).toString('base64url')].join('$');
}

async function verifyPassword(password, encoded) {
  try {
    const candidate = String(password || '');
    if (candidate.length > 200) return false;
    const [kind, cost, saltText, hashText] = String(encoded || '').split('$');
    if (kind !== 'scrypt' || Number(cost) !== 16384 || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scrypt(candidate, Buffer.from(saltText, 'base64url'), expected.length, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, Buffer.from(actual));
  } catch (_) {
    return false;
  }
}

function parseCookies(req) {
  return String(req.headers?.cookie || '').split(';').reduce((out, part) => {
    const index = part.indexOf('=');
    if (index < 1) return out;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch (_) {
      out[key] = value;
    }
    return out;
  }, {});
}

function rawSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[COOKIE_NAME] || cookies.radar_session || '';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function setSessionCookie(res, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=' + maxAge);
}

function clearSessionCookie(res) {
  const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax' +
    secure + '; Max-Age=0');
}

function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim().slice(0, 100);
}

function sameOrigin(req) {
  const origin = String(req.headers?.origin || '');
  if (!origin) return true;
  try {
    const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '');
    return new URL(origin).host === host;
  } catch (_) {
    return false;
  }
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body || '{}');
  } catch (_) {
    return {};
  }
}

function publicUser(row) {
  const accessActive = hasActiveAccess(row);
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    accessUntil: row.access_until || null,
    requestedAt: row.requested_at || null,
    approvedAt: row.approved_at || null,
    lastLoginAt: row.last_login_at || null,
    accessActive
  };
}

function hasActiveAccess(user) {
  return Boolean(user && (
    user.role === 'ADMIN' ||
    (user.status === 'APPROVED' && user.access_until && new Date(user.access_until) > new Date())
  ));
}

async function createSession(user, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hardLimit = new Date(Date.now() + SESSION_DAYS * 86400000);
  const accessDate = user.access_until ? new Date(user.access_until) : null;
  const accessLimit = accessDate && accessDate > new Date()
    ? new Date(Math.min(hardLimit.getTime(), accessDate.getTime()))
    : hardLimit;
  await pool.query(
    'INSERT INTO auth_sessions(user_id,token_hash,expires_at,ip_address,user_agent) VALUES($1,$2,$3,$4,$5)',
    [user.id, tokenHash(token), accessLimit, clientIp(req), String(req.headers?.['user-agent'] || '').slice(0, 500)]
  );
  setSessionCookie(res, token, accessLimit);
  return accessLimit;
}

async function sessionUser(req) {
  if (!pool) return null;
  const token = rawSessionToken(req);
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id,u.name,u.email,u.role,u.status,u.access_until,u.requested_at,
            u.approved_at,u.last_login_at,s.id AS session_id
       FROM auth_sessions s
       JOIN app_users u ON u.id=s.user_id
      WHERE s.token_hash=$1
        AND s.revoked_at IS NULL
        AND s.expires_at>NOW()
      LIMIT 1`,
    [tokenHash(token)]
  );
  const user = result.rows[0];
  return user || null;
}

async function requireUser(req, res) {
  const user = await sessionUser(req);
  if (!user) {
    res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: 'Faça login para continuar.' });
    return null;
  }
  if (!hasActiveAccess(user)) {
    const expired = user.status === 'APPROVED';
    res.status(403).json({
      ok: false,
      code: expired ? 'EXPIRED' : 'ACCESS_DENIED',
      error: expired ? 'Seu acesso venceu. Envie um comprovante para solicitar a renovação.' : 'Seu acesso não está autorizado.'
    });
    return null;
  }
  return user;
}

async function requireAccountUser(req, res) {
  const user = await sessionUser(req);
  if (!user) {
    res.status(401).json({ ok: false, code: 'UNAUTHENTICATED', error: 'Faça login para continuar.' });
    return null;
  }
  if (user.role !== 'ADMIN' && !['APPROVED', 'PENDING'].includes(user.status)) {
    res.status(403).json({ ok: false, code: 'ACCESS_DENIED', error: 'Seu acesso não está autorizado.' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'ADMIN') {
    res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Acesso exclusivo do administrador.' });
    return null;
  }
  return user;
}

async function revokeCurrentSession(req) {
  const token = rawSessionToken(req);
  if (!token || !pool) return;
  await pool.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash(token)]);
}

async function audit(actorId, targetId, action, details = {}) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO auth_audit_log(actor_user_id,target_user_id,action,details) VALUES($1,$2,$3,$4)',
    [actorId || null, targetId || null, action, JSON.stringify(details)]
  );
}

module.exports = {
  pool,
  normalizeEmail,
  validateIdentity,
  validatePassword,
  hashPassword,
  verifyPassword,
  bodyOf,
  sameOrigin,
  clientIp,
  publicUser,
  hasActiveAccess,
  createSession,
  sessionUser,
  requireUser,
  requireAccountUser,
  requireAdmin,
  revokeCurrentSession,
  clearSessionCookie,
  audit
};
