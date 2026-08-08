# Wisel MCP

Remote editorial bridge for Wisel.my. It provides a CLI and an authenticated MCP server that talks to the Wisel editorial API on the VPS.

## Architecture

```text
MCP client
   |
   | HTTPS + MCP_API_TOKEN
   v
Wisel MCP :3004
   |
   | WISEL_API_TOKEN
   v
Wisel API :3003
   |
   v
PostgreSQL
   |
   v
/admin review dashboard
```

The MCP does not connect directly to PostgreSQL. It uses the existing editorial API so validation and persistence remain centralized.

## Configuration

The deployed container expects:

```bash
WISEL_API_URL=http://127.0.0.1:3003
WISEL_API_TOKEN=<existing editorial API token>
MCP_API_TOKEN=<separate long random secret>
PORT=3004
```

Do not reuse `WISEL_API_TOKEN` as the public MCP bearer token.

## MCP tools

The remote MCP exposes:

- `health_check`
- `list_wisel_stories`
- `get_wisel_story`
- `create_wisel_story_for_review`
- `update_wisel_story`

There is intentionally no MCP publish or schedule tool. Publishing and scheduling remain human actions in the Wisel admin dashboard.

New stories are saved with `review` status. The create tool also reads the saved record back from the Wisel API before reporting success.

## Local build

```bash
npm install
npm run test
npm run build
```

## VPS deployment

The production checkout currently lives at:

```text
/opt/apps/wisel-mcp
```

Add a dedicated MCP secret to `/opt/apps/wisel-mcp/.env`:

```bash
MCP_API_TOKEN=<long-random-secret>
```

Then rebuild only the MCP project:

```bash
cd /opt/apps/wisel-mcp
git pull
docker compose up -d --build
```

The service uses host networking so it can continue reaching the existing production API at `127.0.0.1:3003`. It listens on port `3004`.

## Health check

```bash
curl -sS http://127.0.0.1:3004/health
```

Expected:

```json
{"status":"ok","service":"wisel-mcp"}
```

## MCP initialize test

```bash
curl -sS http://127.0.0.1:3004/mcp \
  -H "Authorization: Bearer $MCP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-test","version":"1"}}}'
```

## Reverse proxy

Once the local endpoint works, expose it through TLS, preferably as:

```text
https://api.wisel.my/mcp
```

Proxy that path to:

```text
http://127.0.0.1:3004/mcp
```

Keep the bearer token requirement in place.

## CLI

The existing CLI remains available for manual administration:

```bash
npm install
npm run build
node dist/cli.js health
node dist/cli.js stories --status draft
```

The MCP workflow, however, is intentionally review-first and cannot publish.

## Story Publisher workflow

A normal Wisel Story Publisher run should:

1. Call `list_wisel_stories` to check for duplicate or overlapping coverage.
2. Research and verify the story.
3. Write the article and metadata.
4. Call `create_wisel_story_for_review`.
5. Confirm the tool's read-back verification succeeded.
6. Tell the editor the story is ready in `/admin`.

If the slug already exists, inspect the existing story and use `update_wisel_story` only when the new material is genuinely an update to that coverage.
