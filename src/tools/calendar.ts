import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import type { OdooDomain } from "../types.js";

export const searchCalendarTool = {
  name: "search_calendar",
  description:
    "Search calendar events. By default, returns only events owned by the currently authenticated user or events where they are an attendee. Set all_events to true to query all events.",
  inputSchema: {
    all_events: z
      .boolean()
      .optional()
      .describe(
        "If true, queries every user's events. Default: false (only your own events)"
      ),
    domain: z
      .string()
      .optional()
      .describe(
        'Additional filter domain (JSON array). Example: \'[["start",">=","2026-03-01"]]\'. Combined with the default user filter using AND'
      ),
    fields: z
      .string()
      .optional()
      .describe(
        'Fields to retrieve (comma-separated). Default: "name,start,stop,allday,user_id,partner_ids,location,description"'
      ),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of records to retrieve. Default: 40"),
    order: z
      .string()
      .optional()
      .describe('Sort order. Default: "start asc"'),
  },
};

export async function handleSearchCalendar(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const allEvents = (args.all_events as boolean) ?? false;
  const defaultFields = "name,start,stop,allday,user_id,partner_ids,location,description";
  const fields = args.fields
    ? (args.fields as string).split(",").map((f) => f.trim())
    : defaultFields.split(",");
  const limit = (args.limit as number) ?? 40;
  const order = (args.order as string) || "start asc";

  let extraDomain: OdooDomain = [];
  if (args.domain) {
    try {
      extraDomain = JSON.parse(args.domain as string);
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { error: "Failed to parse domain JSON. Please provide a valid JSON array" },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  let domain: OdooDomain = [...extraDomain];

  if (!allEvents) {
    const partnerId = await client.getPartnerId();
    const uid = client.uid;
    // Events where I am the organizer (user_id) or an attendee (partner_ids)
    domain.push("|");
    domain.push(["user_id", "=", uid]);
    domain.push(["partner_ids", "in", [partnerId]]);
  }

  const records = await client.searchRead(
    "calendar.event",
    domain,
    fields,
    limit,
    undefined,
    order
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            count: records.length,
            filter: allEvents ? "all events" : "my events only",
            records,
          },
          null,
          2
        ),
      },
    ],
  };
}
