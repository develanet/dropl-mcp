import type { Implementation, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ServerCard {
  serverInfo: Implementation | undefined;
  tools: Tool[];
}

export interface UserConfigOption {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  multiple?: boolean;
  sensitive?: boolean;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

export interface SmitheryStdioPayload {
  type: "stdio";
  runtime: "node";
  serverCard: ServerCard;
  configSchema?: JsonSchemaObject;
}

export declare const SMITHERY_RUNTIME: "node";
export declare function readServerCard(entryPath: string, clientVersion: string): Promise<ServerCard>;
export declare function userConfigToJsonSchema(userConfig: Record<string, UserConfigOption>): JsonSchemaObject;
export declare function buildSmitheryPayload(manifest: Record<string, unknown>, serverCard: ServerCard): SmitheryStdioPayload;
