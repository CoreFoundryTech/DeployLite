ALTER TABLE control_command_audits DROP CONSTRAINT control_command_audits_outcome_valid;
ALTER TABLE control_command_audits ADD CONSTRAINT control_command_audits_outcome_valid CHECK (outcome IN ('accepted', 'rejected', 'completed'));
