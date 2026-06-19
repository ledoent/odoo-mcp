import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import {
  computeReadiness,
  persistReadiness,
  loadReadiness,
} from "../readiness.js";

export const checkReadinessTool = {
  name: "check_readiness",
  description:
    "Run a LIVE readiness self-test of this Odoo connection: auth + server version, which financial reports are available (P&L/BS/Cash Flow, ledgers, tax), and the security posture (delete/method-exec gates). Returns a structured report with overall status ready|degraded|not_ready, and stores it for cheap retrieval. Call once at session start, then consult it before attempting reports or writes.",
  inputSchema: {
    persist: z
      .boolean()
      .optional()
      .describe("Store the report for later get_readiness calls (default true)."),
  },
};

export async function handleCheckReadiness(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const report = await computeReadiness(client);
  if (args.persist !== false) {
    try {
      persistReadiness(report);
    } catch {
      // persistence is best-effort; the live report is still returned.
    }
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
  };
}

export const getReadinessTool = {
  name: "get_readiness",
  description:
    "Return the last stored readiness report without re-probing the ERP (cheap). Falls back to a live check if nothing is stored yet. Use to recall what the ERP can do without paying for a full re-check.",
  inputSchema: {},
};

export async function handleGetReadiness(
  client: OdooClient,
  _args: Record<string, unknown>
) {
  const stored = loadReadiness();
  if (stored) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...stored, source: "cached" }, null, 2),
        },
      ],
    };
  }
  const report = await computeReadiness(client);
  try {
    persistReadiness(report);
  } catch {
    /* best-effort */
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ...report, source: "live" }, null, 2),
      },
    ],
  };
}
