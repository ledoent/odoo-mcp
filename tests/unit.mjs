// Unit tests — pure logic (security gates + error sanitizer), no Odoo required.
import { test } from "node:test";
import assert from "node:assert";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "mcp-unit-")), "security.mjs");
await build({ entryPoints: ["src/security.ts"], outfile: out, format: "esm", logLevel: "silent" });
const s = await import(out);

test("delete gate off by default", () => { delete process.env.ODOO_MCP_ENABLE_DELETE; assert.equal(s.isDeleteEnabled(), false); });
test("delete gate on when set", () => { process.env.ODOO_MCP_ENABLE_DELETE = "true"; assert.equal(s.isDeleteEnabled(), true); });
test("method-calls off without allow-list", () => { delete process.env.ODOO_MCP_ALLOWED_METHODS; assert.equal(s.isMethodCallsEnabled(), false); assert.equal(s.isMethodAllowed("sale.order", "action_confirm"), false); });
test("allow-list: exact / bare-method / model wildcard", () => {
  process.env.ODOO_MCP_ALLOWED_METHODS = "sale.order:action_confirm, action_post";
  assert.equal(s.isMethodCallsEnabled(), true);
  assert.equal(s.isMethodAllowed("sale.order", "action_confirm"), true);
  assert.equal(s.isMethodAllowed("sale.order", "unlink"), false);
  assert.equal(s.isMethodAllowed("crm.lead", "action_post"), true);
  process.env.ODOO_MCP_ALLOWED_METHODS = "sale.order:*";
  assert.equal(s.isMethodAllowed("sale.order", "anything"), true);
  assert.equal(s.isMethodAllowed("res.users", "anything"), false);
});
test("sanitizer strips tracebacks + paths, keeps reason", () => {
  const c = s.sanitizeErrorMessage('Traceback (most recent call last):\n  File "/opt/odoo/x.py", line 5\nValidationError: Field "x" is required');
  assert.ok(!c.includes("/opt/odoo"));
  assert.ok(!c.includes("Traceback"));
  assert.ok(c.includes("required"));
});
