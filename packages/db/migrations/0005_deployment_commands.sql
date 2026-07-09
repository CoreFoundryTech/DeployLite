-- Deployment command bus persistence.
--
-- This table is the durable backing store for the deployment command
-- bus port (`DeploymentCommandBus` in `packages/domain`). The API
-- publishes deployment intent (`start` / `cancel` / `restart` /
-- `rollback`) by inserting a row in state `pending`; the deployment
-- agent (or a mock executor) claims it by moving the row to
-- `claimed`, drives the lifecycle, and resolves the row to
-- `completed` / `failed` / `cancelled`.
--
-- The table is intentionally narrow: it is a control-plane record, not
-- an audit log. The `payload` JSONB carries the safe command
-- arguments (commit SHA, restart-from-deployment id, etc.) and must
-- remain free of any plaintext material. Secret values belong in
-- `env_secret_values`; the agent reads them at materialization time
-- and never round-trips the plaintext through this table.
--
-- State machine (mirrors `packages/domain`):
--   pending  -> claimed   -> completed
--                        -> failed
--           -> cancelled
--   claimed  -> cancelled
--
-- The CHECK constraints enforce the state machine invariants at the
-- database boundary: terminal states require `completed_at`, and a
-- `failure_reason` is only set on `failed` rows. This is the safety
-- net behind the application-level state machine and keeps the table
-- consistent even if a future process skips the bus.

CREATE TABLE deployment_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON UPDATE cascade ON DELETE cascade,
  agent_id uuid NOT NULL REFERENCES agents(id) ON UPDATE cascade ON DELETE restrict,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by uuid REFERENCES users(id) ON UPDATE cascade ON DELETE set null,
  request_id text NOT NULL,
  correlation_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_commands_kind_valid CHECK (kind IN ('start', 'cancel', 'restart', 'rollback')),
  CONSTRAINT deployment_commands_state_valid CHECK (state IN ('pending', 'claimed', 'completed', 'cancelled', 'failed')),
  CONSTRAINT deployment_commands_terminal_state_has_completed_at CHECK (
    (state IN ('completed', 'cancelled', 'failed')) = (completed_at IS NOT NULL)
  ),
  CONSTRAINT deployment_commands_failure_reason_only_on_failed CHECK (
    (state = 'failed') = (failure_reason IS NOT NULL)
  )
);

CREATE INDEX deployment_commands_deployment_id_idx ON deployment_commands (deployment_id);
CREATE INDEX deployment_commands_agent_id_idx ON deployment_commands (agent_id);
CREATE INDEX deployment_commands_state_idx ON deployment_commands (state);
CREATE INDEX deployment_commands_issued_at_idx ON deployment_commands (issued_at);
