# OpenClaw Node Integration — Design Spec

## Problem

OpenBrain is powerful inside Obsidian but isolated. OpenClaw provides a multi-channel AI gateway (WhatsApp, Slack, Telegram, etc.) with a node protocol for extending capabilities. Connecting them means:

- Capture notes from any messaging channel into the vault
- Run OpenBrain skills from your phone
- Use the vault as OpenClaw's long-term memory
- Get notifications about vault events through any channel

## Solution

OpenBrain registers as an **OpenClaw node** over WebSocket, advertising vault capabilities as invocable commands. This is **opt-in** — disabled by default, enabled via a toggle in settings.

## Architecture

```
OpenClaw Gateway (ws://127.0.0.1:18789)
    ↕ WebSocket
OpenBrain Node (src/openclawNode.ts)
    ↕ function calls
Vault operations (chatHistory, templates, people, obsidianCli, vaultIndex)
```

OpenBrain connects as a node with `mode: "node"` and advertises vault-specific commands. The gateway can then route requests from any channel (WhatsApp, Slack, CLI) to OpenBrain's vault operations.

## Node Capabilities

Commands OpenBrain advertises:

| Command | Description | Parameters |
|---------|-------------|------------|
| `vault.search` | Full-text vault search | `{ query: string }` |
| `vault.read` | Read a note's content | `{ path: string }` |
| `vault.create` | Create a note from template | `{ name: string, template?: string, content?: string }` |
| `vault.daily.read` | Read today's daily note | `{}` |
| `vault.daily.append` | Append to daily note section | `{ section: string, content: string }` |
| `vault.capture` | Quick capture to daily note | `{ text: string }` |
| `vault.tasks` | Get open tasks | `{ file?: string, filter?: "todo"\|"done" }` |
| `vault.skills.list` | List available skills | `{}` |
| `vault.people.list` | List person profiles | `{}` |
| `vault.chat.search` | Search chat history | `{ query: string }` |

## Connection Flow

1. User enables "OpenClaw integration" in OpenBrain settings
2. On plugin load, `OpenClawNode` connects to `ws://127.0.0.1:18789`
3. Responds to `connect.challenge` with node metadata
4. Sends `connect` with:
   ```json
   {
     "mode": "node",
     "name": "OpenBrain",
     "platform": "obsidian",
     "capabilities": ["vault"],
     "commands": { ... }
   }
   ```
5. Gateway confirms with `hello-ok`
6. Node listens for `node.invoke.request` events
7. Executes commands against vault, returns results

## New Module: `src/openclawNode.ts`

```typescript
interface OpenClawNodeConfig {
  gatewayUrl: string;  // default: ws://127.0.0.1:18789
  enabled: boolean;
}

class OpenClawNode {
  constructor(app: App, settings: OpenBrainSettings)
  connect(): void
  disconnect(): void
  private handleInvoke(command: string, params: any): Promise<any>
}
```

Lifecycle:
- Created in `main.ts` during `onload` if enabled
- `connect()` called in `onLayoutReady` (after vault init)
- `disconnect()` called in `onunload`
- Auto-reconnects on disconnect (with backoff)

## Settings

New fields in `OpenBrainSettings`:

```typescript
openclawEnabled: boolean;     // default: false
openclawGatewayUrl: string;   // default: "ws://127.0.0.1:18789"
```

New settings UI section "OpenClaw" (only shown if toggle is on):
- Toggle: Enable OpenClaw integration
- Text: Gateway URL
- Status indicator: Connected / Disconnected / Error

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/openclawNode.ts` | **Create** | WebSocket node client, command handlers |
| `src/settings.ts` | **Modify** | Add openclawEnabled, openclawGatewayUrl + UI |
| `src/main.ts` | **Modify** | Create/connect/disconnect node on lifecycle |

## Edge Cases

- **Gateway not running** — connection fails silently, retries with exponential backoff. No error shown unless user explicitly enabled it.
- **Gateway restarts** — node reconnects automatically.
- **Vault not ready** — commands return error if called before `onLayoutReady`.
- **Permission model** — all vault operations respect the same write/cli toggles as the panel. Read operations always allowed; write operations require `allowVaultWrite` in settings.
- **Multiple Obsidian windows** — only one OpenBrain instance should connect. Use a lock or first-connect-wins.

## Security

- Connection is localhost-only by default (`ws://127.0.0.1:18789`)
- No vault data is sent proactively — only in response to explicit commands
- Write operations gated by the same permissions as the panel
- Users must explicitly enable in settings (off by default)
