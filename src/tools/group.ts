import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import type { OdooDomain } from "../types.js";

export const searchGroupedTool = {
  name: "search_grouped",
  description:
    "Search and aggregate records using Odoo's read_group. Returns grouped results with aggregated values (sum, count, avg, etc.).",
  inputSchema: {
    model: z.string().describe("Odoo model name (e.g., 'account.move')"),
    domain: z
      .string()
      .optional()
      .describe(
        'Search domain as JSON array (e.g., \'[["state","=","posted"]]\'). Default: [] (all records)'
      ),
    fields: z
      .string()
      .describe(
        'Comma-separated fields to aggregate (e.g., "amount_total:sum,name"). Use field:agg syntax for specific aggregations'
      ),
    groupby: z
      .string()
      .describe(
        'Comma-separated fields to group by (e.g., "partner_id,state", "date_order:month")'
      ),
    orderby: z
      .string()
      .optional()
      .describe('Sort order (e.g., "amount_total desc"). Default: none'),
    limit: z.number().optional().describe("Maximum number of groups to return"),
    lazy: z
      .boolean()
      .optional()
      .describe(
        "If true, only group by the first field; sub-groups returned via __context. Default: true"
      ),
  },
};

export async function handleSearchGrouped(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const model = args.model as string;

  let domain: unknown[] = [];
  if (args.domain) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.domain as string);
    } catch {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Failed to parse domain JSON. Please provide a valid JSON array" }, null, 2) }],
        isError: true,
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: 'domain must be a JSON array (e.g., [["state","=","sale"]])' }, null, 2) }],
        isError: true,
      };
    }
    domain = parsed;
  }

  const fields = (args.fields as string)
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  if (fields.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "fields is empty. Specify the fields to aggregate (e.g., 'amount_total:sum,name')" }, null, 2) }],
      isError: true,
    };
  }

  const groupby = (args.groupby as string)
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);

  if (groupby.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "groupby is empty. Specify the fields to group by (e.g., 'partner_id,state')" }, null, 2) }],
      isError: true,
    };
  }

  const orderby = args.orderby as string | undefined;
  const limit = args.limit as number | undefined;
  const lazy = args.lazy as boolean | undefined;

  const result = await client.readGroup(
    model,
    domain as OdooDomain,
    fields,
    groupby,
    orderby,
    limit,
    lazy
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            model,
            group_count: result.length,
            ...(result.length === 0 ? { message: "No groups match the given criteria" } : {}),
            groups: result,
          },
          null,
          2
        ),
      },
    ],
  };
}
