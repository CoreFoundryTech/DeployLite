-- Add confirmation and outcome evidence without enabling any command execution.
ALTER TABLE control_commands DROP CONSTRAINT control_commands_status_valid;
UPDATE control_commands SET status = 'pending_confirmation' WHERE status = 'pending';
ALTER TABLE control_commands ADD CONSTRAINT control_commands_status_valid
  CHECK (status IN ('pending_confirmation', 'eligible', 'rejected', 'completed'));
ALTER TABLE control_commands ALTER COLUMN status SET DEFAULT 'pending_confirmation';

CREATE TABLE control_command_confirmations (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE REFERENCES control_commands(id) ON UPDATE cascade ON DELETE restrict,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON UPDATE cascade ON DELETE restrict,
  action text NOT NULL,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  input_digest text NOT NULL,
  classification text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_command_confirmations_action_valid CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'platform.agent.register')),
  CONSTRAINT control_command_confirmations_scope_valid CHECK (scope_kind IN ('platform', 'project')),
  CONSTRAINT control_command_confirmations_classification_valid CHECK (classification IN ('destructive', 'non-destructive'))
);
CREATE INDEX control_command_confirmations_actor_user_id_idx ON control_command_confirmations (actor_user_id);

CREATE TABLE control_command_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL REFERENCES control_commands(id) ON UPDATE cascade ON DELETE restrict,
  confirmation_id uuid REFERENCES control_command_confirmations(id) ON UPDATE cascade ON DELETE restrict,
  correlation_id text NOT NULL,
  outcome text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_command_audits_outcome_valid CHECK (outcome IN ('accepted', 'rejected'))
);
CREATE INDEX control_command_audits_command_id_idx ON control_command_audits (command_id);
CREATE INDEX control_command_audits_correlation_id_idx ON control_command_audits (correlation_id);
