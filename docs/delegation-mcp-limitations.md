# Delegation MCP Limitations

Terminal 64 delegation currently uses the app permission server as a local
HTTP bridge for team chat MCP tools. Child agents receive `send_to_team`,
`read_team`, and `report_done` only when their process environment or Claude
MCP config includes `T64_DELEGATION_PORT`, `T64_DELEGATION_SECRET`,
`T64_GROUP_ID`, and `T64_AGENT_LABEL`.

Known limitations:

- Team chat is in-memory per app process. Restarting Terminal 64 clears
  delegation messages, so the shared chat panel is operational state rather
  than durable history.
- Completion is strongest when a child calls `report_done`. If a child exits
  without that MCP call, the orchestrator uses an idle timeout fallback and may
  merge a terse last-message summary.
- Claude child sessions still run non-interactively with `bypass_all` because
  delegated `--print` children cannot surface permission prompts reliably.
  Codex children inherit the parent Codex sandbox/approval preset.
- The Rust delegation HTTP endpoints require `Content-Length` request bodies;
  chunked POSTs are not part of the supported bridge protocol.
- Shared chat is scoped by `group_id` and local secret only. It is designed for
  same-machine child agents, not remote or cross-device collaboration.
- Discord messages route through the visible frontend session via the
  `discord-prompt` event. If the relevant chat panel is not mounted, inbound
  Discord prompts cannot be forwarded to the provider turn pipeline.
