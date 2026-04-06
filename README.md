# Vault Bridge for Obsidian

Sync your Obsidian vault to a Cloudflare R2 bucket so [Claude.ai](https://claude.ai) can read and write your notes from any device, even when your computer is off.

This is the **client plugin**. It pairs with the [Vault Bridge relay](https://vault-bridge.the-empyrean.com) — you'll need a token from your Vault Bridge admin to use it.

## How it works

```
Obsidian Plugin  ◀──sync──▶  Cloudflare R2  ◀──MCP──▶  Claude.ai
```

- The plugin watches your vault and pushes changes to R2
- When Claude reads or writes notes via MCP, it talks to R2 directly
- When Obsidian opens, the plugin pulls any changes Claude made while you were away
- Your vault is stored under your own private prefix in R2 — other users cannot see it

## Install with BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is a community plugin that installs other plugins straight from a GitHub repo. It's how you'll get this plugin until it's available in the official Obsidian community store.

### Steps

1. **Install BRAT** in Obsidian:
   - Settings → Community Plugins → Browse
   - Search "BRAT", install, and enable
2. **Add Vault Bridge** via BRAT:
   - Settings → BRAT → "Add Beta plugin"
   - Paste this URL: `https://github.com/the-empyrean-agora/vault-bridge-plugin`
   - Click "Add Plugin"
3. **Enable Vault Bridge**:
   - Settings → Community Plugins
   - Enable "Vault Bridge"
4. **Configure**:
   - Settings → Vault Bridge
   - Paste the token your admin gave you
   - Click "Initial upload" to push your existing vault to R2
5. **Add the connector to Claude.ai**:
   - Open Claude.ai → Settings → Integrations
   - Add an MCP connector with the URL your admin gave you
6. **Done.** Claude can now read and write your vault from any device.

BRAT will auto-update the plugin when new releases ship.

## Manual install (advanced)

If you'd rather not use BRAT, you can install manually:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/the-empyrean-agora/vault-bridge-plugin/releases/latest)
2. Place both files in `<your-vault>/.obsidian/plugins/vault-bridge/`
3. Reload Obsidian
4. Settings → Community Plugins → enable "Vault Bridge"

## Settings

Open Settings → Vault Bridge to configure:

| Setting | What it does |
|---|---|
| **Enabled** | Turn sync on/off without uninstalling the plugin |
| **Token** | Your Vault Bridge access token (provided by your admin) |
| **Relay URL** | The Vault Bridge relay endpoint — defaults to `https://vault-bridge.the-empyrean.com` |
| **Sync interval** | How often to do a full sync check (default: 60 seconds) |
| **Excluded folders** | Comma-separated paths to skip (defaults exclude Obsidian internals) |

Two action buttons at the bottom of the settings panel:

- **Sync now** — trigger a full sync immediately
- **Initial upload** — push every file in your vault to R2 (use once when first connecting a vault)

## Status bar

The plugin shows a small indicator in Obsidian's status bar:

| Icon | Meaning |
|---|---|
| `VB ○` | Idle, waiting |
| `VB ↻` | Syncing |
| `VB ✓` | Up to date |
| `VB ⚠` | Error (hover for details) |

## Conflicts

In normal use, conflicts are extremely rare:
- When Obsidian is open, the plugin syncs constantly, so Claude's writes are pulled almost immediately
- When Obsidian is closed, you're not editing files

If a true conflict happens — same file modified both locally and in R2 since the last sync — the **R2 version wins** and your local version is saved as `<filename>.conflict.md`. You can review and merge manually.

## Multiple devices

You can install this plugin on multiple devices (desktop, mobile) using the same token. Each device syncs with the same R2 prefix, and changes propagate through R2.

For example:
- Edit a note on your desktop → pushes to R2
- Open Obsidian on your phone → pulls the change
- Ask Claude to add to that note → writes to R2
- Both devices pull the change next time they sync

## Build from source

```bash
git clone https://github.com/the-empyrean-agora/vault-bridge-plugin
cd vault-bridge-plugin
npm install
npm run build
```

This produces `main.js`. Combined with `manifest.json`, that's the entire plugin.

## License

MIT
