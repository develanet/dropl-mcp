import {
  COLLECTION_BULK_MAX_ITEMS,
  COLLECTION_DESCRIPTION_MAX_LENGTH,
  COLLECTION_FIELD_HELP_MAX_LENGTH,
  COLLECTION_FIELD_KEY_MAX_LENGTH,
  COLLECTION_FIELD_KEY_PATTERN,
  COLLECTION_FIELD_LABEL_MAX_LENGTH,
  COLLECTION_FIELD_MAX_OPTIONS,
  COLLECTION_FIELD_TYPES,
  COLLECTION_ITEM_SLUG_MAX_LENGTH,
  COLLECTION_MAX_FIELDS,
  COLLECTION_NAME_MAX_LENGTH,
  COLLECTION_OPTION_LABEL_MAX_LENGTH,
  COLLECTION_OPTION_VALUE_MAX_LENGTH,
  COLLECTION_PLAN_MAX_COLLECTIONS,
  COLLECTION_SLUG_MAX_LENGTH,
  COLLECTION_TEMPLATE_KEYS,
  COLLECTION_ITEM_FILTER_OPERATORS,
  addItemsResult,
  type CollectionTemplateKey,
  type BulkCreateCollectionItemsResponse,
  type CollectionItemError,
} from "@dropl/shared";
import { z } from "zod";
import { pathSegment, type DroplApiClient } from "./api-client.js";
import { chunk } from "./concurrency.js";
import { deriveIdempotencyKey } from "./idempotency.js";

/** Accepts more items than one API call so an agent can import a whole menu at once; sent in API-sized batches. */
export const MAX_COLLECTION_ITEMS_PER_CALL = COLLECTION_BULK_MAX_ITEMS * 4;
const MAX_LISTED_ITEM_ERRORS = 50;
const MAX_FILTERS_PER_CALL = 10;
const FILTER_VALUE_MAX_LENGTH = 500;
const CURRENCY_CODE_LENGTH = 3;
const TEMPLATE_KEYS = COLLECTION_TEMPLATE_KEYS as [CollectionTemplateKey, ...CollectionTemplateKey[]];

const optionSchema = z.object({
  value: z.string().trim().max(COLLECTION_OPTION_VALUE_MAX_LENGTH).optional().describe("Stored value; derived from the label when omitted. Keep existing values unchanged."),
  label: z.string().trim().min(1).max(COLLECTION_OPTION_LABEL_MAX_LENGTH),
});

export const collectionFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .max(COLLECTION_FIELD_KEY_MAX_LENGTH)
    .regex(COLLECTION_FIELD_KEY_PATTERN)
    .optional()
    .describe("Existing fields: always send their current key (from get_collection_schema). New fields: omit; it's derived from the label."),
  label: z.string().trim().min(1).max(COLLECTION_FIELD_LABEL_MAX_LENGTH),
  type: z.enum(COLLECTION_FIELD_TYPES),
  helpText: z.string().trim().max(COLLECTION_FIELD_HELP_MAX_LENGTH).nullable().optional(),
  required: z.boolean().optional(),
  options: z.array(optionSchema).max(COLLECTION_FIELD_MAX_OPTIONS).nullable().optional().describe("select and multi_select only."),
  min: z.number().finite().nullable().optional().describe("number, price (amount), or text length limits."),
  max: z.number().finite().nullable().optional(),
  currency: z.string().trim().length(CURRENCY_CODE_LENGTH).nullable().optional().describe("price only, e.g. USD."),
});

export const collectionPlanEntrySchema = z.object({
  slug: z.string().trim().max(COLLECTION_SLUG_MAX_LENGTH).optional().describe("Matches an existing collection of the site; otherwise a new one gets this slug."),
  name: z.string().trim().min(1).max(COLLECTION_NAME_MAX_LENGTH),
  description: z.string().trim().max(COLLECTION_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  templateKey: z.enum(TEMPLATE_KEYS).nullable().optional().describe("Start a new collection from a template when fields are omitted."),
  fields: z.array(collectionFieldSchema).min(1).max(COLLECTION_MAX_FIELDS).optional(),
  titleFieldKey: z.string().trim().max(COLLECTION_FIELD_KEY_MAX_LENGTH).optional().describe("Key of the field shown as each item's title."),
  visibility: z.enum(["public", "private"]).optional().describe("public (default) can be read by the website without a key."),
  expectedSchemaVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Required to change an existing collection: the schemaVersion you read with get_collection_schema."),
});

export const collectionPlanSchema = z.array(collectionPlanEntrySchema).min(1).max(COLLECTION_PLAN_MAX_COLLECTIONS);

export const collectionItemInputSchema = z.object({
  values: z.record(z.string(), z.unknown()).describe("Values keyed by field key (see get_collection_schema)."),
  status: z.enum(["draft", "published"]).optional().describe("Defaults to published."),
  slug: z.string().trim().max(COLLECTION_ITEM_SLUG_MAX_LENGTH).optional(),
});
export type CollectionItemInput = z.infer<typeof collectionItemInputSchema>;

export const collectionItemFilterSchema = z.object({
  field: z.string().trim().min(1).max(COLLECTION_FIELD_KEY_MAX_LENGTH).regex(COLLECTION_FIELD_KEY_PATTERN),
  operator: z.enum(COLLECTION_ITEM_FILTER_OPERATORS).optional().describe("eq (default) matches any of comma-separated values."),
  value: z.string().max(FILTER_VALUE_MAX_LENGTH),
});
export type CollectionItemFilter = z.infer<typeof collectionItemFilterSchema>;
export const collectionItemFiltersSchema = z.array(collectionItemFilterSchema).max(MAX_FILTERS_PER_CALL);

export const sitePath = (siteId: string) => `/v1/sites/${pathSegment(siteId)}`;
export const collectionPath = (collectionId: string) => `/v1/collections/${pathSegment(collectionId)}`;

export { collectionCodeResult, collectionListResult, itemFilterQuery, itemListResult, pickUndoableActivity, planResult } from "@dropl/shared";

export interface AddItemsOptions {
  collectionId: string;
  items: readonly CollectionItemInput[];
  dryRun: boolean;
  mode: "valid_only" | "all_or_nothing";
}

export type AddItemsResult = ReturnType<typeof addItemsResult>;

async function sendBatches(client: DroplApiClient, options: AddItemsOptions, dryRun: boolean, mode: AddItemsOptions["mode"]) {
  const path = `${collectionPath(options.collectionId)}/items/bulk`;
  const batches = chunk([...options.items], COLLECTION_BULK_MAX_ITEMS);
  const errors: CollectionItemError[] = [];
  let created = 0;
  for (const [batchIndex, batch] of batches.entries()) {
    const body = { items: batch, dryRun, mode };
    const idempotencyKey = dryRun ? undefined : deriveIdempotencyKey("add_collection_items", options.collectionId, body);
    const { data } = await client.request<BulkCreateCollectionItemsResponse>("POST", path, { body, idempotencyKey });
    const offset = batchIndex * COLLECTION_BULK_MAX_ITEMS;
    created += data.created.length;
    for (const error of data.errors) errors.push({ index: error.index + offset, errors: error.errors });
  }
  return { created, errors };
}

/**
 * Batches of at most `COLLECTION_BULK_MAX_ITEMS`. `all_or_nothing` validates every batch before saving any,
 * so a bad row in a later batch can't leave the earlier ones half imported.
 */
export async function addCollectionItems(client: DroplApiClient, options: AddItemsOptions): Promise<AddItemsResult> {
  const received = options.items.length;
  let outcome: { created: number; errors: CollectionItemError[] };
  if (!options.dryRun && options.mode === "all_or_nothing" && received > COLLECTION_BULK_MAX_ITEMS) {
    const check = await sendBatches(client, options, true, "valid_only");
    outcome = check.errors.length > 0 ? { created: 0, errors: check.errors } : await sendBatches(client, options, false, "all_or_nothing");
  } else {
    outcome = await sendBatches(client, options, options.dryRun, options.mode);
  }
  return addItemsResult({ dryRun: options.dryRun, mode: options.mode, received, ...outcome }, MAX_LISTED_ITEM_ERRORS);
}
