import type { OdooClient } from "../odoo-client.js";

export const whoamiTool = {
  name: "whoami",
  description:
    "Show current connection info: authenticated user, uid, partner, company, server version, and database name.",
  inputSchema: {},
};

export async function handleWhoami(
  client: OdooClient,
  _args: Record<string, unknown>
) {
  // Get the server version
  const version = await client.getVersion();

  // Get the current user's info
  const uid = client.getUid();
  const users = (await client.searchRead(
    "res.users",
    [["id", "=", uid]],
    [
      "name",
      "login",
      "email",
      "partner_id",
      "company_id",
      "company_ids",
      "group_ids",
      "lang",
      "tz",
    ],
    1
  )) as Array<Record<string, unknown>>;

  if (!users || users.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: "Could not read current user info" }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const user = users[0] as Record<string, unknown>;

  // Get permission group names — app-level groups only (full_name containing "/" = app/role group)
  const groupIds = (user.group_ids as number[]) || [];
  let groups: string[] = [];
  if (groupIds.length > 0) {
    const groupRecords = (await client.searchRead(
      "res.groups",
      [["id", "in", groupIds]],
      ["full_name"],
      200
    )) as Array<Record<string, unknown>>;
    groups = groupRecords
      .map((g) => g.full_name as string)
      .filter((name) => name.includes(" / "))  // app/role groups only (excludes internal technical groups)
      .sort();
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            uid,
            name: user.name,
            login: user.login,
            email: user.email,
            partner_id: user.partner_id,
            company_id: user.company_id,
            company_ids: user.company_ids,
            lang: user.lang,
            tz: user.tz,
            groups: groups,
            url: client.getUrl(),
            server: {
              version: version.server_version,
              version_info: version.server_version_info,
              protocol_version: version.protocol_version,
            },
            database: client.getDatabase(),
          },
          null,
          2
        ),
      },
    ],
  };
}
