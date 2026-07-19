# DeployLite MCP Alpha Surface

This package is a local, mock-only read adapter. It does not create live MCP
transport, production authentication, deployment execution, writes, or external
network access.

## Project and audit visibility

`deploylite_list_projects` accepts only `{}`. Project visibility is controlled
by the factory-injected `project.read` grants, never by a tool filter.

`deploylite_list_audit_events` accepts exact `projectId`, `action`, and `actor`
filters, with `offset` from 0 through 10,000 and `limit` from 1 through 200
(defaults: 0 and 50). Factory-injected `audit.read` grants may be platform-wide
or project-scoped; a project-scoped caller must supply its matching `projectId`.
Missing or mismatched grants fail with the deterministic `FORBIDDEN` error
before a client read.

Both tools return only named safe fields. Repository URLs, commands, credentials,
unknown metadata, and secret-bearing values are excluded before recursive
redaction and serialization. Results use deterministic project name/ID and audit
timestamp/ID ordering, with request and correlation identifiers retained in each
safe envelope.

## Rollback

Revert the atomic MCP work unit (registrations, handlers, fixtures, tests, and
this document). No migration, infrastructure cleanup, or data recovery is
required.
