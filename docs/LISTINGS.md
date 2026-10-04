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
| Official MCP Registry | `mcp-publisher publish` (see below); browse at https://registry.modelcontextprotocol.io | | Not published. Needs npm publish and the DNS record first. |
| Glama | https://glama.ai/mcp/servers | | Not listed. No submit form; Glama indexes public GitHub repos. Once the public mirror is indexed, claim the listing from its page. |
| PulseMCP | https://www.pulsemcp.com/submit | | Not listed. Submissions paused (page updated 2026-09-03); PulseMCP says it picks up servers from the official registry. |
| Smithery | https://smithery.ai/new | | Not listed. Needs a Smithery sign-in. |
| mcp.so | https://mcp.so/submit | | Not listed. |
| MCP Market | https://mcpmarket.com/submit | | Not listed. |
| awesome-mcp-servers (punkpeye) | https://github.com/punkpeye/awesome-mcp-servers (pull request adding one line to the README) | | Not submitted. Follow the repo's CONTRIBUTING notes for the category and line format. |
| cursor.directory | https://cursor.directory/mcp/new | | Not listed. URL not confirmed: the site's bot check blocked the automated check, so open it in a browser. |
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

## Release workflows

Both are off until their repository variable is `true`. Setup steps are in the comments at the top of each file.

| Workflow | Trigger | Variable | Environment and secrets |
| --- | --- | --- | --- |
| `.github/workflows/mcp-release.yml` | tag `mcp-v<version>`, or manual (dry run by default) | `MCP_RELEASE_ENABLED` | `mcp-release`: `NPM_TOKEN`, `MCP_PRIVATE_KEY` |
| `.github/workflows/mcp-mirror.yml` | tag `mcp-v<version>`, or manual | `MCP_MIRROR_ENABLED`, `MCP_MIRROR_REPO` | `mcp-mirror`: `MCP_MIRROR_DEPLOY_KEY` |

The release refuses a tag that doesn't match `package.json`, checks `server.json` with `sync-version --check`, runs the tests and `check-tools`, then publishes to npm and the registry.

## Public mirror

`repository` and `bugs` in `package.json`, and `repository` in `server.json`, point at the public mirror `https://github.com/develanet/dropl-mcp` (no `directory`/`subfolder`), since the monorepo is private.

The mirror is for reading the source, not building it: its dev dependencies (`@dropl/shared`, `@dropl/typescript-config`) are workspace packages that only exist in the monorepo.

GitHub About for the mirror:

- **Description:** Create client-editable photo and video galleries from Cursor or Claude Code, then embed them.
- **Website:** https://www.dropl.io/mcp
- **Topics:** mcp, mcp-server, model-context-protocol, cursor, claude-code, photo-gallery, video-hosting, nextjs, webflow, framer, headless-cms
