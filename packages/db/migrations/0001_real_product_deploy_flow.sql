ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS build_command text,
  ADD COLUMN IF NOT EXISTS run_command text,
  ADD COLUMN IF NOT EXISTS port integer,
  ADD CONSTRAINT projects_port_range CHECK (port IS NULL OR (port >= 1 AND port <= 65535));

ALTER TABLE env_variable_metadata
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS description text;
