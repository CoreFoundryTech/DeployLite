-- Durable P0 command ledger. This is additive and intentionally does not enable execution.
CREATE TABLE control_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON UPDATE cascade ON DELETE restrict,
  action text NOT NULL,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  input_digest text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_commands_action_valid CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'platform.agent.register')),
  CONSTRAINT control_commands_scope_valid CHECK (scope_kind IN ('platform', 'project')),
  CONSTRAINT control_commands_status_valid CHECK (status = 'pending')
);
CREATE UNIQUE INDEX control_commands_idempotency_unique ON control_commands (actor_user_id, action, scope_key, idempotency_key);
CREATE INDEX control_commands_actor_user_id_idx ON control_commands (actor_user_id);
