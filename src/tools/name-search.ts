import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";

export const nameSearchTool = {
  name: "name_search",
  description:
    "Search records by name with autocomplete-style matching. Returns [id, display_name] pairs. Useful for finding records by partial name before creating relational links.",
  inputSchema: {
    model: z.string().describe("Odoo model name (e.g., 'res.partner')"),
    name: z
      .string()
      .optional()
      .describe("Name or partial name to search for. Default: '' (all)"),
    domain: z
      .string()
      .optional()
      .describe(
        'Additional domain filter as JSON array (e.g., \'[["is_company","=",true]]\'). Default: []'
      ),
    operator: z
      .enum(["ilike", "like", "=", "not ilike", "not like", "=like", "=ilike"])
      .optional()
      .describe(
        "Comparison operator for name matching. Default: 'ilike'"
      ),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results. Default: 10"),
  },
};

export async function handleNameSearch(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const model = args.model as string;
  const name = (args.name as string) || "";
  const operator = (args.operator as string) || "ilike";
  const limit = (args.limit as number) ?? 10;

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
        content: [{ type: "text" as const, text: JSON.stringify({ error: "domain must be a JSON array (e.g., [[\"is_company\",\"=\",true]])" }, null, 2) }],
        isError: true,
      };
    }
    domain = parsed;
  }

  const result = await client.nameSearch(model, name, domain, operator, limit);

  if (!Array.isArray(result)) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "Unexpected response format", raw: result }, null, 2) }],
      isError: true,
    };
  }

  const records = (result as [number, string][]).map(([id, displayName]) => ({
    id,
    display_name: displayName,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { model, count: records.length, records },
          null,
          2
        ),
      },
    ],
  };
}
