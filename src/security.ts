// Security hardening helpers (ledoent fork).
//
// Posture: safe-by-default. The two dangerous tools — delete_record and
// arbitrary method execution (execute_method) — are NOT registered unless
// explicitly enabled via environment, mirroring the double-opt-in design of
// mature MCP servers. The Odoo user's ACLs remain the real boundary; this is
// defence-in-depth at the application layer.

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v != null && TRUE_VALUES.has(v.trim().toLowerCase());
}

/** delete_record is registered only when ODOO_MCP_ENABLE_DELETE is truthy. */
export function isDeleteEnabled(): boolean {
  return envFlag("ODOO_MCP_ENABLE_DELETE");
}

export interface MethodRule {
  model: string;
  method: string;
}

/**
 * Parse ODOO_MCP_ALLOWED_METHODS into an allow-list. Format: comma-separated
 * entries, each either `model:method` or a bare `method` (any model). A `*`
 * wildcard is allowed on either side. Examples:
 *   "sale.order:action_confirm,account.move:action_post"
 *   "action_post"          (any model)
 *   "sale.order:*"         (any method on sale.order — broad, explicit)
 * No value => empty list => execute_method is not registered at all.
 */
export function getAllowedMethods(): MethodRule[] {
  const raw = process.env.ODOO_MCP_ALLOWED_METHODS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":").map((p) => p.trim());
      if (parts.length === 1) return { model: "*", method: parts[0] };
      return { model: parts[0] || "*", method: parts[1] || "*" };
    })
    .filter((r) => r.method.length > 0);
}

export function isMethodCallsEnabled(): boolean {
  return getAllowedMethods().length > 0;
}

export function isMethodAllowed(model: string, method: string): boolean {
  return getAllowedMethods().some(
    (r) =>
      (r.model === "*" || r.model === model) &&
      (r.method === "*" || r.method === method)
  );
}

/**
 * Refuse cleartext credentials: an http:// URL to a non-loopback host would send
 * the API key in the clear. Allowed only when ODOO_ALLOW_INSECURE is set (local
 * dev against a loopback-equivalent host).
 */
export function assertTransportSecurity(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // URL validity is handled by the caller / xmlrpc layer
  }
  if (parsed.protocol === "https:") return;
  const host = parsed.hostname;
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (isLoopback) return;
  if (envFlag("ODOO_ALLOW_INSECURE")) {
    console.error(
      `[security] WARNING: connecting to "${host}" over plaintext http:// — ` +
        `credentials are sent in the clear (ODOO_ALLOW_INSECURE is set).`
    );
    return;
  }
  console.error(
    `[security] Refusing to send credentials over plaintext http:// to ` +
      `non-loopback host "${host}". Use https://, or set ODOO_ALLOW_INSECURE=true ` +
      `to override (NOT recommended).`
  );
  process.exit(1);
}

/**
 * Strip server-side Python tracebacks and absolute file paths from an Odoo error
 * before it is returned to the MCP client. Keeps a short human-readable reason;
 * the full detail is logged to stderr by the caller, never sent to the model.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message) return "Odoo request failed.";
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = [...lines]
    .reverse()
    .find(
      (l) =>
        !l.startsWith('File "') &&
        !l.startsWith("Traceback") &&
        !/^\s*at\s/.test(l)
    );
  let out = meaningful || lines[lines.length - 1] || "Odoo request failed.";
  out = out.replace(/(?:\/[^\s:"]+)+\.py/g, "<path>");
  return out.length > 300 ? out.slice(0, 297) + "..." : out;
}
