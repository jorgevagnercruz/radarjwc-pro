-- Corrige registros criados antes de fixtures.source existir.
-- A presença de uma métrica jwc-prematch identifica a origem football-data.org.
UPDATE fixtures AS f
SET source = 'football-data.org',
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1
  FROM prematch_metrics AS pm
  WHERE pm.fixture_id = f.id
    AND pm.score_version LIKE 'jwc-prematch-%'
)
AND f.source <> 'football-data.org';

