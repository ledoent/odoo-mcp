// Admin provisioning tools (setup_*). DOUBLE-GATED: registered only when
// ODOO_MCP_ENABLE_SETUP=true, and each handler re-checks at call time that the
// connected user is an admin (base.group_system). These mutate the system, so
// they carry destructiveHint and stay off the normal runtime surface.

import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

async function isAdmin(client: OdooClient): Promise<boolean> {
  try {
    return !!(await client.executeMethod("res.users", "has_group", [client.getUid()], [
      "base.group_system",
    ]));
  } catch {
    return false;
  }
}

const ADMIN_REQUIRED =
  "setup tools require an admin connection (base.group_system). Connect the MCP as an administrator to provision.";

export const setupInstallModulesTool = {
  name: "setup_install_modules",
  description:
    "ADMIN/setup: install Odoo modules by technical name (e.g. mis_builder, account_financial_report, l10n_us). Requires an admin connection. Mutates the database (installs apps) — use deliberately.",
  inputSchema: {
    modules: z
      .string()
      .describe("Comma-separated module technical names to install."),
  },
};

export async function handleSetupInstallModules(
  client: OdooClient,
  args: Record<string, unknown>
) {
  if (!(await isAdmin(client))) return err(ADMIN_REQUIRED);
  const names = String(args.modules || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return err("modules is required (comma-separated technical names).");
  const mods = (await client.searchRead(
    "ir.module.module",
    [["name", "in", names]],
    ["id", "name", "state"]
  )) as Array<{ id: number; name: string; state: string }>;
  const found = new Set(mods.map((m) => m.name));
  const toInstall = mods.filter((m) => m.state !== "installed");
  if (toInstall.length) {
    await client.executeMethod(
      "ir.module.module",
      "button_immediate_install",
      toInstall.map((m) => m.id)
    );
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            installed: toInstall.map((m) => m.name),
            already_installed: mods
              .filter((m) => m.state === "installed")
              .map((m) => m.name),
            not_found: names.filter((n) => !found.has(n)),
          },
          null,
          2
        ),
      },
    ],
  };
}

export const setupCreateUserTool = {
  name: "setup_create_user",
  description:
    "ADMIN/setup: create a restricted internal user with the given groups (by XML id) and an optional password. Requires an admin connection. Generate the API key yourself in Settings > Account Security — keys can't be minted for another user over RPC.",
  inputSchema: {
    login: z.string().describe("Login / email for the new user."),
    name: z.string().optional().describe("Display name (defaults to login)."),
    groups: z
      .string()
      .describe(
        "Comma-separated group XML ids, e.g. 'base.group_user,sales_team.group_sale_salesman'."
      ),
    password: z.string().optional().describe("Optional password to set."),
  },
};

export async function handleSetupCreateUser(
  client: OdooClient,
  args: Record<string, unknown>
) {
  if (!(await isAdmin(client))) return err(ADMIN_REQUIRED);
  const login = String(args.login || "").trim();
  if (!login) return err("login is required.");
  const xmlids = String(args.groups || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const gids: number[] = [];
  for (const x of xmlids) {
    const dot = x.indexOf(".");
    if (dot < 0) continue;
    const mod = x.slice(0, dot);
    const name = x.slice(dot + 1);
    const rec = (await client.searchRead(
      "ir.model.data",
      [
        ["module", "=", mod],
        ["name", "=", name],
        ["model", "=", "res.groups"],
      ],
      ["res_id"],
      1
    )) as Array<{ res_id: number }>;
    if (rec.length) gids.push(rec[0].res_id);
  }
  const vals: Record<string, unknown> = {
    name: (args.name as string) || login,
    login,
    group_ids: [[6, 0, gids]],
  };
  if (args.password) vals.password = args.password;
  const uid = await client.create("res.users", vals);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { uid, login, groups_assigned: gids.length, requested_groups: xmlids.length },
          null,
          2
        ),
      },
    ],
  };
}
