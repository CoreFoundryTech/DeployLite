-- Forward-only claimed-command lease support. Expired claims are terminally
-- failed by the API and are never returned to pending or executed again.
ALTER TABLE deployment_commands
  ADD COLUMN lease_expires_at timestamptz;

-- Existing in-flight claims are made immediately expired. The API will
-- reconcile them to failed; they are deliberately never returned to pending.
UPDATE deployment_commands
  SET lease_expires_at = now()
  WHERE state = 'claimed';

CREATE INDEX deployment_commands_lease_expires_at_idx
  ON deployment_commands (lease_expires_at);

ALTER TABLE deployment_commands
  ADD CONSTRAINT deployment_commands_claimed_has_lease CHECK (
    (state = 'claimed') = (lease_expires_at IS NOT NULL)
  );
