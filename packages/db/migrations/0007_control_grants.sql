-- Durable authorization grants. No grants are seeded; access remains deny-by-default.
CREATE TABLE control_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON UPDATE cascade ON DELETE restrict,
  action text NOT NULL,
  scope_kind text NOT NULL,
  scope_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT control_grants_action_valid CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'platform.agent.register')),
  CONSTRAINT control_grants_scope_valid CHECK (scope_kind IN ('platform', 'project')),
  CONSTRAINT control_grants_scope_key_valid CHECK ((scope_kind = 'platform' AND scope_key = 'platform') OR scope_kind = 'project')
);
CREATE UNIQUE INDEX control_grants_actor_action_scope_unique ON control_grants (actor_user_id, action, scope_kind, scope_key);
CREATE INDEX control_grants_actor_user_id_idx ON control_grants (actor_user_id);
