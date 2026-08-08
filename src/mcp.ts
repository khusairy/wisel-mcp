import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { wisel } from "./client.js";

const port = Number(process.env.PORT || 3004);
const mcpToken = process.env.MCP_API_TOKEN;
if (!mcpToken) throw new Error("MCP_API_TOKEN is required.");

const server = new McpServer({ name: "wisel-mcp", version: "0.2.0" });
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

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
await server.connect(transport);

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
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "MCP request failed" }));
  }
});

http.listen(port, "0.0.0.0", () => {
  console.log(`Wisel MCP listening on :${port}`);
});
