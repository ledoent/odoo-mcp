import type { OdooClient } from "../odoo-client.js";
import { getReportCapabilities } from "../capabilities.js";

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
