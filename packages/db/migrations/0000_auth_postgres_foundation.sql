CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_name_canonical CHECK (name IN ('admin', 'operator', 'read-only', 'auditor'))
);
CREATE UNIQUE INDEX roles_name_unique ON roles (name);

INSERT INTO roles (name, description)
VALUES
  ('admin', 'Full local administration access'),
  ('operator', 'Operational deployment and project management access'),
  ('read-only', 'Read-only platform visibility'),
  ('auditor', 'Audit and compliance visibility')
ON CONFLICT DO NOTHING;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL,
  password_hash text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id) ON UPDATE cascade ON DELETE restrict,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_email_normalized_lower CHECK (email_normalized = lower(email_normalized))
);
CREATE UNIQUE INDEX users_email_normalized_unique ON users (email_normalized);
CREATE INDEX users_role_id_idx ON users (role_id);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON UPDATE cascade ON DELETE cascade,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_hash text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE UNIQUE INDEX user_sessions_token_hash_unique ON user_sessions (token_hash);
CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions (expires_at);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON UPDATE cascade ON DELETE cascade,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_status_valid CHECK (status IN ('active', 'revoked'))
);
CREATE UNIQUE INDEX api_keys_key_hash_unique ON api_keys (key_hash);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

CREATE TABLE servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  endpoint text NOT NULL,
  status text NOT NULL DEFAULT 'offline',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT servers_status_valid CHECK (status IN ('online', 'offline', 'stale', 'disabled'))
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid REFERENCES servers(id) ON UPDATE cascade ON DELETE set null,
  name text NOT NULL,
  endpoint text NOT NULL,
  status text NOT NULL DEFAULT 'offline',
  last_heartbeat_at timestamptz,
  resource_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_status_valid CHECK (status IN ('online', 'offline', 'stale', 'disabled'))
);
CREATE INDEX agents_server_id_idx ON agents (server_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  repo_url text NOT NULL,
  default_branch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE cascade ON DELETE restrict,
  agent_id uuid REFERENCES agents(id) ON UPDATE cascade ON DELETE set null,
  status text NOT NULL DEFAULT 'queued',
  commit_sha text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployments_status_valid CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'))
);
CREATE INDEX deployments_project_id_idx ON deployments (project_id);
CREATE INDEX deployments_agent_id_idx ON deployments (agent_id);

CREATE TABLE deployment_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON UPDATE cascade ON DELETE cascade,
  sequence integer NOT NULL,
  level text NOT NULL,
  message text NOT NULL,
  redaction_applied boolean NOT NULL DEFAULT true,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_logs_level_valid CHECK (level IN ('debug', 'info', 'warn', 'error'))
);
CREATE UNIQUE INDEX deployment_logs_deployment_sequence_unique ON deployment_logs (deployment_id, sequence);
CREATE INDEX deployment_logs_deployment_id_idx ON deployment_logs (deployment_id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON UPDATE cascade ON DELETE set null,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_actor_user_id_idx ON audit_events (actor_user_id);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id);

CREATE TABLE env_variable_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE cascade ON DELETE cascade,
  key text NOT NULL,
  scope text NOT NULL DEFAULT 'project',
  value_present boolean NOT NULL DEFAULT false,
  value_fingerprint text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT env_variable_metadata_scope_valid CHECK (scope IN ('project', 'deployment'))
);
CREATE UNIQUE INDEX env_variable_metadata_project_key_scope_unique ON env_variable_metadata (project_id, key, scope);
CREATE INDEX env_variable_metadata_project_id_idx ON env_variable_metadata (project_id);

CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE cascade ON DELETE cascade,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domains_status_valid CHECK (status IN ('pending', 'active', 'failed', 'disabled'))
);
CREATE UNIQUE INDEX domains_hostname_unique ON domains (hostname);
CREATE INDEX domains_project_id_idx ON domains (project_id);

CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES domains(id) ON UPDATE cascade ON DELETE cascade,
  provider text NOT NULL DEFAULT 'acme-metadata-only',
  status text NOT NULL DEFAULT 'pending',
  not_before timestamptz,
  not_after timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT certificates_status_valid CHECK (status IN ('pending', 'issued', 'expired', 'revoked', 'failed'))
);
CREATE INDEX certificates_domain_id_idx ON certificates (domain_id);
