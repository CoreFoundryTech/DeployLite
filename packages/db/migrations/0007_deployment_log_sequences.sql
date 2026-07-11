-- Allocate deployment log sequence numbers with a single locked counter row.
-- This is forward-only and seeds existing deployments before the repository
-- begins using the UPSERT allocator.
CREATE TABLE deployment_log_sequences (
  deployment_id uuid PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE ON UPDATE CASCADE,
  next_sequence integer NOT NULL DEFAULT 1,
  CONSTRAINT deployment_log_sequences_next_sequence_positive CHECK (next_sequence > 0)
);

INSERT INTO deployment_log_sequences (deployment_id, next_sequence)
SELECT deployment_id, MAX(sequence) + 1
FROM deployment_logs
GROUP BY deployment_id;
