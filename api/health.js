const { createPool } = require('../lib/db');
const { apiFootballKey } = require('../lib/live-radar');
const { cronConfigured } = require('../lib/cron-auth');
const { telegramConfigured } = require('../lib/telegram');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const checks = {
    footballData: Boolean(process.env.FOOTBALL_DATA_TOKEN),
    sportmonks: Boolean(process.env.SPORTMONKS_TOKEN),
    apiFootball: Boolean(apiFootballKey()),
    database: Boolean(process.env.DATABASE_URL),
    cronSecret: cronConfigured(),
    telegram: telegramConfigured()
  };

  let databaseReachable = false;
  if (checks.database) {
    const pool = createPool({ max: 1 });
    try {
      await pool.query('SELECT 1');
      databaseReachable = true;
    } catch (error) {
      console.error('Database health error:', error.message);
    } finally {
      await pool.end();
    }
  }

  const liveProviderReady = checks.sportmonks || checks.apiFootball;
  const ok = checks.footballData && liveProviderReady && databaseReachable;
  return res.status(ok ? 200 : 503).json({
    ok,
    checks: { ...checks, liveProviderReady, databaseReachable },
    version: '2.5.0',
    checkedAt: new Date().toISOString()
  });
};
