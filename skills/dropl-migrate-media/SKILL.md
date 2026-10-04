---
name: dropl-migrate-media
description: Moves a website's photo and video folders (project galleries, portfolios, hero videos) into Dropl showcases that the client can update from their phone, then replaces the old hard-coded gallery markup with Dropl embeds. Use when the user wants to migrate site images or videos to Dropl, turn a folder of photos into a client-editable gallery, or host videos without YouTube or Vimeo.
license: MIT
compatibility: Requires the Dropl MCP server (npx -y @dropl/mcp@latest) and a Dropl sign-in.
---

# Migrate site media into Dropl showcases

Dropl showcases are embeddable photo and video galleries that clients update themselves. This skill takes media that's committed to the project, uploads it into showcases, and swaps the gallery code for an embed.

Don't create or upload anything until the user has seen the plan and explicitly confirmed it.

## Before you start

- Call `whoami` to confirm the account. If a tool says you're not signed in, ask the user to run `npx -y @dropl/mcp login` in their own terminal (or set DROPL_API_KEY in the MCP server config), then try again. Never ask the user to paste an API key into the chat.
- Find where the gallery media lives (for example `public/projects/`) and which components or pages render it. Always pass absolute paths to the Dropl tools, or set `cwd` to the project folder.

## 1. Plan (nothing is saved)

1. Call `plan_migration` on the media folder. It scans offline and reports photo and video counts and sizes per folder, the categories that top-level folders would become, unsupported files and why, upload batches, remaining storage (when signed in), and warnings, for example when the folder holds more than one showcase allows.
2. Call `list_sites` to find the client's site, and `list_showcases` to see if a matching gallery already exists. Reuse an existing site or showcase instead of creating a duplicate.
3. Show the user the plan: the client site, the showcase title (or titles, if the plan says to split), the categories, the file counts and sizes, and any unsupported files or warnings. Wait for their explicit confirmation.

## 2. Create and upload (after confirmation)

1. If the client has no site yet, call `create_site` with the client's name and domain.
2. If no showcase fits, call `create_showcase`. Set `showCategoryFilters: true` when items will be grouped into categories. When the plan says to split, create one showcase per part, for example one per top-level folder.
3. Call `upload_photos` with `dryRun: true` first, using `categoryFromFolder: true` if folders should become categories. Show the result to the user, then run the same call without `dryRun` once they confirm.
   - Write alt text for each photo with `files[].alt`: say what the photo shows (for example "Cedar deck with glass railing at dusk"), without "image of" or "photo of". Leave it empty for purely decorative photos. Show the user the alt text you plan to write before saving a large batch.
4. For videos, call `upload_videos` with the `siteId`, the paths, and the `showcaseId` to add them to the gallery. Again, run it with `dryRun: true` first and get confirmation. For videos already in the Dropl library (see `list_videos`), use `add_videos_to_showcase` instead of uploading them again.
5. Uploads are resumable and idempotent. If one stops partway, run the same call again; finished files are skipped.
6. Call `get_showcase` to check that items finished processing and to see any failed items or photos still missing alt text. Fix alt text and categories with `update_items` or `tag_items`, using the item ids the uploads returned (`files[].id`) or ids from `list_showcase_items`. Don't upload the same files again.
7. Call `get_usage` before very large uploads, or if an upload reports a storage or suspension problem.

## 3. Embed

1. Call `get_embed_code` with the `showcaseId` (or a `videoId` for a single video). Pass `category` to embed only one category. Always use the snippet it returns; never write embed HTML by hand.
2. Replace the old gallery markup with the snippet, following the framework notes in the response (plain HTML, React/Next.js, WordPress, Webflow, Framer).
3. Ask the user before deleting the original media files from the repo. Other pages may still use them.
4. Run the project's build (or type check) to make sure it still compiles.

## Report back

Tell the user which showcases you created or reused, how many photos and videos you uploaded, anything that was skipped or failed, and which files you changed to add the embed.
