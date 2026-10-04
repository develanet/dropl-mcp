---
name: dropl-feedback
description: Works through the open feedback clients left on their website with Dropl (comments pinned to page elements, exact text changes, general notes), fixes them in this codebase, asks the client when a request is unclear, and marks fixed requests done so the client is emailed. Use when the user asks to fix, review, or triage Dropl feedback, client comments, or change requests.
license: MIT
compatibility: Requires the Dropl MCP server (npx -y @dropl/mcp@latest) and a Dropl sign-in.
---

# Fix open Dropl feedback

Clients leave feedback directly on their website. Each request records the page, the element they clicked, their device, a screenshot, and a thread. Your job is to apply what the client asked for in the code, reply when it isn't clear, and close the loop.

## Before you start

- Call `whoami` to confirm which Dropl account you're working in.
- If a tool says you're not signed in, ask the user to run `npx -y @dropl/mcp login` in their own terminal (or set DROPL_API_KEY in the MCP server config), then try again. Never ask the user to paste an API key into the chat.

## Workflow

1. **Find the site.** Call `list_sites` and pick the client site that matches this project (compare its domains with the project's deployed domain). If more than one could match, ask the user which one.
2. **List requests.** Call `list_feedback` with that `siteId`. It returns open and in progress requests by default. Use `type` or `page` to narrow the list, and `offset` to page through long lists.
3. **Read each request in full.** Call `get_feedback` for every request before changing any code. It returns the page URL, the element's CSS selector, tag, and nearby text, the device and viewport, screenshot and photo URLs, and the thread. Screenshot URLs are temporary, so fetch them when you need to look.
4. **Fix what's clear.**
   - Text changes (type `text_change`) give the current and the exact new wording. Search the project for the current text and replace it with the new wording exactly, including punctuation and capitalization. If the text appears in several places, change only the one on the requested page and element.
   - For comments and general notes, use the page path, the selector, and the nearby text to find the component or template. Make the smallest change that does what the client asked.
   - If the text comes from a Dropl collection or a CMS rather than the code, don't fake it in markup. Tell the user where the content lives.
5. **Ask when it's ambiguous.** If you can't tell what the client wants, or the request conflicts with something else, call `reply_to_feedback` with one short, plain question (no code) instead of guessing. Leave that request open.
6. **Verify.** Run the project's build (or type check, and tests if they exist) to make sure everything still compiles.
7. **Close the loop.** For each request you fixed, call `update_feedback_status` with status `done` and a short `resolutionNote` that says what changed, in the client's language (for example "Updated the opening hours on the contact page."). The client gets the note by email, so only mark a request done once the fix is in the code, and once it's deployed if the user asks for that. Use `wont_do` only when the user decides not to make a change, with a note explaining why.

## Report back

Finish by telling the user which requests you fixed (by number and page), which ones you asked the client about, and which ones you skipped and why.
