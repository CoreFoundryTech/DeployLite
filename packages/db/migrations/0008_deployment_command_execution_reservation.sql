-- Execution reservation closes the cancellation window before privileged work.
ALTER TABLE deployment_commands
  DROP CONSTRAINT deployment_commands_state_valid,
  DROP CONSTRAINT deployment_commands_claimed_has_lease;

ALTER TABLE deployment_commands
  ADD CONSTRAINT deployment_commands_state_valid CHECK (state IN ('pending', 'claimed', 'executing', 'completed', 'cancelled', 'failed')),
  ADD CONSTRAINT deployment_commands_claimed_has_lease CHECK (
    (state IN ('claimed', 'executing')) = (lease_expires_at IS NOT NULL)
  );
