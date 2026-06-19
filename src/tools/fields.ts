import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";

const DEFAULT_ATTRIBUTES = [
  "string",
  "type",
  "required",
  "readonly",
  "relation", // related model for many2one/one2many/many2many
  "selection", // option values for selection fields
  "help",
];

export const getFieldsTool = {
  name: "get_fields",
  description:
    "Get field definitions for an Odoo model — names, types, labels, plus the related model (relation) and selection option values, so an agent can ground create/update calls. Default returns a compact attribute set; pass all_attributes for everything.",
  inputSchema: {
    model: z.string().describe("Odoo model name (e.g., 'res.partner')"),
    attributes: z
      .string()
      .optional()
      .describe(
        'Comma-separated field attributes to return. Default: "string,type,required,readonly,relation,selection,help"'
      ),
    filter: z
      .string()
      .optional()
      .describe(
        'Filter fields by partial name match (e.g., "partner", "amount"). Default: all fields'
      ),
    all_attributes: z
      .boolean()
      .optional()
      .describe(
        "Return all field attributes (response can be very large). Default: false"
      ),
  },
};

export async function handleGetFields(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const model = args.model as string;
  const allAttributes = (args.all_attributes as boolean) ?? false;
  const attributes = args.attributes
    ? (args.attributes as string).split(",").map((a) => a.trim())
    : allAttributes
      ? undefined
      : DEFAULT_ATTRIBUTES;

  const fields = (await client.getFields(model, attributes)) as Record<
    string,
    unknown
  >;

  // 필드명 필터링
  const filter = args.filter as string | undefined;
  let filtered = fields;
  if (filter) {
    const f = filter.toLowerCase();
    filtered = Object.fromEntries(
      Object.entries(fields).filter(([key]) =>
        key.toLowerCase().includes(f)
      )
    );
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { model, field_count: Object.keys(filtered).length, fields: filtered },
          null,
          2
        ),
      },
    ],
  };
}
