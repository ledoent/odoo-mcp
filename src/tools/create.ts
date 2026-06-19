import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";

export const createRecordTool = {
  name: "create_record",
  description:
    "Create one or more records in an Odoo model. Supports both single and batch creation.",
  inputSchema: {
    model: z.string().describe("Odoo model name (e.g., 'res.partner')"),
    values: z
      .string()
      .describe(
        'JSON object for single record or JSON array of objects for batch creation. Single: \'{"name":"John","email":"john@example.com"}\'. Batch: \'[{"name":"John"},{"name":"Jane"}]\''
      ),
  },
};

const MAX_BATCH_SIZE = 100;

export async function handleCreateRecord(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const model = args.model as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.values as string);
  } catch {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "Failed to parse values JSON. Provide valid JSON." }, null, 2) }],
      isError: true,
    };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Empty array. Provide at least one record to create." }, null, 2) }],
        isError: true,
      };
    }

    if (parsed.length > MAX_BATCH_SIZE) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Batch create is limited to ${MAX_BATCH_SIZE} records; got ${parsed.length}.` }, null, 2) }],
        isError: true,
      };
    }

    // Odoo native batch create (single RPC call)
    const ids = await client.createBatch(model, parsed as Record<string, unknown>[]);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: true, count: ids.length, ids },
            null,
            2
          ),
        },
      ],
    };
  } else {
    // Single create
    const id = await client.create(model, parsed as Record<string, unknown>);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: true, id }, null, 2),
        },
      ],
    };
  }
}
