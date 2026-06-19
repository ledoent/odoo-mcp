// Readiness self-test (ledoent fork).
//
// Runs a live check of connection + capabilities + security posture and produces
// a structured report the agent can consult before attempting work. The report
// is cached locally (NOT in the ERP — least privilege; don't pollute prod) so it
// can be returned cheaply on demand.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { OdooClient } from "./odoo-client.js";
import { getReportCapabilities } from "./capabilities.js";
import { isDeleteEnabled, getAllowedMethods } from "./security.js";

export interface ReadinessReport {
  status: "ready" | "degraded" | "not_ready";
  generated_at: string;
  connection: {
    ok: boolean;
    uid?: number;
    database?: string;
    server_version?: string;
  };
  security: {
    delete_enabled: boolean;
    method_calls_enabled: boolean;
    allowed_methods: string[];
  };
  reports: {
    profit_loss_balance_cashflow: boolean;
    ledgers_aging: boolean;
    tax: boolean;
    mis_instance_count: number;
    oca_reports: string[];
  };
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

function stateFile(): string {
  const dir =
    process.env.ODOO_MCP_STATE_DIR || join(homedir(), ".cache", "odoo-mcp");
  return join(dir, "readiness.json");
}

export async function computeReadiness(
  client: OdooClient
): Promise<ReadinessReport> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

  let version: string | undefined;
  let uid: number | undefined;
  let db: string | undefined;
  let connOk = false;
  try {
    const v = (await client.getVersion()) as { server_version?: string };
    version = v.server_version;
    uid = client.getUid();
    db = client.getDatabase();
    connOk = true;
    checks.push({
      name: "connection",
      ok: true,
      detail: `uid ${uid} on ${db} (Odoo ${version})`,
    });
  } catch (e) {
    checks.push({ name: "connection", ok: false, detail: (e as Error).message });
  }

  const caps = await getReportCapabilities(client, true);
  checks.push({
    name: "report:profit_loss_balance_cashflow",
    ok: caps.mis.available,
    detail: caps.mis.available
      ? `${caps.mis.items.length} MIS instances`
      : caps.mis.reason,
  });
  checks.push({
    name: "report:ledgers_aging",
    ok: caps.oca.available,
    detail: caps.oca.available ? caps.oca.items.join(", ") : caps.oca.reason,
  });
  checks.push({
    name: "report:tax",
    ok: caps.tax.available,
    detail: caps.tax.available
      ? `${caps.tax.items.length} tax reports`
      : caps.tax.reason,
  });

  const allowed = getAllowedMethods().map((r) => `${r.model}:${r.method}`);
  const anyReport = caps.mis.available || caps.oca.available;
  const status: ReadinessReport["status"] = !connOk
    ? "not_ready"
    : anyReport
      ? "ready"
      : "degraded";

  return {
    status,
    generated_at: new Date().toISOString(),
    connection: { ok: connOk, uid, database: db, server_version: version },
    security: {
      delete_enabled: isDeleteEnabled(),
      method_calls_enabled: allowed.length > 0,
      allowed_methods: allowed,
    },
    reports: {
      profit_loss_balance_cashflow: caps.mis.available,
      ledgers_aging: caps.oca.available,
      tax: caps.tax.available,
      mis_instance_count: caps.mis.items.length,
      oca_reports: caps.oca.items,
    },
    checks,
  };
}

export function persistReadiness(r: ReadinessReport): string {
  const f = stateFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 2), { mode: 0o600 });
  return f;
}

export function loadReadiness(): ReadinessReport | null {
  const f = stateFile();
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ReadinessReport;
  } catch {
    return null;
  }
}
