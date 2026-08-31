CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN','USER')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUSPENDED')),
  access_until TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES app_users(id),
  last_login_at TIMESTAMPTZ,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  request_ip VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_email_lower ON app_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users(status,requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_users_access_until ON app_users(access_until);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_address VARCHAR(100),
  user_agent VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions(user_id,expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
  target_user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_created_at ON auth_audit_log(created_at DESC);


