# DeployLite

Initial scaffold for DeployLite, a self-hosted deployment platform. This chain establishes TypeScript workspace boundaries, shared contracts, domain foundations, mock API/web/agent surfaces, and read-only MCP tools only.

## Scaffold chain

| Slice | Branch | Scope |
|---|---|---|
| PR1 | `feat/initial-platform-pr1-foundation-v2` | Workspace, shared config, contracts, domain ports, and baseline tests. |
| PR2 | `feat/initial-platform-pr2-api-control-plane` | Mock Fastify control-plane routes, request IDs, redaction, audit metadata, and SSE log streaming. |
| PR3 | `feat/initial-platform-pr3-web-agent-shell` | Static/mock web shell, server status/log views, mock agent heartbeat client, and local-only infra note. |
| PR4 | `feat/initial-platform-pr4-mcp-docs` | Read-only MCP adapter, cross-surface shape verification, and scaffold docs. |

## Safety guardrails

- No Docker socket access or host mutation exists in this scaffold.
- Auth is non-production placeholder work for later slices.
- Secret-like values must pass through shared redaction helpers before leaving a boundary.
- API, web, agent, and MCP surfaces are mock-only in this scaffold.
- MCP tools are read-only and non-destructive: `deploylite_get_server_status`, `deploylite_list_deployments`, and `deploylite_get_deployment_logs`.
- Traefik, ACME, production auth claims, real secret storage, and host shell execution are out of scope.

## Review checklist

- Shared contracts keep agent status, deployment records, log events, request IDs, and correlation IDs consistent across surfaces.
- SSE log resume uses monotonically ordered sequences and `Last-Event-ID`-style filtering.
- MCP outputs include structured content, request/correlation context, and redacted text content.
- Tests must not require real infrastructure or production credentials.

## Checks

```bash
pnpm install
pnpm check
```
