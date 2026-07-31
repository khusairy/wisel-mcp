# Wisel MCP

Editorial bridge for Wisel.my. It provides a small CLI and MCP server that talk to the Wisel API on the Hostinger VPS.

## Architecture

The MCP/CLI runs in the trusted editorial environment and calls the VPS API over HTTPS. The VPS API remains private or token-protected; the MCP is not a replacement for the Wisel backend.

## Configuration

```bash
export WISEL_API_URL=https://api.wisel.my
export WISEL_API_TOKEN=replace-me
```

## CLI

```bash
npm install
npm run build
node dist/cli.js health
node dist/cli.js stories --status draft
node dist/cli.js create --file story.json --thumbnail thumbnail.webp
node dist/cli.js publish STORY_ID
```

The CLI sends stories as `draft` by default. Publishing is a separate explicit command.

## MCP

```bash
npm run build
node dist/mcp.js
```

The MCP uses stdio, which is suitable for a future ChatGPT connector/host. It exposes `health_check`, `list_stories`, `get_story`, `create_story_draft`, `update_story`, `publish_story`, and `schedule_story`.

## Story input

See `examples/story.json`. Thumbnail upload is multipart and accepts common image formats. Keep generated thumbnails optimized, preferably WebP/AVIF and below 300 KB.

## VPS contract

The Wisel API should expose the following token-protected routes:

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | API health check |
| GET | `/editorial/stories` | List stories |
| GET | `/editorial/stories/:id` | Read one story |
| POST | `/editorial/stories` | Create draft, optionally with `thumbnail` multipart field |
| PATCH | `/editorial/stories/:id` | Small editorial updates |
| POST | `/editorial/stories/:id/publish` | Publish |
| POST | `/editorial/stories/:id/schedule` | Schedule |

