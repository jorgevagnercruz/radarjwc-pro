const { Pool } = require('pg');

function connectionConfig() {
  if (!process.env.DATABASE_URL) return null;

  const url = new URL(process.env.DATABASE_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: url.searchParams.get('channel_binding') === 'require',
    max: 3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000
  };
}

function createPool(overrides = {}) {
  const config = connectionConfig();
  return config ? new Pool({ ...config, ...overrides }) : null;
}

module.exports = { createPool };

