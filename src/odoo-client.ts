import xmlrpc from "xmlrpc";
import type {
  OdooConfig,
  OdooConnectionParams,
  OdooDomain,
} from "./types.js";
import { isModelAllowed } from "./security.js";

/** App-level per-model allow-list guard (defence over the Odoo ACL). */
function guardModel(model: string): void {
  if (!isModelAllowed(model)) {
    throw new Error(
      `Model '${model}' is not permitted by ODOO_MCP_ALLOWED_MODELS.`
    );
  }
}

const DEFAULT_TIMEOUT_MS = 30000;

function createClient(url: string, path: string) {
  const parsed = new URL(path, url);
  const isSecure = parsed.protocol === "https:";
  const options = {
    host: parsed.hostname,
    port: parsed.port
      ? parseInt(parsed.port)
      : isSecure
        ? 443
        : 80,
    path: parsed.pathname,
  };
  return isSecure
    ? xmlrpc.createSecureClient(options)
    : xmlrpc.createClient(options);
}

function call(
  client: xmlrpc.Client,
  method: string,
  params: unknown[],
  timeoutMs?: number
): Promise<unknown> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`XML-RPC request timed out after ${timeout}ms`));
    }, timeout);

    client.methodCall(method, params, (err: any, value: any) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    });
  });
}

export class OdooClient {
  private config: OdooConfig | null = null;
  private params: OdooConnectionParams;
  private timeoutMs: number;
  private objectClient: xmlrpc.Client | null = null;
  private commonClient: xmlrpc.Client | null = null;
  private _partnerId: number | null = null;
  // Web-session state (for /web/dataset/call_kw — the only path that establishes
  // env.companies from allowed_company_ids, which multi-company GL record rules
  // need; the external /xmlrpc + /jsonrpc endpoints do not). Requires a password.
  private webPassword: string | null = null;
  private webSession: Promise<{ cookie: string; companyIds: number[] }> | null = null;

  constructor(params: OdooConnectionParams, timeoutMs?: number) {
    this.params = params;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get uid(): number {
    if (!this.config) throw new Error("Not connected. Call connect() first.");
    return this.config.uid;
  }

  async getPartnerId(): Promise<number> {
    if (this._partnerId) return this._partnerId;
    const users = (await this.read("res.users", [this.uid], ["partner_id"])) as Record<string, unknown>[];
    if (users.length > 0 && Array.isArray(users[0].partner_id)) {
      this._partnerId = users[0].partner_id[0] as number;
    } else {
      throw new Error("Could not resolve the current user's partner_id.");
    }
    return this._partnerId;
  }

  async connect(): Promise<void> {
    const { url, db, apiKey, user, password } = this.params;
    // A real password (if provided, even alongside an API key) enables the
    // web-session report path; an API key alone cannot open a web session.
    this.webPassword = password || null;

    // cache the common client
    if (!this.commonClient) {
      this.commonClient = createClient(url, "/xmlrpc/2/common");
    }

    if (apiKey) {
      // With API key, we need to authenticate to get the uid
      const uid = (await call(this.commonClient, "authenticate", [
        db,
        user || "",
        apiKey,
        {},
      ], this.timeoutMs)) as number;

      if (!uid) {
        throw new Error(
          "Authentication failed. Check your ODOO_URL, ODOO_DB, and ODOO_API_KEY."
        );
      }

      this.config = { url, db, uid, password: apiKey };
    } else if (user && password) {
      const uid = (await call(this.commonClient, "authenticate", [
        db,
        user,
        password,
        {},
      ], this.timeoutMs)) as number;

      if (!uid) {
        throw new Error(
          "Authentication failed. Check your ODOO_URL, ODOO_DB, ODOO_USER, and ODOO_PASSWORD."
        );
      }

      this.config = { url, db, uid, password };
    } else {
      throw new Error(
        "Either ODOO_API_KEY or ODOO_USER + ODOO_PASSWORD must be provided."
      );
    }
  }

  getUid(): number {
    if (!this.config) throw new Error("Not connected. Call connect() first.");
    return this.config.uid;
  }

  getDatabase(): string {
    if (!this.config) throw new Error("Not connected. Call connect() first.");
    return this.config.db;
  }

  getUrl(): string {
    return this.params.url;
  }

  private getCommonClient() {
    if (!this.commonClient) {
      this.commonClient = createClient(this.params.url, "/xmlrpc/2/common");
    }
    return this.commonClient;
  }

  async getVersion(): Promise<Record<string, unknown>> {
    return (await call(this.getCommonClient(), "version", [])) as Record<string, unknown>;
  }

  private getObjectClient() {
    if (!this.config) throw new Error("Not connected. Call connect() first.");
    if (!this.objectClient) {
      this.objectClient = createClient(this.config.url, "/xmlrpc/2/object");
    }
    return this.objectClient;
  }

  private async execute(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!this.config) throw new Error("Not connected. Call connect() first.");
    guardModel(model);
    const client = this.getObjectClient();
    return call(client, "execute_kw", [
      this.config.db,
      this.config.uid,
      this.config.password,
      model,
      method,
      args,
      kwargs,
    ], this.timeoutMs);
  }

  async executeMethod(
    model: string,
    method: string,
    ids: number[],
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<unknown> {
    return this.execute(model, method, [ids, ...args], kwargs);
  }

  /**
   * Call a model method via Odoo's /jsonrpc endpoint instead of XML-RPC.
   * Required for methods whose return contains `null` (e.g. MIS Builder
   * compute()): XML-RPC rejects None-laden responses, JSON-RPC handles them.
   */
  async callKwJson(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!this.config) throw new Error("Not connected. Call connect() first.");
    guardModel(model);
    const { url, db, uid, password } = this.config;
    const resp = await fetch(new URL("/jsonrpc", url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: Math.floor(Date.now()),
        params: {
          service: "object",
          method: "execute_kw",
          args: [db, uid, password, model, method, args, kwargs],
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs ?? 30000),
    });
    const data = (await resp.json()) as {
      result?: unknown;
      error?: { message?: string; data?: { message?: string } };
    };
    if (data.error) {
      throw new Error(
        data.error.data?.message || data.error.message || "JSON-RPC error"
      );
    }
    return data.result;
  }

  /** True when a web session can be opened (a password is available). */
  get webSessionAvailable(): boolean {
    return !!this.webPassword;
  }

  private async openWebSession(): Promise<{ cookie: string; companyIds: number[] }> {
    if (this.webSession) return this.webSession;
    this.webSession = (async () => {
      if (!this.config) throw new Error("Not connected.");
      if (!this.webPassword)
        throw new Error("WEB_SESSION_REQUIRES_PASSWORD");
      const { url, db } = this.config;
      const resp = await fetch(new URL("/web/session/authenticate", url).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { db, login: this.params.user, password: this.webPassword },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await resp.json()) as {
        result?: { uid?: number; user_companies?: { allowed_companies?: Record<string, unknown> } };
      };
      if (!data.result?.uid) throw new Error("Web session authentication failed.");
      const setCookie = (resp.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || [];
      const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
      const allowed = data.result.user_companies?.allowed_companies || {};
      const companyIds = Object.keys(allowed).map((k) => Number(k)).filter(Boolean);
      return { cookie, companyIds };
    })();
    return this.webSession;
  }

  /**
   * Call a model method through an authenticated web session
   * (/web/dataset/call_kw). Unlike /xmlrpc and /jsonrpc, this establishes
   * env.companies from allowed_company_ids, which multi-company GL record rules
   * require — so reports return real figures. Requires a password (ODOO_PASSWORD).
   */
  async callWebKw(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!this.config) throw new Error("Not connected.");
    guardModel(model);
    const sess = await this.openWebSession();
    const { url } = this.config;
    const ctx = {
      ...(sess.companyIds.length ? { allowed_company_ids: sess.companyIds } : {}),
      ...((kwargs.context as Record<string, unknown>) || {}),
    };
    const resp = await fetch(new URL("/web/dataset/call_kw", url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sess.cookie },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { model, method, args, kwargs: { ...kwargs, context: ctx } },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await resp.json()) as {
      result?: unknown;
      error?: { message?: string; data?: { message?: string } };
    };
    if (data.error) {
      throw new Error(data.error.data?.message || data.error.message || "web call_kw error");
    }
    return data.result;
  }

  /**
   * Render a QWeb report to PDF via the report controller, using the web session.
   * Returns the PDF base64-encoded. Requires a password (web session).
   */
  async fetchReportPdf(
    reportName: string,
    ids: number[]
  ): Promise<{ base64: string; bytes: number }> {
    if (!this.config) throw new Error("Not connected.");
    const sess = await this.openWebSession();
    const { url } = this.config;
    const target = new URL(
      `/report/pdf/${encodeURIComponent(reportName)}/${ids.join(",")}`,
      url
    ).toString();
    const resp = await fetch(target, {
      headers: { Cookie: sess.cookie },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      throw new Error(`Report render failed: HTTP ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return { base64: buf.toString("base64"), bytes: buf.length };
  }

  async searchRead(
    model: string,
    domain: OdooDomain = [],
    fields?: string[],
    limit?: number,
    offset?: number,
    order?: string
  ): Promise<unknown[]> {
    const kwargs: Record<string, unknown> = {};
    if (fields && fields.length > 0) kwargs.fields = fields;
    if (limit !== undefined) kwargs.limit = limit;
    if (offset !== undefined) kwargs.offset = offset;
    if (order) kwargs.order = order;

    return (await this.execute(
      model,
      "search_read",
      [domain],
      kwargs
    )) as unknown[];
  }

  async read(
    model: string,
    ids: number[],
    fields?: string[]
  ): Promise<unknown[]> {
    const kwargs: Record<string, unknown> = {};
    if (fields && fields.length > 0) kwargs.fields = fields;

    return (await this.execute(model, "read", [ids], kwargs)) as unknown[];
  }

  async create(
    model: string,
    values: Record<string, unknown>
  ): Promise<number> {
    return (await this.execute(model, "create", [values])) as number;
  }

  async createBatch(
    model: string,
    valuesList: Record<string, unknown>[]
  ): Promise<number[]> {
    return (await this.execute(model, "create", [valuesList])) as number[];
  }

  async update(
    model: string,
    ids: number[],
    values: Record<string, unknown>
  ): Promise<boolean> {
    return (await this.execute(model, "write", [ids, values])) as boolean;
  }

  async delete(model: string, ids: number[]): Promise<boolean> {
    return (await this.execute(model, "unlink", [ids])) as boolean;
  }

  async count(model: string, domain: OdooDomain = []): Promise<number> {
    return (await this.execute(
      model,
      "search_count",
      [domain]
    )) as number;
  }

  async listModels(): Promise<unknown[]> {
    return this.searchRead(
      "ir.model",
      [],
      ["model", "name", "state", "transient"],
      undefined,
      undefined,
      "model"
    );
  }

  async readGroup(
    model: string,
    domain: OdooDomain = [],
    fields: string[],
    groupby: string[],
    orderby?: string,
    limit?: number,
    lazy?: boolean
  ): Promise<unknown[]> {
    const kwargs: Record<string, unknown> = {};
    if (orderby) kwargs.orderby = orderby;
    if (limit !== undefined) kwargs.limit = limit;
    if (lazy !== undefined) kwargs.lazy = lazy;

    return (await this.execute(
      model,
      "read_group",
      [domain, fields, groupby],
      kwargs
    )) as unknown[];
  }

  async nameSearch(
    model: string,
    name: string = "",
    domain: unknown[] = [],
    operator: string = "ilike",
    limit: number = 10
  ): Promise<unknown> {
    return this.execute(model, "name_search", [], {
      name,
      args: domain,
      operator,
      limit,
    });
  }

  async getFields(
    model: string,
    attributes?: string[]
  ): Promise<unknown> {
    const kwargs: Record<string, unknown> = {};
    if (attributes && attributes.length > 0) kwargs.attributes = attributes;

    return this.execute(model, "fields_get", [], kwargs);
  }
}
