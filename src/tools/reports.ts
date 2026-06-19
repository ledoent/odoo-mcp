import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import { getReportCapabilities } from "../capabilities.js";

function errorPayload(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

export const listFinancialReportsTool = {
  name: "list_financial_reports",
  description:
    "List the financial reports the connected user can actually access in THIS Odoo database: MIS Builder instances (Profit & Loss / Balance Sheet / Cash Flow), OCA account_financial_report ledgers (General Ledger, Trial Balance, Aged Partner Balance, Open Items, Journal, VAT), and core tax reports. Each source reports availability + a reason if unavailable (module absent or no access). Call this before run_financial_report — financial statements are NOT in the core report engine on this CE database.",
  inputSchema: {},
};

export async function handleListFinancialReports(
  client: OdooClient,
  _args: Record<string, unknown>
) {
  const caps = await getReportCapabilities(client, true);
  const payload = {
    modules: caps.modules,
    profit_loss_balance_cashflow: {
      backend: "mis_builder",
      available: caps.mis.available,
      reason: caps.mis.reason,
      instances: caps.mis.items,
    },
    ledgers_aging: {
      backend: "account_financial_report",
      available: caps.oca.available,
      reason: caps.oca.reason,
      reports: caps.oca.items,
    },
    tax: {
      backend: "account.report",
      available: caps.tax.available,
      reason: caps.tax.reason,
      reports: caps.tax.items,
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export const runFinancialReportTool = {
  name: "run_financial_report",
  description:
    "Compute a configured MIS Builder financial statement (Profit & Loss, Balance Sheet, or Cash Flow) by its instance name and return the line items with values per period. Call list_financial_reports first to get valid instance names. Read-only.",
  inputSchema: {
    instance: z
      .string()
      .describe(
        "Exact MIS report instance name, e.g. 'Ledo P&L - 2025' (from list_financial_reports)."
      ),
  },
};

export async function handleRunFinancialReport(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const name = String(args.instance || "").trim();
  if (!name)
    return errorPayload("instance name is required (see list_financial_reports).");

  const caps = await getReportCapabilities(client, false);
  if (!caps.mis.available)
    return errorPayload(
      `MIS Builder reports are unavailable: ${caps.mis.reason || "mis_builder not installed or no access"}.`
    );

  const found = (await client.searchRead(
    "mis.report.instance",
    [["name", "=", name]],
    ["id", "name"],
    1
  )) as Array<{ id: number; name: string }>;
  if (!found.length)
    return errorPayload(
      `No MIS report instance named '${name}'. Call list_financial_reports for valid names.`
    );

  // Compute the matrix. The web-session path (/web/dataset/call_kw) establishes
  // env.companies so multi-company GL record rules return real figures; the
  // JSON-RPC path can't (it would return period columns but an empty body on a
  // multi-company DB). JSON-RPC also avoids the XML-RPC null-marshal failure.
  const id = found[0].id;
  let res: { header?: unknown[]; body?: unknown[] };
  let via: string;
  if (client.webSessionAvailable) {
    try {
      res = (await client.callWebKw("mis.report.instance", "compute", [[id]])) as {
        header?: unknown[];
        body?: unknown[];
      };
      via = "web-session";
    } catch {
      res = (await client.callKwJson("mis.report.instance", "compute", [[id]])) as {
        header?: unknown[];
        body?: unknown[];
      };
      via = "jsonrpc-fallback";
    }
  } else {
    res = (await client.callKwJson("mis.report.instance", "compute", [[id]])) as {
      header?: unknown[];
      body?: unknown[];
    };
    via = "jsonrpc-fallback";
  }

  const columns: string[] = [];
  for (const hrow of (res.header || []) as Array<{ cols?: unknown[] }>) {
    for (const col of (hrow.cols || []) as Array<Record<string, unknown>>) {
      const label = (col?.label as string) || (col?.description as string);
      if (label) columns.push(label);
    }
  }
  const rows = ((res.body || []) as Array<Record<string, unknown>>).map((r) => ({
    label: r.label as string,
    description: (r.description as string) || undefined,
    values: ((r.cells || []) as Array<Record<string, unknown> | null>).map((c) =>
      c == null
        ? null
        : typeof c.val === "number"
          ? (c.val as number)
          : ((c.val_r as string) ?? (c.val as unknown) ?? null)
    ),
  }));

  const out: Record<string, unknown> = { instance: name, columns, rows, via };
  if (rows.length === 0 && via !== "web-session") {
    out.note =
      "Period columns resolved but no line items: on a multi-company database the " +
      "GL record rule needs env.companies, which only the web session establishes. " +
      "Set ODOO_PASSWORD (in addition to / instead of ODOO_API_KEY) so the server " +
      "can open a web session and return real figures.";
  }

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(out, null, 2) },
    ],
  };
}
