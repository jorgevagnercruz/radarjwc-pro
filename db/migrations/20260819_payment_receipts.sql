CREATE TABLE IF NOT EXISTS payment_receipts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  plan_type TEXT CHECK (plan_type IN ('MONTHLY','ANNUAL','CUSTOM')),
  amount_cents INTEGER CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  paid_at DATE,
  reference_label VARCHAR(80),
  original_filename VARCHAR(140) NOT NULL,
  content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
  file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 2097152),
  file_sha256 CHAR(64) NOT NULL,
  file_data BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','REJECTED')),
  reviewed_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_user_created
  ON payment_receipts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_status_created
  ON payment_receipts(status, created_at DESC);
