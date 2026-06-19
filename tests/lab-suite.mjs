// Consolidated MCP lab test suite — functional + security gates against Odoo 19.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path";

const key = readFileSync(`${homedir()}/.cache/mcp-harden/local.key`, "utf8").trim();
const env = { ...process.env, ODOO_URL: process.env.ODOO_URL||"http://localhost:8019",
  ODOO_DB: process.env.ODOO_DB||"openupgrade_test", ODOO_USER: "mcp-bot@ledoweb.com", ODOO_API_KEY: key };
const root = join(homedir(), ".cache/mcp-harden/odoo-mcp");
const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env, cwd: root });
const c = new Client({ name: "lab-suite", version: "1.0" }, { capabilities: {} });
await c.connect(t);

let pass = 0, fail = 0;
const text = (r) => r.content?.map(x=>x.text).join("\n") ?? "";
const J = (r) => { try { return JSON.parse(text(r)); } catch { return {}; } };
function ok(cond, name, detail="") { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  ${detail}`); } }

console.log("\n== Phase 0: init ==");
ok(!!c.getInstructions?.(), "initialize instructions present");
const rs = (await c.listResources()).resources.map(r=>r.uri);
ok(rs.includes("odoo://readiness") && rs.includes("odoo://capabilities"), "resources registered", rs.join(","));

console.log("\n== Phase 1: tools + security gates ==");
const names = (await c.listTools()).tools.map(x=>x.name);
ok(!names.includes("delete_record"), "delete_record NOT registered (gate)");
ok(!names.includes("execute_method"), "execute_method NOT registered (gate)");
ok(names.includes("create_record") && names.includes("update_record"), "scoped write tools present");

console.log("\n== Phase 2: readiness ==");
const ready = J(await c.callTool({ name:"check_readiness", arguments:{} }));
ok(ready.status === "ready", "check_readiness status=ready", ready.status);
ok(ready.connection?.uid > 0, "auth uid resolved", String(ready.connection?.uid));

console.log("\n== Phase 3: read ==");
const s = J(await c.callTool({ name:"search_records", arguments:{ model:"res.partner", domain:"[]", fields:"id,name", limit:3 } }));
ok((s.records||[]).length === 3, "search_records returns rows");
const grp = J(await c.callTool({ name:"search_grouped", arguments:{ model:"res.partner", domain:"[]", fields:"id", groupby:"is_company" } }));
ok((grp.groups||[]).length >= 1, "search_grouped (read_group 19 compat)");

console.log("\n== Phase 4: scoped write ==");
const cr = J(await c.callTool({ name:"create_record", arguments:{ model:"res.partner", values:'{"name":"MCP Lab-Suite Contact","comment":"created by lab-suite"}' } }));
const nid = cr.id || cr.record_id;
ok(!!nid, "create_record returns id", JSON.stringify(cr).slice(0,80));
if (nid) {
  const up = J(await c.callTool({ name:"update_record", arguments:{ model:"res.partner", ids:String(nid), values:'{"function":"lab-suite role"}' } }));
  ok(up.success === true || (up.ids||[]).includes(nid), "update_record succeeds");
}

console.log("\n== Phase 5: financial reports (capability-gated) ==");
const lr = J(await c.callTool({ name:"list_financial_reports", arguments:{} }));
ok(lr.profit_loss_balance_cashflow?.available === true, "P&L/BS/CF discovered available");
ok((lr.profit_loss_balance_cashflow?.instances||[]).length > 0, "MIS instances present", String((lr.profit_loss_balance_cashflow?.instances||[]).length));
ok((lr.ledgers_aging?.reports||[]).length >= 5, "OCA ledger reports present");
const rr = J(await c.callTool({ name:"run_financial_report", arguments:{ instance:"Ledo P&L - 2025" } }));
ok((rr.columns||[]).length > 0, "run_financial_report resolves period columns", (rr.columns||[]).join(","));

console.log("\n== Phase 6: security — delete attempt blocked at MCP layer ==");
let blocked = false;
try { const d = await c.callTool({ name:"delete_record", arguments:{ model:"res.partner", ids:String(nid||1) } }); blocked = !!d.isError; }
catch (e) { blocked = /not found/i.test(String(e.message||e)); }
ok(blocked, "delete_record call rejected (tool not exposed)");

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
await c.close();
process.exit(fail ? 1 : 0);
