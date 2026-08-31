CREATE TABLE IF NOT EXISTS fixtures (
  id BIGINT PRIMARY KEY,
  source TEXT NOT NULL,
  league_id BIGINT,
  starting_at TIMESTAMPTZ,
  status TEXT,
  home_score INTEGER,
  away_score INTEGER,
  ht_home_score INTEGER,
  ht_away_score INTEGER,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prematch_metrics (
  id BIGSERIAL PRIMARY KEY,
  fixture_id BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  sample_size INTEGER NOT NULL DEFAULT 0,
  home_sample_size INTEGER NOT NULL DEFAULT 0,
  away_sample_size INTEGER NOT NULL DEFAULT 0,
  over05_ht_rate NUMERIC,
  over15_ft_rate NUMERIC,
  over25_ft_rate NUMERIC,
  btts_rate NUMERIC,
  avg_total_goals NUMERIC,
  home_avg_scored NUMERIC,
  home_avg_conceded NUMERIC,
  away_avg_scored NUMERIC,
  away_avg_conceded NUMERIC,
  h2h_sample_size INTEGER NOT NULL DEFAULT 0,
  h2h_over15_rate NUMERIC,
  jwc_prematch_score NUMERIC,
  score_version TEXT NOT NULL DEFAULT 'jwc-prematch-v0.9.1',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fixture_id, score_version)
);

CREATE TABLE IF NOT EXISTS fixture_snapshots (
  id BIGSERIAL PRIMARY KEY,
  fixture_id BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  home_shots INTEGER,
  away_shots INTEGER,
  home_shots_on_target INTEGER,
  away_shots_on_target INTEGER,
  home_shots_inside_box INTEGER,
  away_shots_inside_box INTEGER,
  home_dangerous_attacks INTEGER,
  away_dangerous_attacks INTEGER,
  home_corners INTEGER,
  away_corners INTEGER,
  home_xg NUMERIC,
  away_xg NUMERIC,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fixtures_starting_at ON fixtures(starting_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_fixture_minute ON fixture_snapshots(fixture_id, minute, created_at);


ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'sportmonks';

