# Home Assistant agent

## Scope

- This agent is for the local Home Assistant installation only.
- Its domain MCP is the native Home Assistant MCP integration at `/api/mcp`.
- The MCP launcher opens a temporary local SSH tunnel to `has`; it does not use a cloud or third-party Home Assistant MCP service by default.

## SSH access

- The authorized SSH host alias is exactly `has`.
- Use commands such as `ssh has`, `ssh has <command>`, or the launcher-managed tunnel to reach Home Assistant.
- Do not silently substitute an IP address, another SSH host, or a different Home Assistant installation.
- The host is HAOS and the SSH user is provided by the local SSH alias; verify the target before host-level changes.

## MCP and safety

- Prefer the native `/api/mcp` surface and inspect its current tools, prompts, and resources before acting.
- Respect Home Assistant’s exposed-entity controls; only read or control what the MCP integration exposes.
- Keep the MCP endpoint local through `127.0.0.1:18123` and the SSH tunnel to `has:127.0.0.1:8123`.
- Never print or commit Home Assistant tokens, cookies, secrets, or unrestricted state dumps.
- Before mutating configuration or live state, inspect first, validate configuration, back up, apply the narrowest change, and verify through MCP.
