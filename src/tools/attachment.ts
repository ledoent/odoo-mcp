import { z } from "zod";
import type { OdooClient } from "../odoo-client.js";
import type { OdooDomain } from "../types.js";

export const listAttachmentsTool = {
  name: "list_attachments",
  description:
    "List file attachments on a specific Odoo record or search all attachments.",
  inputSchema: {
    model: z
      .string()
      .optional()
      .describe(
        "Odoo model name to filter by (e.g., 'sale.order'). If omitted, searches all attachments"
      ),
    res_id: z
      .number()
      .optional()
      .describe("Record ID to filter by. Used together with model"),
    domain: z
      .string()
      .optional()
      .describe(
        'Additional domain filter as JSON array. Default: []'
      ),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of attachments to return. Default: 20, max: 200"),
  },
};

export async function handleListAttachments(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const model = args.model as string | undefined;
  const resId = args.res_id as number | undefined;
  const rawLimit = (args.limit as number) ?? 20;
  const limit = Math.min(Math.max(1, rawLimit), 200);

  let extraDomain: OdooDomain = [];
  if (args.domain) {
    try {
      const parsed = JSON.parse(args.domain as string);
      if (!Array.isArray(parsed)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "domain must be a JSON array" }, null, 2) }],
          isError: true,
        };
      }
      extraDomain = parsed as OdooDomain;
    } catch {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Failed to parse domain JSON. Please provide a valid JSON array" }, null, 2) }],
        isError: true,
      };
    }
  }

  const domain: OdooDomain = [...extraDomain];
  if (model) domain.push(["res_model", "=", model]);
  if (resId !== undefined) domain.push(["res_id", "=", resId]);

  const attachments = await client.searchRead(
    "ir.attachment",
    domain,
    [
      "name",
      "mimetype",
      "file_size",
      "res_model",
      "res_id",
      "create_date",
      "type",
      "url",
    ],
    limit,
    undefined,
    "create_date desc"
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { count: attachments.length, attachments },
          null,
          2
        ),
      },
    ],
  };
}

export const uploadAttachmentTool = {
  name: "upload_attachment",
  description:
    "Upload a file attachment to an Odoo record. File content must be base64-encoded.",
  inputSchema: {
    name: z.string().describe("File name (e.g., 'report.pdf')"),
    model: z
      .string()
      .describe("Odoo model to attach to (e.g., 'res.partner')"),
    res_id: z.number().describe("Record ID to attach the file to"),
    data: z.string().describe("Base64-encoded file content"),
    mimetype: z
      .string()
      .optional()
      .describe(
        "MIME type (e.g., 'application/pdf', 'image/png'). Auto-detected if not provided"
      ),
    description: z.string().optional().describe("Optional file description"),
  },
};

// Allow only pure base64 characters (after stripping whitespace); at most 2 padding chars
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

// Maximum allowed upload size: 25MB (~33.8MB when base64-encoded)
const MAX_UPLOAD_SIZE_MB = 25;
const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_SIZE_MB * 1024 * 1024 * (4 / 3));

// Filename security check: block path traversal and dangerous characters
const UNSAFE_FILENAME_REGEX = /[/\\:*?"<>|]/;

export async function handleUploadAttachment(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const name = args.name as string;
  const data = args.data as string;

  // Validate the filename
  if (!name || name.trim() === "") {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "Filename is empty" }, null, 2) }],
      isError: true,
    };
  }
  if (UNSAFE_FILENAME_REGEX.test(name) || name.includes("..")) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "Filename contains disallowed characters (/, \\, .., :, *, ?, \", <, >, | are not allowed)" }, null, 2) }],
      isError: true,
    };
  }

  // Normalize base64: strip whitespace
  const cleanData = data.replace(/\s/g, "");

  // Validate the size limit
  if (cleanData.length > MAX_UPLOAD_BASE64_CHARS) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: `File is too large. The maximum upload size is ${MAX_UPLOAD_SIZE_MB}MB` }, null, 2) }],
      isError: true,
    };
  }

  // Validate base64 format
  if (!BASE64_REGEX.test(cleanData)) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid base64 data" }, null, 2) }],
      isError: true,
    };
  }

  const values: Record<string, unknown> = {
    name: name.trim(),
    res_model: args.model,
    res_id: args.res_id,
    datas: cleanData,
    type: "binary",
  };

  if (args.mimetype) values.mimetype = args.mimetype;
  if (args.description) values.description = args.description;

  const id = await client.create("ir.attachment", values);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { success: true, attachment_id: id, name: name.trim() },
          null,
          2
        ),
      },
    ],
  };
}

export const downloadAttachmentTool = {
  name: "download_attachment",
  description:
    "Download/read an attachment by ID. Returns the base64-encoded file content.",
  inputSchema: {
    id: z.number().describe("Attachment ID to download"),
  },
};

const MAX_DOWNLOAD_SIZE_MB = 25;
const MAX_DOWNLOAD_SIZE_BYTES = MAX_DOWNLOAD_SIZE_MB * 1024 * 1024;

export async function handleDownloadAttachment(
  client: OdooClient,
  args: Record<string, unknown>
) {
  const id = args.id as number;

  // First read only the metadata to check the file size
  const metaRecords = (await client.read("ir.attachment", [id], [
    "name",
    "mimetype",
    "file_size",
  ])) as Record<string, unknown>[];

  if (!metaRecords || metaRecords.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Attachment with ID ${id} not found` }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const meta = metaRecords[0];
  const fileSize = meta.file_size as number;

  if (fileSize > MAX_DOWNLOAD_SIZE_BYTES) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: `File is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). The maximum download size is ${MAX_DOWNLOAD_SIZE_MB}MB`,
              id,
              name: meta.name,
              mimetype: meta.mimetype,
              file_size: fileSize,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // After the size check, read the actual data
  const records = (await client.read("ir.attachment", [id], [
    "name",
    "mimetype",
    "file_size",
    "datas",
  ])) as Record<string, unknown>[];

  if (!records || records.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Attachment with ID ${id} not found` }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const attachment = records[0];
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            id,
            name: attachment.name,
            mimetype: attachment.mimetype,
            file_size: attachment.file_size,
            data: attachment.datas,
          },
          null,
          2
        ),
      },
    ],
  };
}
