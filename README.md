# @dropl/mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI coding agents (Cursor, Claude Code, and other MCP clients) work with your [Dropl](https://www.dropl.io) account. From a prompt in your editor, the agent can:

- create a client site and a showcase (an embeddable photo/video gallery),
- upload photos and videos from your computer, organized into categories from your folders,
- fetch the official embed code and paste it into the project you're building.

Uploads go straight from your computer to Dropl's storage, are resumable, and are safe to re-run. The agent is told to show you a plan and get your confirmation before it creates anything or uploads.

## Quick start

Requires Node.js 22 or newer. Nothing to install: your MCP client runs it with `npx`.

1. Sign in once from a terminal. This opens your browser so you can approve access; the key is saved on this computer.

   ```sh
   npx -y @dropl/mcp login
   ```

2. Add the server to your MCP client (below), then ask your agent something like *"Upload the photos in ./assets/portfolio to a new Dropl showcase for this client and embed it on the Work page."*

## Authentication

Choose one:

- **Browser sign-in (recommended):** `npx -y @dropl/mcp login`. It shows a code, opens the Dropl approval page, and saves the resulting API key. Use `--client "Cursor"` to label it, `--no-browser` to just print the link, and `--api-url` for a non-production API.
- **API key:** create one in Dropl → Settings → API keys and set it as `DROPL_API_KEY` in the MCP server's environment. When it's set, it takes precedence over the saved sign-in.

Only account owners and admins can approve sign-ins or create API keys. Keys can be limited to specific client sites and scopes.

Other commands:

```sh
npx -y @dropl/mcp whoami    # show the connected account and key
npx -y @dropl/mcp logout    # remove the saved key from this computer
```

`logout` only deletes the local copy. To disable a key, revoke it in Dropl → Settings → API keys.

## Client configuration

### Cursor

In `.cursor/mcp.json` (this project) or `~/.cursor/mcp.json` (all projects):

```json
{
  "mcpServers": {
    "dropl": {
      "command": "npx",
      "args": ["-y", "@dropl/mcp"]
    }
  }
}
```

With an API key instead of the browser sign-in:

```json
{
  "mcpServers": {
    "dropl": {
      "command": "npx",
      "args": ["-y", "@dropl/mcp"],
      "env": { "DROPL_API_KEY": "dropl_live_…" }
    }
  }
}
```

Don't commit a config file that contains a key. Use the user-level `~/.cursor/mcp.json`, or keep the project file out of version control.

### Claude Code

```sh
claude mcp add dropl -- npx -y @dropl/mcp
```

With an API key:

```sh
claude mcp add dropl -e DROPL_API_KEY=dropl_live_… -- npx -y @dropl/mcp
```

### Other MCP clients

Use a stdio server with command `npx` and arguments `["-y", "@dropl/mcp"]`. Add `DROPL_API_KEY` to its environment if you aren't using the browser sign-in.

## Tools

| Tool | What it does |
| --- | --- |
| `plan_migration` | Scans a local folder without uploading anything. Returns per-folder photo/video counts and sizes, unsupported files, proposed categories, and the steps to run. |
| `whoami` | Connected account, user, role, key name/prefix, scopes, and site restriction. |
| `list_sites` / `create_site` | List client sites, or create one (name, optional domain). |
| `list_showcases` / `create_showcase` | List a site's showcases, or create one (title, layout, grid fit, category filters, page size). |
| `get_showcase` / `update_showcase` | Summarize a showcase (items by status and category, failures), or change its settings. |
| `create_category` | Add a category to a showcase; an existing one with the same name is reused. |
| `tag_items` | Add or remove categories on showcase items. |
| `upload_photos` | Upload photos from files, folders, or globs into a showcase. Optionally creates categories from folders. Supports dry runs and resuming. |
| `list_videos` | List a site's videos. |
| `upload_videos` | Upload videos to a site's library in resumable parts, and optionally add them to a showcase with categories. |
| `add_videos_to_showcase` | Add existing library videos to a showcase. |
| `get_embed_code` | The embed snippet for a video or a showcase (or one category), plus how to paste it in HTML, React/Next.js, WordPress, Webflow, and Framer. |
| `get_usage` | Storage and bandwidth used against your plan, and whether uploads are suspended. |
| `list_collections` | A site's collections (menus, inventory, events) with item counts and plan limits. |
| `get_collection_schema` | A collection's current fields and `schemaVersion`, including edits made in the dashboard. |
| `plan_collections` / `apply_collection_plan` | Preview creating or changing collections as a plain-text diff, then apply it. Destructive changes need `confirmDestructive`; plans made from an outdated schema are refused. |
| `add_collection_items` | Bulk-add items with per-item errors. Dry runs by default; retries don't duplicate. |
| `list_collection_items` | List items with search, status and field filters, sorting, and paging. |
| `get_collection_code` | TypeScript types and a Next.js fetch example for a collection. |
| `undo_collection_change` | Undo the most recent schema change when no data would be lost. |

Collections need an API key with the `collections:read` scope to read, `collections:write` to add items, and `collections:schema` to create or change collections.

Supported uploads: JPEG, PNG, WebP, AVIF, and HEIC photos up to 20 MB each, checked by file contents as well as extension. MP4, MOV, WebM, MKV, AVI, MPEG, and M4V videos. Hidden files are skipped. Symlinks that point outside the folder being uploaded are not followed.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DROPL_API_KEY` | API key to use instead of the saved sign-in. |
| `DROPL_API_URL` | API base URL. Defaults to `https://www.dropl.io/api`. Plain `http://` is accepted only for `localhost`/`127.0.0.1`, e.g. `http://localhost:3000/api` for local development. |

## Security

- The saved key lives in `~/.config/dropl/credentials.json` (`$XDG_CONFIG_HOME/dropl` if set, `%APPDATA%\dropl` on Windows). The folder is created with mode `0700` and the file is written atomically with mode `0600`. The server refuses to read the file if other users can read it.
- Keys are never printed in full; only their prefix (e.g. `dropl_live_ab12…`) is shown. The agent is told never to ask you to paste a key into the chat.
- Keys are only sent to the configured Dropl API over HTTPS, and redirects are never followed. Files are uploaded to storage through short-lived signed URLs; your key is never sent to storage.
- To resume interrupted uploads, a small manifest of upload progress is kept in `~/.config/dropl/uploads/`. It records file paths and Dropl ids, never file contents.
- You can revoke any key at any time in Dropl → Settings → API keys.
