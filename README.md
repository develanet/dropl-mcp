<!-- mcp-name: io.dropl/mcp -->

# Dropl MCP

Create client-editable photo and video galleries from Cursor or Claude Code, then embed them.

[![npm version](https://img.shields.io/npm/v/@dropl/mcp)](https://www.npmjs.com/package/@dropl/mcp)
[![License: MIT](https://img.shields.io/npm/l/@dropl/mcp)](./LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.dropl%2Fmcp-0b7285)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.dropl/mcp)

Dropl MCP lets AI coding agents set up Dropl for client websites: create client sites and showcases (embeddable photo and video galleries), upload whole folders of media with categories, fetch embed code for HTML, Next.js, WordPress, Webflow, and Framer, manage collections like menus, inventory, and events, and work through client feedback by fixing it in code, replying, and marking it done. Clients then update their own photos and videos from a phone, without a CMS.

It's an [MCP](https://modelcontextprotocol.io) server for [Dropl](https://www.dropl.io/mcp), which gives you client-editable galleries, video hosting for agencies (an ad-free Vimeo alternative), and client feedback, for people who build client sites in code or on WordPress, Webflow, and Framer. Uploads go straight from your computer to Dropl's storage, are resumable, and are safe to re-run. The agent is told to show you a plan and get your confirmation before it creates anything or uploads.

<!--
  Demo GIFs go here. Not recorded yet; see "Demos to record" at the end of this file.
  ![Fixing open client feedback from Cursor](./docs/media/fix-feedback.gif)
  ![A folder of photos becomes an embedded showcase](./docs/media/folder-to-embed.gif)
-->

## Install

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=dropl&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBkcm9wbC9tY3BAbGF0ZXN0Il19)
[![Add to VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=dropl&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40dropl%2Fmcp%40latest%22%5D%7D)

Or add it by hand: see [Client configuration](#client-configuration). Requires Node.js 20.3 or later. Nothing to install: your MCP client runs it with `npx`.

Then sign in once from a terminal. This opens your browser so you can approve access; the key is saved on this computer.

```sh
npx -y @dropl/mcp login
```

## What you can ask

- *"Upload the photos in ./assets/portfolio to a new Dropl showcase for this client, one filter tab per folder."*
- *"Embed that showcase on the Work page."*
- *"I downloaded our Vimeo videos to ~/vimeo-export. Move them to Dropl and swap the Vimeo embeds for Dropl ones."*
- *"Make the menu on this site a Dropl collection my client can edit."*
- *"Fix the open Dropl feedback for this site."*
- *"Write alt text for the photos in the Projects showcase that are missing it."*
- *"How much storage and bandwidth does this client have left?"*

The agent plans first and asks before it creates, uploads, or changes a collection's fields.

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
      "args": ["-y", "@dropl/mcp@latest"]
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
      "args": ["-y", "@dropl/mcp@latest"],
      "env": { "DROPL_API_KEY": "dropl_live_…" }
    }
  }
}
```

Don't commit a config file that contains a key. Use the user-level `~/.cursor/mcp.json`, or keep the project file out of version control.

### Claude Code

```sh
claude mcp add dropl -- npx -y @dropl/mcp@latest
```

With an API key:

```sh
claude mcp add dropl -e DROPL_API_KEY=dropl_live_… -- npx -y @dropl/mcp@latest
```

### Other MCP clients

Use a stdio server with command `npx` and arguments `["-y", "@dropl/mcp@latest"]`. Add `DROPL_API_KEY` to its environment if you aren't using the browser sign-in.

## Tools

| Tool | What it does |
| --- | --- |
| `plan_migration` | Scans a local folder without uploading anything. Returns per-folder photo/video counts and sizes, unsupported files, proposed categories, and the steps to run. With `layout: "projects"` (or a `projects/` folder of project folders), plans one project per folder with its title, slug, and counts. |
| `whoami` | Connected account, user, role, key name/prefix, scopes, and site restriction. |
| `list_sites` / `create_site` | List client sites, or create one (name, optional domain). |
| `list_showcases` / `create_showcase` | List a site's showcases with their type and project counts, or create one (title, `type` gallery or projects, layout, grid fit, category filters, page size). |
| `get_showcase` / `update_showcase` | Summarize a showcase (items by status and category, projects, photos without alt text, failures), or change its settings. |
| `list_showcase_items` | Page through a showcase's items: id, kind, status, file name, the local path it was uploaded from, alt text, and categories. Filter by kind, missing alt text, category, or text. |
| `update_items` | Set alt text and add or remove categories on many items in one call, by the ids uploads return (library video ids work too). Missing categories are created. |
| `create_category` | Add a category to a showcase; an existing one with the same name is reused. |
| `tag_items` | Add or remove categories on showcase items, by the ids uploads return. |
| `upload_photos` | Upload photos from files, folders, or globs into a showcase, with optional alt text and categories per photo (`files`). Optionally creates categories from folders. In a projects showcase, pass `project` to upload into that project. Supports dry runs and resuming. Returns each file's showcase item id. |
| `list_videos` | List a site's videos. |
| `upload_videos` | Upload videos to a site's library in resumable parts, and optionally add them to a showcase with categories (or to one of its projects with `project`). Returns each file's video id (and showcase item id). |
| `add_videos_to_showcase` | Add existing library videos to a showcase, or to one of its projects. |
| `get_embed_code` | The embed snippet for a video or a showcase (or one category or project), plus how to paste it in HTML, React/Next.js, WordPress, Webflow, and Framer. For projects showcases, `projectUrl` (e.g. `/work/{slug}`) links index cards to a page per project. |
| `list_projects` | A projects showcase's projects in order (excerpt, details, categories, counts), or one project with its full description and its photos and videos. |
| `create_project` / `update_project` | Add a project (title, subtitle, description, slug, details, categories), or change one, including its cover. An existing project with the same title or slug is reused. |
| `reorder_projects` / `reorder_project_items` | Set the order of the projects, or of the photos and videos inside one project. Partial lists go first; the rest keep their order. |
| `get_project_details` | A projects showcase's custom details (fields like location or year) and their `version`, including edits made in the dashboard. |
| `plan_project_details` / `apply_project_details` | Preview a change to the project details without saving, then apply it with the `expectedVersion` you read. Keys never change; removing values needs `confirmDestructive`. |
| `get_usage` | Storage and bandwidth used against your plan, and whether uploads are suspended. |
| `list_collections` | A site's collections (menus, inventory, events) with item counts and plan limits. |
| `get_collection_schema` | A collection's current fields and `schemaVersion`, including edits made in the dashboard. |
| `plan_collections` / `apply_collection_plan` | Preview creating or changing collections as a plain-text diff, then apply it. Destructive changes need `confirmDestructive`; plans made from an outdated schema are refused. |
| `add_collection_items` | Bulk-add items with per-item errors. Dry runs by default; retries don't duplicate. |
| `list_collection_items` | List items with search, status and field filters, sorting, and paging. |
| `get_collection_code` | TypeScript types and a Next.js fetch example for a collection. |
| `undo_collection_change` | Undo the most recent schema change when no data would be lost. |
| `list_feedback` | Feedback clients left on a site (comments, text changes, notes). Defaults to open and in progress; filter by status, type, and page. |
| `get_feedback` | One request with its full context: page, clicked element (selector and text), device, screenshot and photos, and the thread. |
| `reply_to_feedback` | Reply in a request's thread, e.g. to ask the client to clarify. The client is emailed; retries don't post twice. |
| `update_feedback_status` | Set open, in progress, done, or won't do, with a short note. Marking done emails the client. |

Collections need an API key with the `collections:read` scope to read, `collections:write` to add items, and `collections:schema` to create or change collections.

Feedback needs `feedback:read` to read and `feedback:write` to reply or change status. Keys created before Feedback existed don't have these scopes; run `npx -y @dropl/mcp login` again to get a new key. Ask your agent to *"fix the open Dropl feedback"*: it reads each request, applies text changes in the code, asks the client when something is unclear, and marks the fixed ones done.

### Upload results, ids, and alt text

`upload_photos` and `upload_videos` return a `files` list mapping each local path to its Dropl id, with a status of `uploaded`, `already_uploaded` (skipped on a re-run, id included), `failed` (with `error`), or `pending` (dry run). The first 100 are listed; `omitted` and `more` say how to page through the rest with `list_showcase_items`.

```json
{
  "uploaded": 2,
  "alreadyUploaded": 1,
  "altTextSet": 2,
  "files": {
    "count": 3,
    "items": [
      { "path": "Decks/cedar.jpg", "id": "0190…a1", "status": "uploaded" },
      { "path": "Decks/railing.jpg", "id": "0190…a2", "status": "uploaded" },
      { "path": "kitchen.jpg", "id": "0190…a0", "status": "already_uploaded" }
    ],
    "omitted": 0,
    "more": null
  }
}
```

Set alt text and categories per photo at upload time:

```json
{
  "showcaseId": "…",
  "files": [
    { "path": "/abs/photos/cedar.jpg", "alt": "Cedar deck with glass railing at dusk", "categories": ["Decks"] },
    { "path": "/abs/photos/texture.jpg", "alt": "" }
  ]
}
```

Or later, without uploading again: `update_items` with `{ "showcaseId": "…", "items": [{ "id": "0190…a1", "alt": "Cedar deck at dusk", "addCategories": ["Decks"] }] }`. Write concise, descriptive alt text (what the photo shows, without "image of"), and leave it empty for purely decorative photos. Alt text is at most 500 characters. Changing alt text needs the `showcases:write` scope.

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

## FAQ

**Is it free?** The MCP server is free and open source (MIT). It works with a Dropl account; new accounts start with a free trial, no credit card, and plans are priced per client site, not per seat. See [pricing](https://www.dropl.io/pricing).

**Does my client need an account?** Only to edit. Invite your client from Dropl → Settings → Sites and they get a client portal that shows just their site, where they update their own photos and videos from a phone, edit collections, and request changes. It's a CMS alternative for client sites: nothing to learn, and they never touch the code. Visitors to the website need nothing.

**Which site builders work?** Anything that accepts an embed or a script tag. `get_embed_code` returns a photo gallery embed or video player, with paste instructions for plain HTML, React and Next.js, WordPress, Webflow, and Framer, so the same showcase works as a Webflow gallery or a Framer gallery. For sites written in code, collections are also served as JSON: headless media for Next.js without running a CMS.

**Where are files stored?** In your Dropl account. Uploads go straight from your computer to Dropl's storage through short-lived signed URLs, and embeds serve them from there. On your computer, the server keeps only the sign-in key and a small upload log (see [Security](#security)).

## Demos to record

Placeholders above until these exist. Record at 1280×800 or so, keep each under 30 seconds, and save them to `docs/media/`. npm doesn't ship that folder, so link them by absolute URL from the public repo (e.g. `https://raw.githubusercontent.com/<owner>/<repo>/main/docs/media/fix-feedback.gif`) so they show on npm too:

1. `fix-feedback.gif`: in Cursor, "Fix the open Dropl feedback for this site." Show the agent listing requests, editing the code, replying to one unclear request, and marking the rest done, then the client portal showing them as done.
2. `folder-to-embed.gif`: "Upload ./assets/portfolio to a new showcase and embed it on the Work page." Show the plan and the confirmation, the upload progress, the embed pasted into the page, and the gallery in the browser with filter tabs.
