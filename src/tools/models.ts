import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import type { OdooDomain } from "../types.js";

export const listModelsTool = {
  name: "list_models",
  description:
    "List available Odoo models. By default excludes transient (wizard) models. Use filter to narrow results.",
  inputSchema: {
    filter: z
      .string()
      .optional()
      .describe(
        'Text filter to match model name or technical name (e.g., "sale", "partner"). Strongly recommended to reduce response size'
      ),
    include_transient: z
      .boolean()
      .optional()
      .describe(
        "Include transient (wizard) models. Default: false"
      ),
  },
};

export async function handleListModels(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const filter = args.filter as string | undefined;
  const includeTransient = (args.include_transient as boolean) ?? false;

  // Build the server-side filtering domain
  const domain: OdooDomain = [];
  if (!includeTransient) {
    domain.push(["transient", "=", false]);
  }
  if (filter) {
    domain.push("|");
    domain.push(["model", "ilike", filter]);
    domain.push(["name", "ilike", filter]);
  }

  const records = (await client.searchRead(
    "ir.model",
    domain,
    ["model", "name", "state", "transient"],
    undefined,
    undefined,
    "model"
  )) as Array<Record<string, unknown>>;

  const models = records.map((r) => ({
    model: r.model,
    name: r.name,
    state: r.state,
    transient: r.transient,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ count: models.length, models }, null, 2),
      },
    ],
  };
}
