// Runtime capability preflight (ledoent fork).
//
// The MCP is a thin XML-RPC bridge with no Odoo manifest, so it cannot declare
// module dependencies. Instead we probe the *target database as the connected
// user* at runtime — what matters is what THIS (restricted) user can actually
// read, not just what is installed globally. Every probe degrades gracefully:
// a permission gap or missing model yields {available:false, reason}, never a
// thrown error, so a report tool can fail loud-but-clean instead of crashing.
//
// Ground truth (Ledo CE 19): financial statements live in MIS Builder
// (mis.report.instance) and OCA account_financial_report wizards — NOT in the
// core `account.report` template engine, which holds only tax reports.

import type { OdooClient } from "./odoo-client.js";

export interface SourceCap<T> {
  available: boolean;
  reason?: string;
  items: T[];
}

export interface ReportCapabilities {
  modules: Record<string, boolean | "unknown">;
  mis: SourceCap<{ id: number; name: string }>;
  oca: SourceCap<string>;
  tax: SourceCap<{ id: number; name: string }>;
}

const REQUIRED_MODULES = [
  "mis_builder",
  "account_financial_report",
  "l10n_us",
  "account_reports", // Enterprise — expected absent on CE
];

let _cache: ReportCapabilities | null = null;

async function safeSearchRead(
  client: OdooClient,
  model: string,
  domain: unknown[],
  fields: string[],
  limit?: number,
  order?: string
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; reason: string }> {
  try {
    const rows = (await client.searchRead(
      model,
      domain as never,
      fields,
      limit,
      undefined,
      order
    )) as Record<string, unknown>[];
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "access denied" };
  }
}

export async function getReportCapabilities(
  client: OdooClient,
  refresh = false
): Promise<ReportCapabilities> {
  if (_cache && !refresh) return _cache;

  // 1) Installed modules — best-effort (ir.module.module is Settings-restricted;
  //    a least-privilege user gets "unknown", which is fine — the direct probes
  //    below are the source of truth for what this user can run).
  const modules: Record<string, boolean | "unknown"> = {};
  const modProbe = await safeSearchRead(
    client,
    "ir.module.module",
    [["name", "in", REQUIRED_MODULES]],
    ["name", "state"]
  );
  if (modProbe.ok) {
    for (const n of REQUIRED_MODULES) modules[n] = false;
    for (const m of modProbe.rows)
      modules[m.name as string] = (m.state as string) === "installed";
  } else {
    for (const n of REQUIRED_MODULES) modules[n] = "unknown";
  }

  // 2) MIS Builder instances (real P&L / Balance Sheet / Cash Flow).
  const misProbe = await safeSearchRead(
    client,
    "mis.report.instance",
    [],
    ["id", "name"],
    500,
    "name"
  );
  const mis: SourceCap<{ id: number; name: string }> = misProbe.ok
    ? {
        available: true,
        items: misProbe.rows.map((r) => ({ id: r.id as number, name: r.name as string })),
      }
    : { available: false, reason: misProbe.reason, items: [] };

  // 3) OCA account_financial_report types — detect via ir.actions.report
  //    (readable by accounting users; ir.model is not, so don't probe it).
  const actProbe = await safeSearchRead(
    client,
    "ir.actions.report",
    [["report_name", "like", "account_financial_report.%"]],
    ["report_name"]
  );
  const oca: SourceCap<string> = actProbe.ok
    ? {
        available: true,
        items: [
          ...new Set(
            actProbe.rows
              .map((r) => String(r.report_name).split(".").pop() || "")
              .filter(Boolean)
          ),
        ],
      }
    : { available: false, reason: actProbe.reason, items: [] };

  // 4) Core account.report — tax reports only (NEVER use for P&L/BS).
  const taxProbe = await safeSearchRead(client, "account.report", [], ["id", "name"], 50);
  const tax: SourceCap<{ id: number; name: string }> = taxProbe.ok
    ? {
        available: true,
        items: taxProbe.rows.map((r) => ({ id: r.id as number, name: r.name as string })),
      }
    : { available: false, reason: taxProbe.reason, items: [] };

  _cache = { modules, mis, oca, tax };
  return _cache;
}
