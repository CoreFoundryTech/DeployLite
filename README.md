# DeployLite

Initial scaffold for DeployLite, a self-hosted deployment platform. This first slice establishes TypeScript workspace boundaries, shared contracts, domain foundations, and safety helpers only.

## Safety guardrails

- No Docker socket access or host mutation exists in this scaffold.
- Auth is non-production placeholder work for later slices.
- Secret-like values must pass through shared redaction helpers before leaving a boundary.
- MCP mutating tools are out of scope for PR1.
