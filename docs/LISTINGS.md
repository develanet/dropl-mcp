# Dropl MCP listings

Where Dropl MCP is listed, and how to publish it. Update **Date** and **Status** as each one goes live.

Use the canonical copy everywhere (it lives in `src/metadata.ts`; tests keep `package.json`, `server.json`, the README, and dropl.io/mcp in sync):

- **Name:** Dropl MCP
- **Short description:** Create client-editable photo and video galleries from Cursor or Claude Code, then embed them.
- **Long description:** Dropl MCP lets AI coding agents set up Dropl for client websites: create client sites and showcases (embeddable photo and video galleries), upload whole folders of media with categories, fetch embed code for HTML, Next.js, WordPress, Webflow, and Framer, manage collections like menus, inventory, and events, and work through client feedback by fixing it in code, replying, and marking it done. Clients then update their own photos and videos from a phone, without a CMS.
- **Install:** `{"command":"npx","args":["-y","@dropl/mcp@latest"]}`, then `npx -y @dropl/mcp login`
- **Website:** https://www.dropl.io/mcp
- **Registry name:** `io.dropl/mcp`

## Directories

Submission URLs were checked on 2026-10-03.

| Directory | Submission URL | Date | Status |
| --- | --- | --- | --- |
| Official MCP Registry | `mcp-publisher publish` (see below); browse at https://registry.modelcontextprotocol.io | 2026-10-04 | Live: `io.dropl/mcp` 0.6.0, active, latest. |
| Glama | https://glama.ai/mcp/servers | | Not listed. No submit form; Glama indexes public GitHub repos. Once the public mirror is indexed, claim the listing from its page. |
| PulseMCP | https://www.pulsemcp.com/submit | | Not listed. Submissions paused (page updated 2026-09-03); PulseMCP says it picks up servers from the official registry. |
| Smithery | `pnpm --filter @dropl/mcp publish:smithery --name isaias/dropl` (see below) | | Not listed. Bundle ready: publish `build/dropl.mcpb` as `isaias/dropl` (a local stdio bundle; URL publishing doesn't fit because the server uploads files from the user's disk). `smithery mcp publish` was rejected on 2026-10-03 (tools without `inputSchema`); use the script. Needs a Smithery API key. |
| mcp.so | https://mcp.so/submit | | Not listed. |
| MCP Market | https://mcpmarket.com/submit | | Not listed. |
| awesome-mcp-servers (punkpeye) | https://github.com/punkpeye/awesome-mcp-servers (pull request adding one line to the README) | | Not submitted. Follow the repo's CONTRIBUTING notes for the category and line format. |
| cursor.directory | https://cursor.directory/mcp/new | | Not listed. Plugin files added (`plugin.json`, `mcp.json`, `skills/`); re-scan the repo after the mirror workflow pushes them to the public repo. URL not confirmed: the site's bot check blocked the automated check, so open it in a browser. |
| LobeHub | https://lobehub.com/mcp (publish with the `lhm` CLI, guide at https://lobehub.com/publish-mcp/skill.md) | | Not listed. Needs the public GitHub repo; the CLI needs Node.js 22 or later. |

## MCP Registry

The registry name `io.dropl/mcp` is proven with a DNS record on `dropl.io`, and the npm package is matched by `"mcpName": "io.dropl/mcp"` in `package.json`.

1. Generate a key pair (keep `key.pem` secret, out of the repo):

   ```sh
   openssl genpkey -algorithm Ed25519 -out key.pem
   PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
   echo "dropl.io. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
   ```

2. Add that TXT record to the apex `dropl.io` (not a subdomain), and check it: `dig +short TXT dropl.io`.
3. Get the private key in the hex form the publisher takes, and store it as the `MCP_PRIVATE_KEY` secret of the `mcp-release` environment:

   ```sh
   openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'
   ```

4. Publish `@dropl/mcp` to npm first; the registry checks that the npm version exists and carries the `mcpName`.
5. Publish, either from CI (`.github/workflows/mcp-release.yml`) or by hand from `packages/mcp`:

   ```sh
   mcp-publisher validate
   mcp-publisher login dns --domain dropl.io --private-key "$PRIVATE_KEY"
   mcp-publisher publish
   ```

Install the publisher with:

```sh
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
```

## Smithery / MCPB bundle

`manifest.json` describes the MCP Bundle (`.mcpb`, manifest version 0.3) that Smithery and Claude Desktop install as a local stdio server. The bundle holds `server/index.js` (the server with every dependency bundled in, no `node_modules`), a dependency-free `package.json`, `manifest.json`, `icon.png`, and `LICENSE`. Its optional, secret **Dropl API key** setting becomes `DROPL_API_KEY`; left blank, the server uses the sign-in saved by `npx -y @dropl/mcp login`.

Build it from the monorepo root (the mirror can't build it; see Public mirror):

```sh
pnpm --filter @dropl/mcp bundle
```

That stages `packages/mcp/build/mcpb/` and writes `packages/mcp/build/dropl.mcpb` (about 300 kB; `build/` is gitignored and isn't in the npm tarball). It also starts the staged server over stdio and writes its `initialize` + `tools/list` result to `build/server-card.json`, failing if the tools differ from `manifest.json`. `mcpb pack` validates the manifest; to check it on its own, run `pnpm --filter @dropl/mcp exec mcpb validate manifest.json`. To try it locally, open the `.mcpb` file with Claude Desktop.

Publish to Smithery with `scripts/publish-smithery.mjs`, not `smithery mcp publish`. The Smithery CLI (4.11.1) copies `manifest.json`'s `tools` into the release's server card, and the MCPB 0.3 schema only allows a name and description there, while Smithery requires each tool's `inputSchema`; the API rejects that release with one `Invalid input: expected object, received undefined` per tool. The script uploads the same `build/dropl.mcpb` with the full server card from `build/server-card.json`, using the same API calls as the CLI. It reads a Smithery API key (https://smithery.ai/account/api-keys) from `SMITHERY_API_KEY` only:

```sh
pnpm --filter @dropl/mcp publish:smithery --name isaias/dropl --dry-run   # checks the payload, writes build/smithery-payload.json, sends nothing
SMITHERY_API_KEY=… pnpm --filter @dropl/mcp publish:smithery --name isaias/dropl
```

On each release, bump `version` in `package.json` and run `pnpm --filter @dropl/mcp sync-version`: it writes the same version into `server.json`, `manifest.json`, and `plugin.json` (`--check` fails instead, for CI). Only `manifest.json`'s `tools` list needs a manual edit when tools change. `test/mcpb-manifest.test.ts` fails if the version or the tools drift, and the bundle script refuses a version mismatch.

## Release workflows

Both are off until their repository variable is `true`. Setup steps are in the comments at the top of each file.

| Workflow | Trigger | Variable | Environment and secrets |
| --- | --- | --- | --- |
| `.github/workflows/mcp-release.yml` | tag `mcp-v<version>`, or manual (dry run by default) | `MCP_RELEASE_ENABLED` | `mcp-release`: `NPM_TOKEN`, `MCP_PRIVATE_KEY` |
| `.github/workflows/mcp-mirror.yml` | tag `mcp-v<version>`, or manual | `MCP_MIRROR_ENABLED`, `MCP_MIRROR_REPO` | `mcp-mirror`: `MCP_MIRROR_DEPLOY_KEY` |

The release refuses a tag that doesn't match `package.json`, checks `server.json`, `manifest.json`, and `plugin.json` with `sync-version --check`, runs the tests and `check-tools`, then publishes to npm and the registry.

## Public mirror

`repository` and `bugs` in `package.json`, and `repository` in `server.json`, point at the public mirror `https://github.com/develanet/dropl-mcp` (no `directory`/`subfolder`), since the monorepo is private.

The mirror is for reading the source, not building it: its dev dependencies (`@dropl/shared`, `@dropl/typescript-config`) are workspace packages that only exist in the monorepo.

GitHub About for the mirror:

- **Description:** Create client-editable photo and video galleries from Cursor or Claude Code, then embed them.
- **Website:** https://www.dropl.io/mcp
- **Topics:** mcp, mcp-server, model-context-protocol, cursor, claude-code, photo-gallery, video-hosting, nextjs, webflow, framer, headless-cms
