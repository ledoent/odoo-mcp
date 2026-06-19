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
- [ ] `run_financial_report` tool — MIS P&L/BS/Cash Flow first (the configured
      Ledo instances), then OCA GL/TB/Aged, then Tax.
- [ ] Tool annotations (`readOnlyHint` on all report tools).

**T2 — safety + robustness:**
- [ ] Per-model allow-list (`ODOO_MCP_ALLOWED_MODELS`) — app-level defence over
      the Odoo ACL.
- [ ] Pagination cursors; bulk create/update.
- [ ] CI + `tests/` suite (the upstream repo shipped none).
- [ ] Richer `get_fields` (relations + selection values) for agent grounding.

**T3 — deployment:**
- [ ] HTTP transport with auth (bearer/mTLS) for multi-client/remote.
- [ ] Report → PDF (QWeb) tool.
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
