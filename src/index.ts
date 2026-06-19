import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OdooClient } from "./odoo-client.js";
import {
  assertTransportSecurity,
  sanitizeErrorMessage,
  isDeleteEnabled,
  isMethodCallsEnabled,
} from "./security.js";

import { searchRecordsTool, handleSearchRecords } from "./tools/search.js";
import { readRecordTool, handleReadRecord } from "./tools/read.js";
import { createRecordTool, handleCreateRecord } from "./tools/create.js";
import { updateRecordTool, handleUpdateRecord } from "./tools/update.js";
import { deleteRecordTool, handleDeleteRecord } from "./tools/delete.js";
import { countRecordsTool, handleCountRecords } from "./tools/count.js";
import { listModelsTool, handleListModels } from "./tools/models.js";
import { getFieldsTool, handleGetFields } from "./tools/fields.js";
import { searchGroupedTool, handleSearchGrouped } from "./tools/group.js";
import { executeMethodTool, handleExecuteMethod } from "./tools/execute.js";
import { nameSearchTool, handleNameSearch } from "./tools/name-search.js";
import { getMessagesTool, handleGetMessages, postMessageTool, handlePostMessage } from "./tools/message.js";
import {
  listAttachmentsTool, handleListAttachments,
  uploadAttachmentTool, handleUploadAttachment,
  downloadAttachmentTool, handleDownloadAttachment,
} from "./tools/attachment.js";
import { searchCalendarTool, handleSearchCalendar } from "./tools/calendar.js";
import { whoamiTool, handleWhoami } from "./tools/whoami.js";
import { listFinancialReportsTool, handleListFinancialReports, runFinancialReportTool, handleRunFinancialReport } from "./tools/reports.js";
import { checkReadinessTool, handleCheckReadiness, getReadinessTool, handleGetReadiness } from "./tools/readiness.js";
import { computeReadiness, loadReadiness } from "./readiness.js";
import { getReportCapabilities } from "./capabilities.js";

const SERVER_INSTRUCTIONS = `Odoo ERP MCP (read + scoped write).
Start by reading the odoo://readiness resource (or calling check_readiness): it reports the connection, which financial reports are available (Profit & Loss / Balance Sheet / Cash Flow via MIS Builder, ledgers/aging via OCA, tax), and the security posture. Financial statements are NOT in the core report engine — discover them with list_financial_reports, then run_financial_report by instance name. Writes are scoped to the connected user's Odoo permissions; delete and arbitrary method execution are disabled unless explicitly enabled. Everything is bounded by the connected user's ACLs.`;

async function main() {
  const url = process.env.ODOO_URL;
  const db = process.env.ODOO_DB;
  const apiKey = process.env.ODOO_API_KEY;
  const user = process.env.ODOO_USER;
  const password = process.env.ODOO_PASSWORD;

  let timeout: number | undefined;
  if (process.env.ODOO_TIMEOUT) {
    const parsed = Number(process.env.ODOO_TIMEOUT.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(
        "ODOO_TIMEOUT must be a positive integer (seconds). Got:",
        process.env.ODOO_TIMEOUT
      );
      process.exit(1);
    }
    timeout = parsed * 1000;
  }

  if (!url || !db) {
    console.error("ODOO_URL and ODOO_DB environment variables are required.");
    process.exit(1);
  }

  if (!apiKey && !(user && password)) {
    console.error(
      "Either ODOO_API_KEY or both ODOO_USER and ODOO_PASSWORD are required."
    );
    process.exit(1);
  }

  // Refuse cleartext credentials to a non-loopback host.
  assertTransportSecurity(url);

  const odoo = new OdooClient({ url, db, apiKey, user, password }, timeout);

  try {
    await odoo.connect();
  } catch (err) {
    console.error("Failed to connect to Odoo:", (err as Error).message);
    process.exit(1);
  }

  const server = new McpServer(
    {
      name: "odoo-mcp",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  // Resources: pull-on-demand context (best practice for readiness/capabilities,
  // so the agent can read state without spending a tool call).
  server.resource(
    "readiness",
    "odoo://readiness",
    async (uri) => {
      const report = loadReadiness() ?? (await computeReadiness(odoo));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }
  );
  server.resource(
    "capabilities",
    "odoo://capabilities",
    async (uri) => {
      const caps = await getReportCapabilities(odoo, false);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(caps, null, 2),
          },
        ],
      };
    }
  );

  // Register tools. Safe (read + scoped-write) tools are always on; the two
  // dangerous tools are registered only when explicitly enabled via env.
  const tools = [
    { def: searchRecordsTool, handler: handleSearchRecords },
    { def: readRecordTool, handler: handleReadRecord },
    { def: createRecordTool, handler: handleCreateRecord },
    { def: updateRecordTool, handler: handleUpdateRecord },
    { def: countRecordsTool, handler: handleCountRecords },
    { def: listModelsTool, handler: handleListModels },
    { def: getFieldsTool, handler: handleGetFields },
    { def: searchGroupedTool, handler: handleSearchGrouped },
    { def: nameSearchTool, handler: handleNameSearch },
    { def: getMessagesTool, handler: handleGetMessages },
    { def: postMessageTool, handler: handlePostMessage },
    { def: listAttachmentsTool, handler: handleListAttachments },
    { def: uploadAttachmentTool, handler: handleUploadAttachment },
    { def: downloadAttachmentTool, handler: handleDownloadAttachment },
    { def: searchCalendarTool, handler: handleSearchCalendar },
    { def: whoamiTool, handler: handleWhoami },
    { def: listFinancialReportsTool, handler: handleListFinancialReports },
    { def: runFinancialReportTool, handler: handleRunFinancialReport },
    { def: checkReadinessTool, handler: handleCheckReadiness },
    { def: getReadinessTool, handler: handleGetReadiness },
  ];

  // delete_record: off unless ODOO_MCP_ENABLE_DELETE is set.
  if (isDeleteEnabled()) {
    tools.push({ def: deleteRecordTool, handler: handleDeleteRecord });
  } else {
    console.error(
      "[security] delete_record is DISABLED (set ODOO_MCP_ENABLE_DELETE=true to enable)."
    );
  }

  // execute_method: off unless an allow-list is configured via
  // ODOO_MCP_ALLOWED_METHODS (the handler enforces the allow-list per call).
  if (isMethodCallsEnabled()) {
    tools.push({ def: executeMethodTool, handler: handleExecuteMethod });
  } else {
    console.error(
      "[security] execute_method is DISABLED (set ODOO_MCP_ALLOWED_METHODS to an allow-list to enable)."
    );
  }

  // Tool annotations: let MCP clients render/gate tools by behaviour.
  const WRITE_TOOLS = new Set([
    "create_record", "update_record", "post_message", "upload_attachment",
  ]);
  const DESTRUCTIVE_TOOLS = new Set(["delete_record", "execute_method"]);

  for (const { def, handler } of tools) {
    const annotations = {
      readOnlyHint: !WRITE_TOOLS.has(def.name) && !DESTRUCTIVE_TOOLS.has(def.name),
      destructiveHint: DESTRUCTIVE_TOOLS.has(def.name),
    };
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema, annotations }, async (args: Record<string, unknown>) => {
      try {
        return await handler(odoo, args as Record<string, unknown>);
      } catch (err) {
        const raw = (err as Error).message || String(err);
        // Full detail to stderr only; never forward server tracebacks to the client.
        console.error(`[odoo-mcp] tool ${def.name} failed:`, raw);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: sanitizeErrorMessage(raw) },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

