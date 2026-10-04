/*
 * The Smithery release payload for the MCPB bundle (a stdio release). `smithery mcp publish` copies manifest.json's
 * `tools` into the server card, but MCPB 0.3 only allows a name and description there, while Smithery's server card
 * requires each tool's inputSchema (the API rejects the release with one "expected object, received undefined" per
 * tool). So the card comes from the bundled server's own initialize + tools/list instead: bundle-mcpb.mjs writes it
 * to build/server-card.json, and publish-smithery.mjs sends it with the unchanged bundle.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

export const SMITHERY_RUNTIME = "node";
const SERVER_CARD_CLIENT_NAME = "dropl-mcpb-server-card";

/** Starts the server at `entryPath` over stdio (no API key: listing tools never needs one) and reads its card. */
export async function readServerCard(entryPath, clientVersion) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DROPL_API_KEY: "" },
    stderr: "ignore",
  });
  const client = new Client({ name: SERVER_CARD_CLIENT_NAME, version: clientVersion });
  await client.connect(transport);
  try {
    const serverInfo = client.getServerVersion();
    const { tools, nextCursor } = await client.listTools();
    if (nextCursor) throw new Error("tools/list is paginated; readServerCard only reads the first page.");
    return { serverInfo, tools };
  } finally {
    await client.close();
  }
}

/** The Smithery CLI's mapping: each user_config option becomes a property of one JSON Schema object. */
export function userConfigToJsonSchema(userConfig) {
  const properties = {};
  const required = [];
  for (const [key, option] of Object.entries(userConfig)) {
    if (key.includes(".")) throw new Error(`Nested user_config keys aren't supported here: ${key}`);
    const type = option.type === "directory" || option.type === "file" ? "string" : option.type;
    const details = {
      ...(option.title ? { title: option.title } : {}),
      ...(option.description ? { description: option.description } : {}),
      ...(option.default !== undefined ? { default: option.default } : {}),
    };
    properties[key] = option.multiple ? { type: "array", items: { type }, ...details } : { type, ...details };
    if (option.required) required.push(key);
  }
  return { type: "object", properties, required };
}

/** Throws unless the card's tools are valid MCP tools and exactly the ones manifest.json lists. */
export function buildSmitheryPayload(manifest, serverCard) {
  if (manifest.server?.type !== SMITHERY_RUNTIME) throw new Error(`manifest.json server.type must be "${SMITHERY_RUNTIME}".`);
  if (serverCard.serverInfo?.version !== manifest.version) {
    throw new Error(`The server reports version ${serverCard.serverInfo?.version}, manifest.json ${manifest.version}. Run pnpm bundle again.`);
  }
  const manifestToolNames = (manifest.tools ?? []).map((tool) => tool.name).sort();
  const serverToolNames = serverCard.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(manifestToolNames) !== JSON.stringify(serverToolNames)) {
    throw new Error(`manifest.json lists [${manifestToolNames.join(", ")}] but the server registers [${serverToolNames.join(", ")}].`);
  }
  for (const tool of serverCard.tools) {
    const result = ToolSchema.safeParse(tool);
    if (!result.success) throw new Error(`Tool ${tool.name} isn't a valid MCP tool: ${result.error.message}`);
  }
  const userConfig = manifest.user_config ?? {};
  return {
    type: "stdio",
    runtime: SMITHERY_RUNTIME,
    serverCard: { serverInfo: serverCard.serverInfo, tools: serverCard.tools },
    ...(Object.keys(userConfig).length > 0 ? { configSchema: userConfigToJsonSchema(userConfig) } : {}),
  };
}
