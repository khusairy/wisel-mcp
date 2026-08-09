import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { wisel } from "./client.js";
import { authkitAuthorizeBearer, authkitMetadata, authkitResourceMetadataUrl, handleAuthkitMetadataRequest } from "./authkit.js";

const port = Number(process.env.PORT || 3004);
const mediaDir = process.env.WISEL_MEDIA_DIR || "/media";
const mediaPublicUrl = (process.env.WISEL_MEDIA_PUBLIC_URL || "https://api.wisel.my/media").replace(/\/$/, "");
const maxThumbnailBytes = 1_500_000;

const result = (data: unknown, message?: string) => ({
  content: [{ type: "text" as const, text: message ?? JSON.stringify(data, null, 2) }],
  structuredContent: typeof data === "object" && data !== null ? data as Record<string, unknown> : undefined,
});

async function authorized(authorization?: string) {
  return authkitAuthorizeBearer(authorization);
}

const imageExtensions: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

function safeMediaStem(value: string) {
  const stem = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return stem || `wisel-${Date.now()}`;
}

async function storeThumbnailBytes(bytes: Buffer, mimeType: string, preferredName: string) {
  const extension = imageExtensions[mimeType];
  if (!extension) throw new Error("Thumbnail must be WebP, PNG or JPEG.");
  if (!bytes.length) throw new Error("Thumbnail data is empty or invalid.");
  if (bytes.length > maxThumbnailBytes) throw new Error("Thumbnail is too large. Keep it below 1.5 MB, preferably below 300 KB.");

  await mkdir(mediaDir, { recursive: true });
  const filename = `${safeMediaStem(preferredName)}-${Date.now()}.${extension}`;
  await writeFile(join(mediaDir, filename), bytes, { mode: 0o644 });
  return {
    filename,
    size: bytes.length,
    mimeType,
    url: `${mediaPublicUrl}/${encodeURIComponent(filename)}`,
  };
}

async function storeThumbnail(imageBase64: string, mimeType: string, preferredName: string) {
  const normalized = imageBase64.includes(",") ? imageBase64.slice(imageBase64.indexOf(",") + 1) : imageBase64;
  return storeThumbnailBytes(Buffer.from(normalized, "base64"), mimeType, preferredName);
}

async function storeThumbnailFromUrl(imageUrl: string, preferredName: string) {
  let source: URL;
  try {
    source = new URL(imageUrl);
  } catch {
    throw new Error("thumbnailImageUrl must be a valid HTTPS URL.");
  }
  if (source.protocol !== "https:" || source.username || source.password) {
    throw new Error("thumbnailImageUrl must be a credential-free HTTPS URL.");
  }

  const response = await fetch(source, {
    headers: { accept: "image/webp,image/png,image/jpeg" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Thumbnail download failed: ${response.status}.`);

  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  if (!mimeType || !imageExtensions[mimeType]) {
    throw new Error("Thumbnail URL must return a WebP, PNG or JPEG image.");
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxThumbnailBytes) {
    throw new Error("Thumbnail is too large. Keep it below 1.5 MB, preferably below 300 KB.");
  }
  if (!response.body) throw new Error("Thumbnail URL returned an empty response.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxThumbnailBytes) {
        await reader.cancel();
        throw new Error("Thumbnail is too large. Keep it below 1.5 MB, preferably below 300 KB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return storeThumbnailBytes(Buffer.concat(chunks), mimeType, preferredName);
}

function createMcpServer() {
  const server = new McpServer({ name: "wisel-mcp", version: "0.4.0" });

  server.tool("health_check", "Check the Wisel editorial API", {}, async () => result(await wisel.health()));

  server.tool(
    "list_wisel_stories",
    "List Wisel editorial stories across draft, review, scheduled and published states. Use before drafting to check for overlapping coverage.",
    {
      status: z.enum(["draft", "review", "scheduled", "published"]).optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ status, query, limit }) => {
      const data = await wisel.list(status) as { stories?: Array<Record<string, unknown>> };
      const needle = query?.trim().toLowerCase();
      const stories = (data.stories ?? []).filter((story) => {
        if (!needle) return true;
        return [story.title, story.excerpt, story.category, story.slug].some(
          value => typeof value === "string" && value.toLowerCase().includes(needle),
        );
      }).slice(0, limit ?? 30);
      return result({ stories, count: stories.length });
    },
  );

  server.tool(
    "get_wisel_story",
    "Read one Wisel editorial story by slug or numeric ID, including unpublished stories.",
    { id: z.string().min(1) },
    async ({ id }) => result(await wisel.get(id)),
  );

  server.tool(
    "create_wisel_story_for_review",
    "Create a new Wisel story for human review. Optionally include an AI-generated thumbnail as base64; the MCP saves it to VPS media storage and stores its public URL on the story.",
    {
      slug: z.string().min(1),
      title: z.string().min(1),
      content: z.string().min(1),
      excerpt: z.string().nullable().optional(),
      category: z.string().min(1),
      authorName: z.string().optional(),
      coverImageUrl: z.string().nullable().optional(),
      thumbnailBase64: z.string().min(1).optional(),
      thumbnailMimeType: z.enum(["image/webp", "image/png", "image/jpeg"]).optional(),
      thumbnailImageUrl: z.string().url().optional(),
      seoTitle: z.string().nullable().optional(),
      seoDescription: z.string().nullable().optional(),
      sourceUrl: z.string().nullable().optional(),
      confirmationStatus: z.enum(["confirmed", "developing", "rumour"]).optional(),
    },
    async ({ thumbnailBase64, thumbnailMimeType, thumbnailImageUrl, ...story }) => {
      try {
        await wisel.get(story.slug);
        throw new Error(`A Wisel story with slug '${story.slug}' already exists. Use update_wisel_story or attach_wisel_story_thumbnail instead.`);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Wisel API 404")) {
          if (error instanceof Error && error.message.startsWith("A Wisel story")) throw error;
          throw error;
        }
      }

      let coverImageUrl = story.coverImageUrl ?? null;
      let thumbnail: Awaited<ReturnType<typeof storeThumbnail>> | null = null;
      if (thumbnailImageUrl && (thumbnailBase64 || thumbnailMimeType)) {
        throw new Error("Provide either thumbnailImageUrl or thumbnailBase64 with thumbnailMimeType, not both.");
      }
      if (thumbnailBase64 || thumbnailMimeType) {
        if (!thumbnailBase64 || !thumbnailMimeType) throw new Error("Provide both thumbnailBase64 and thumbnailMimeType.");
        thumbnail = await storeThumbnail(thumbnailBase64, thumbnailMimeType, story.slug);
        coverImageUrl = thumbnail.url;
      } else if (thumbnailImageUrl) {
        thumbnail = await storeThumbnailFromUrl(thumbnailImageUrl, story.slug);
        coverImageUrl = thumbnail.url;
      }

      const created = await wisel.create({
        ...story,
        coverImageUrl,
        authorName: story.authorName ?? "Wisel Malaysia",
        confirmationStatus: story.confirmationStatus ?? "confirmed",
        status: "review",
      });
      const verified = await wisel.get(story.slug);
      return result({ created, verified, thumbnail }, `Saved '${story.title}' to Wisel for review${thumbnail ? " with its thumbnail" : ""} and verified the stored record.`);
    },
  );

  server.tool(
    "attach_wisel_story_thumbnail",
    "Download an approved HTTPS image or accept Base64 image data, store it in persistent Wisel VPS media storage, and attach its public URL to an existing story. The story remains in review status.",
    {
      id: z.string().min(1),
      imageBase64: z.string().min(1).optional(),
      mimeType: z.enum(["image/webp", "image/png", "image/jpeg"]).optional(),
      imageUrl: z.string().url().optional(),
      filenameStem: z.string().min(1).optional(),
    },
    async ({ id, imageBase64, mimeType, imageUrl, filenameStem }) => {
      if (imageUrl && (imageBase64 || mimeType)) {
        throw new Error("Provide either imageUrl or imageBase64 with mimeType, not both.");
      }
      if (!imageUrl && (!imageBase64 || !mimeType)) {
        throw new Error("Provide imageUrl, or provide both imageBase64 and mimeType.");
      }
      const current = await wisel.get(id) as { story?: Record<string, unknown> };
      const slug = typeof current.story?.slug === "string" ? current.story.slug : id;
      const thumbnail = imageUrl
        ? await storeThumbnailFromUrl(imageUrl, filenameStem ?? slug)
        : await storeThumbnail(imageBase64!, mimeType!, filenameStem ?? slug);
      const updated = await wisel.update(id, { coverImageUrl: thumbnail.url, status: "review" });
      const verified = await wisel.get(id);
      return result({ thumbnail, updated, verified }, `Uploaded the thumbnail and attached it to '${slug}' for review.`);
    },
  );

  server.tool(
    "update_wisel_story",
    "Update an existing Wisel story while keeping it in the human-review workflow. This tool cannot publish or schedule stories.",
    {
      id: z.string().min(1),
      slug: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      content: z.string().min(1).optional(),
      excerpt: z.string().nullable().optional(),
      category: z.string().min(1).optional(),
      authorName: z.string().optional(),
      coverImageUrl: z.string().nullable().optional(),
      seoTitle: z.string().nullable().optional(),
      seoDescription: z.string().nullable().optional(),
      sourceUrl: z.string().nullable().optional(),
      confirmationStatus: z.enum(["confirmed", "developing", "rumour"]).optional(),
    },
    async ({ id, ...patch }) => {
      if (Object.keys(patch).length === 0) throw new Error("Provide at least one story field to update.");
      const updated = await wisel.update(id, { ...patch, status: "review" });
      const verified = await wisel.get(typeof patch.slug === "string" ? patch.slug : id);
      return result({ updated, verified }, "Updated the Wisel story and returned it to review status.");
    },
  );

  return server;
}

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, Session>();

async function readJsonBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4_000_000) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : undefined;
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (await handleAuthkitMetadataRequest(req, res, url)) return;

    if (req.method === "GET" && url.pathname === "/health") {
      try {
        await wisel.health();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ status: "ok", service: "wisel-mcp", authorization: "workos-authkit" }));
      } catch (error) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : "Wisel API unavailable" }));
      }
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Not found" }));
    }

    if (!await authorized(req.headers.authorization)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="unauthorized", resource_metadata="${authkitResourceMetadataUrl}"`,
      });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }

    const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;

    if (req.method === "POST") {
      const body = await readJsonBody(req);

      if (!sessionId && isInitializeRequest(body)) {
        const server = createMcpServer();
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        return await transport.handleRequest(req, res, body);
      }

      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: missing or invalid Mcp-Session-Id" },
          id: body?.id ?? null,
        }));
      }

      return await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
    }

    if ((req.method === "GET" || req.method === "DELETE") && sessionId && sessions.has(sessionId)) {
      return await sessions.get(sessionId)!.transport.handleRequest(req, res);
    }

    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing or invalid Mcp-Session-Id" }));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "MCP request failed" }));
  }
});

http.listen(port, "0.0.0.0", () => {
  console.log(`Wisel MCP listening on :${port}`);
});
