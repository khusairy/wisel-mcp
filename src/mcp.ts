import { createServer, type IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { wisel } from "./client.js";

const port = Number(process.env.PORT || 3004);
const mcpToken = process.env.MCP_API_TOKEN;
if (!mcpToken) throw new Error("MCP_API_TOKEN is required.");

const result = (data: unknown, message?: string) => ({
  content: [{ type: "text" as const, text: message ?? JSON.stringify(data, null, 2) }],
  structuredContent: typeof data === "object" && data !== null ? data as Record<string, unknown> : undefined,
});

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const authorized = (authorization?: string) => {
  const prefix = "Bearer ";
  return Boolean(authorization?.startsWith(prefix) && safeEqual(authorization.slice(prefix.length), mcpToken));
};

function createMcpServer() {
  const server = new McpServer({ name: "wisel-mcp", version: "0.2.1" });

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
    "Create a new Wisel story for human review in the admin dashboard. The story is always saved with review status and is never published automatically.",
    {
      slug: z.string().min(1),
      title: z.string().min(1),
      content: z.string().min(1),
      excerpt: z.string().nullable().optional(),
      category: z.string().min(1),
      authorName: z.string().optional(),
      coverImageUrl: z.string().nullable().optional(),
      seoTitle: z.string().nullable().optional(),
      seoDescription: z.string().nullable().optional(),
      sourceUrl: z.string().nullable().optional(),
      confirmationStatus: z.enum(["confirmed", "developing", "rumour"]).optional(),
    },
    async (story) => {
      try {
        await wisel.get(story.slug);
        throw new Error(`A Wisel story with slug '${story.slug}' already exists. Use update_wisel_story instead.`);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Wisel API 404")) {
          if (error instanceof Error && error.message.startsWith("A Wisel story")) throw error;
          throw error;
        }
      }

      const created = await wisel.create({
        ...story,
        authorName: story.authorName ?? "Wisel Malaysia",
        confirmationStatus: story.confirmationStatus ?? "confirmed",
        status: "review",
      });
      const verified = await wisel.get(story.slug);
      return result({ created, verified }, `Saved '${story.title}' to Wisel for review and verified the stored record.`);
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
    if (raw.length > 2_000_000) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : undefined;
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    try {
      await wisel.health();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ status: "ok", service: "wisel-mcp" }));
    } catch (error) {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : "Wisel API unavailable" }));
    }
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  if (!authorized(req.headers.authorization)) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  try {
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
