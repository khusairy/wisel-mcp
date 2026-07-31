import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wisel } from "./client.js";

const server = new McpServer({ name: "wisel-mcp", version: "0.1.0" });
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
server.tool("health_check", "Check the Wisel API", {}, async () => result(await wisel.health()));
server.tool("list_stories", "List Wisel editorial stories", { status: z.string().optional() }, async ({ status }) => result(await wisel.list(status)));
server.tool("get_story", "Read one Wisel story", { id: z.string() }, async ({ id }) => result(await wisel.get(id)));
server.tool("create_story_draft", "Create a Wisel story as draft", { story: z.record(z.string(), z.unknown()) }, async ({ story }) => result(await wisel.create(story)));
server.tool("update_story", "Apply a small editorial update", { id: z.string(), patch: z.record(z.string(), z.unknown()) }, async ({ id, patch }) => result(await wisel.update(id, patch)));
server.tool("publish_story", "Publish a reviewed story", { id: z.string() }, async ({ id }) => result(await wisel.publish(id)));
server.tool("schedule_story", "Schedule a reviewed story", { id: z.string(), publishAt: z.string() }, async ({ id, publishAt }) => result(await wisel.schedule(id, publishAt)));
await server.connect(new StdioServerTransport());
