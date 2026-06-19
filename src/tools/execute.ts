import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import { isMethodAllowed } from "../security.js";

export const executeMethodTool = {
  name: "execute_method",
  description:
    "Execute a method on Odoo model records (workflow actions such as action_confirm, action_post, button_validate). Only (model, method) pairs in the ODOO_MCP_ALLOWED_METHODS allow-list are permitted; anything else is rejected. Use create_record/update_record/delete_record for CRUD.",
  inputSchema: {
    model: z
      .string()
      .describe("Odoo model name (e.g., 'sale.order', 'account.move')"),
    method: z
      .string()
      .describe(
        "Method name to call (e.g., 'action_confirm', 'action_post', 'button_validate')"
      ),
    ids: z
      .string()
      .describe('Comma-separated record IDs (e.g., "1,2,3")'),
    args: z
      .string()
      .optional()
      .describe(
        "Additional positional arguments as JSON array (e.g., '[\"arg1\", 2]'). Default: []"
      ),
    kwargs: z
      .string()
      .optional()
      .describe(
        'Additional keyword arguments as JSON object (e.g., \'{"key": "value"}\'). Default: {}'
      ),
  },
};

export async function handleExecuteMethod(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const model = (args.model as string).trim();
  const method = (args.method as string).trim();

  if (!model) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "model is required" }, null, 2) }],
      isError: true,
    };
  }

  if (!method) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "method is required" }, null, 2) }],
      isError: true,
    };
  }

  // Allow-list gate: only explicitly permitted (model, method) pairs run.
  if (!isMethodAllowed(model, method)) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: `Method '${model}.${method}' is not permitted. Add it to ODOO_MCP_ALLOWED_METHODS to allow it.`,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const idStrings = (args.ids as string)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (idStrings.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "ids is empty. Provide at least one record ID" }, null, 2) }],
      isError: true,
    };
  }

  const ids = idStrings.map((s) => {
    const id = parseInt(s, 10);
    if (isNaN(id) || id <= 0) throw new Error(`Invalid record ID: "${s}"`);
    return id;
  });

  let extraArgs: unknown[] = [];
  if (args.args) {
    try {
      extraArgs = JSON.parse(args.args as string);
    } catch {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Failed to parse args JSON. Provide a valid JSON array" }, null, 2) }],
        isError: true,
      };
    }
    if (!Array.isArray(extraArgs)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "args must be a JSON array" }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  let kwargs: Record<string, unknown> = {};
  if (args.kwargs) {
    try {
      kwargs = JSON.parse(args.kwargs as string);
    } catch {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Failed to parse kwargs JSON. Provide a valid JSON object" }, null, 2) }],
        isError: true,
      };
    }
    if (kwargs === null || typeof kwargs !== "object" || Array.isArray(kwargs)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "kwargs must be a JSON object" }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  let result: unknown;
  try {
    result = await client.executeMethod(model, method, ids, extraArgs, kwargs);
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("cannot marshal None")) {
      // Method executed successfully but returned None,
      // which XML-RPC cannot serialize. Treat as success.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                model,
                method,
                ids,
                result: null,
                note: "Method executed successfully (returned None)",
              },
              null,
              2
            ),
          },
        ],
      };
    }
    throw err;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ model, method, ids, result }, null, 2),
      },
    ],
  };
}
