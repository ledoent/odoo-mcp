import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import type { OdooDomain } from "../types.js";

const DEFAULT_FIELDS = ["id", "name", "display_name"];

export const searchRecordsTool = {
  name: "search_records",
  description:
    "Search and read records from an Odoo model. If fields is not specified, only id/name/display_name are returned to keep response compact. Always specify the fields you need.",
  inputSchema: {
    model: z.string().describe("Odoo model name (e.g., 'res.partner', 'sale.order')"),
    domain: z
      .string()
      .optional()
      .describe(
        'Search domain as JSON array (e.g., \'[["is_company","=",true],["country_id.code","=","US"]]\'). Default: [] (all records)'
      ),
    fields: z
      .string()
      .optional()
      .describe(
        'Comma-separated field names to return (e.g., "name,email,phone"). Default: "id,name,display_name". Specify fields to get relevant data'
      ),
    limit: z.number().int().positive().optional().describe("Maximum number of records to return. Must be a positive integer. Default: 80"),
    offset: z.number().int().min(0).optional().describe("Number of records to skip. Must be a non-negative integer. Default: 0"),
    order: z
      .string()
      .optional()
      .describe('Sort order (e.g., "name asc", "create_date desc")'),
    include_total: z
      .boolean()
      .optional()
      .describe("If true, returns the exact total record count (total_count). Incurs an extra RPC call. Default: false"),
  },
};

export async function handleSearchRecords(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const model = args.model as string;
  let domain: OdooDomain = [];
  if (args.domain) {
    try {
      domain = JSON.parse(args.domain as string);
    } catch {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Failed to parse domain JSON. Please provide a valid JSON array" }, null, 2) }],
        isError: true,
      };
    }
  }

  const fieldsSpecified = !!args.fields;
  const fields = args.fields
    ? (args.fields as string).split(",").map((f) => f.trim())
    : DEFAULT_FIELDS;
  const limit = (args.limit as number) ?? 80;
  const offset = (args.offset as number) ?? 0;
  const order = args.order as string | undefined;
  const includeTotal = (args.include_total as boolean) ?? false;

  let records: unknown[];
  let hasMore: boolean;
  let totalCount: number | undefined;

  if (includeTotal) {
    // include_total=true: searchRead + count in parallel
    const [searchResult, countResult] = await Promise.all([
      client.searchRead(model, domain, fields, limit, offset, order),
      client.count(model, domain),
    ]);
    records = searchResult as unknown[];
    totalCount = countResult;
    hasMore = offset + records.length < totalCount;
  } else {
    // include_total=false: determine has_more via the limit+1 trick (avoids a count RPC call)
    records = (await client.searchRead(model, domain, fields, limit + 1, offset, order)) as unknown[];
    hasMore = records.length > limit;
    if (hasMore) records.pop();
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          count: records.length,
          ...(totalCount !== undefined ? { total_count: totalCount } : {}),
          offset,
          limit,
          has_more: hasMore,
          ...(!fieldsSpecified ? { notice: "fields not specified — only the default fields (id,name,display_name) are returned. Specify the fields you need" } : {}),
          records,
        }, null, 2),
      },
    ],
  };
}

