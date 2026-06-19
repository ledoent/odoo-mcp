# ledoent/odoo-mcp — Roadmap & Plan

Hardened fork of intellieffect/odoo-mcp for the Ledo Odoo CE 19 stack.
Status: hardened + proven on lab Odoo 19 (PR #1). This doc drives the next phase:
**capability-gated financial reports** + **thorough lab testing**.

## 1. Where it fits (vs QuickBooks / other ERP MCPs)

Architecture is **generic-ORM-thin** (one uniform XML-RPC surface over *any*
model — core + OCA + custom) vs QuickBooks/Xero's **entity-thick** (fixed
entities, turnkey reports). For an Odoo-CE shop that builds custom modules the
generic model is correct: custom/OCA models light up free. The one real gap is
QuickBooks' **canned financial reports** — which we close below, the *right* way.

## 2. Dependency assurance — the core principle

The MCP is a **thin XML-RPC bridge with no Odoo manifest**, so it cannot
"declare" deps like an addon. Capability assurance is therefore a **runtime
preflight against the target DB**, in three layers:

1. **Connect-time capability scan** (`src/capabilities.ts`): query
   `ir.module.module` for required modules (installed?) + probe for the actual
   backing **records** (report instances/wizards), cache the result.
2. **Per-tool capability gate**: every report tool asserts its backend module
   AND the named report exist before running. If missing → return a structured
   `{error, missing_dependency, remediation}` — **never** an empty result from
   an unconfigured engine.
3. **Discovery tool** (`list_financial_reports`): enumerates what is *actually
   present* so the agent/client never guesses.

### The trap this avoids (verified on migrated prod `openupgrade_test`)
- `account.report` (core engine) is **present but holds only Tax reports** — a
  P&L built on it returns nothing. **Do not target the core template engine.**
- No Enterprise `account_reports` (CE confirmed).

## 3. USA financial reports — known-present sources (ground truth)

Verified in the real Ledo DB (US company, `l10n_us`, 350 accounts):

| Report | Backend (installed) | Mechanism | Status |
|---|---|---|---|
| **P&L / Balance Sheet / Cash Flow** | `mis_builder` | `mis.report.instance.compute()` | **35 instances + 6 templates configured** (`Ledo P&L - 2025`, `Ledo BS - 2024`, `Ledo Cash Flow`, per-entity MO/ID/GA) |
| **General Ledger / Trial Balance / Aged Partner / Open Items / Journal / VAT** | `account_financial_report` (OCA) | wizard models (`general.ledger.report.wizard`, `trial.balance.report.wizard`, `aged.partner.balance.report.wizard`, …) → `report.account_financial_report.*` | parametric, always ready |
| **Tax Report** | core `account.report` | `account.report` (tax-tagged) | present |

### Report tool design
- `list_financial_reports` → enumerates present MIS instances (by name + type),
  OCA report types, and tax reports — with the backend each comes from.
- `run_financial_report({report, date_from, date_to, company})`:
  - **MIS path**: resolve a `mis.report.instance` by name, or build a transient
    instance from a template (`Profit & Loss`/`Balance Sheet`/`Cash Flow`) for
    the date range; call `compute()`; return the KPI matrix as structured rows.
  - **OCA path**: instantiate the wizard model with params, render structured
    lines (and optionally the XLSX/PDF report).
  - **Tax path**: core `account.report` for the tax report.
  - Each calls the capability gate first; missing dep → loud structured error.

## 4. Roadmap tiers

**T1 — close the QuickBooks gap (financial reports):**
- [x] `src/capabilities.ts` — connect-time module/record scan + cache (graceful per-probe degradation).
- [x] `list_financial_reports` tool — discovery, capability-gated, proven on lab (MIS P&L/BS/CF + 6 OCA ledgers).
- [x] `run_financial_report` tool — returns REAL figures. Root cause of the
      earlier empty body was multi-company: the GL record rule needs
      `env.companies`, which only a **web session** (`/web/dataset/call_kw`)
      establishes — the external `/xmlrpc` + `/jsonrpc` endpoints don't.
      Added `OdooClient.callWebKw` (session auth + call_kw); the tool uses it when
      a password is available (ODOO_PASSWORD), else falls back to columns-only
      with a clear note. Verified: 11 P&L rows, figures matching the browser.
- [x] Tool annotations — `readOnlyHint`/`destructiveHint` on every tool (via
      registerTool) so MCP clients can gate by behaviour.

**T1b — readiness & ops (DONE):**
- [x] `src/readiness.ts` + `check_readiness` (live self-test) + `get_readiness`
      (cached). Reports status ready|degraded|not_ready, connection, security
      posture, per-report availability+reason. Persisted to a local 600 file
      (`ODOO_MCP_STATE_DIR`) — NOT in the ERP (least privilege; no prod pollution).
- [x] Exposed readiness + capabilities as MCP **resources** (`odoo://readiness`,
      `odoo://capabilities`) + a capability summary in the `initialize`
      instructions — the agent pulls state as context without a tool call.

**T-setup — can the MCP provision the ERP? (deliberate, gated, NOT runtime):**
- The least-privilege runtime user must NOT self-provision (installing modules /
  creating users / seeding MIS templates is admin-level and dangerous to expose
  to an agent). Best practice: keep provisioning OUT of the runtime path.
- [x] Diagnosis is the runtime job: `check_readiness` + `list_financial_reports`
      already report what's missing + why (remediation reasons).
- [x] Admin-scoped `setup_*` toolset — DOUBLE-gated (ODOO_MCP_ENABLE_SETUP=true
      to register + a runtime base.group_system admin check per call). Default
      OFF. `setup_install_modules` (install apps) + `setup_create_user` (restricted
      user + groups); both destructiveHint. Verified absent by default, present +
      refused-for-non-admin when enabled.
- [x] Provisioning already exists as separate odoo-shell scripts (mcp-bot user +
      key, group grants) — the recommended path over a runtime tool.

**T2 — safety + robustness:**
- [x] Per-model allow-list (`ODOO_MCP_ALLOWED_MODELS`, exact + `prefix.*`) —
      enforced at the client chokepoints (execute/jsonrpc/web), app-level defence
      over the Odoo ACL. Unit-tested.
- [x] Bulk create (array -> createBatch, max 100) + pagination (limit/offset/
      has_more) already present.
- [x] `tests/lab-suite.mjs` — 16-assertion MCP suite (init/resources, security
      gates, readiness, read, scoped write, capability-gated reports, delete-block);
      16/16 PASS on lab Odoo 19 (run via `npm run test:lab`).
- [x] CI: `.github/workflows/ci.yml` — build + typecheck + unit tests (security
      gates + sanitizer, no Odoo) on every push/PR. Lab-suite stays an integration
      test (needs a live Odoo + the report data).
- [x] Richer `get_fields` — now returns `relation` (related model) + `selection`
      option values + `help`, so agents can ground create/update calls.

**T3 — deployment:**
- [x] HTTP transport with **mandatory bearer auth** (ODOO_MCP_HTTP_PORT +
      ODOO_MCP_HTTP_TOKEN; refuses to start unauthenticated; loopback default,
      warns on non-loopback bind). Verified 401/401/200.
- [ ] Report → PDF (QWeb) tool. DEFERRED — low value vs effort: run_financial_
      report already returns the figures; PDF is for human consumption.
- [ ] Rate limiting / response caps.

Sequence: **capabilities → list_financial_reports → run_financial_report (MIS) →
annotations → CI/tests**.

## 5. Thorough lab testing

The lab has **both Odoo 18 and 19** and **real migrated DBs** — ideal.

- **Phase 1 — functional matrix**: every tool × {res.partner, sale.order,
  account.move, product.product} × {success, error, ACL-denied}; assert shapes.
- **Phase 2 — security/adversarial**: gate tests (delete/exec off by default;
  allow-list enforced when on); **restricted-user escape attempts** (read
  `ir.config_parameter`, write `res.users` → expect ACL refusal); transport
  guard; error-sanitization (force a traceback, assert nothing leaks).
- **Phase 3 — compatibility matrix**: whole suite vs lab **Odoo 18 AND 19** +
  `openupgrade_test` / `gaap_flows_mig`; catches version drift (`read_group`
  etc.) before prod. **Reports: assert the capability gate fires correctly when
  a backend is absent.**
- **Phase 4 — volume/perf**: large searches, wide groupings, attachment caps.
- **Phase 5 — CI**: package Phases 1–3 as `node:test` against a disposable lab
  DB in a compose fixture; gate every fork PR.

Harness base: `probe.mjs` (real MCP stdio client) → grow into `tests/`.

## 6. Test fixtures

- Restricted `mcp-bot` user (minimal groups, API key) — created via
  `scripts/make-mcp-user.py` (odoo shell). **Note: this Odoo caps API-key
  duration at 1 day** — regenerate per run.
- Connection: `ODOO_URL` + `ODOO_DB` + `ODOO_USER` (login) + `ODOO_API_KEY`.
