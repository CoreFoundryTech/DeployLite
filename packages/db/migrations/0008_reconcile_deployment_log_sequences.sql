-- Repair counter rows that predate explicit-log counter synchronization.
INSERT INTO deployment_log_sequences (deployment_id, next_sequence)
SELECT deployment_id, MAX(sequence) + 1
FROM deployment_logs
GROUP BY deployment_id
ON CONFLICT (deployment_id) DO UPDATE
SET next_sequence = GREATEST(deployment_log_sequences.next_sequence, EXCLUDED.next_sequence);
