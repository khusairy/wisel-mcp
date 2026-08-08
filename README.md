# Wisel MCP

Remote editorial bridge for Wisel.my. It provides a CLI and an authenticated MCP server that talks to the Wisel editorial API on the VPS.

## Architecture

```text
MCP client
   |
   | HTTPS + MCP_API_TOKEN
   v
Wisel MCP :3004
   |                    \
   | WISEL_API_TOKEN     \ AI thumbnail bytes
   v                      v
Wisel API :3003       /opt/apps/wisel/media
   |                      |
   v                      v
PostgreSQL          https://api.wisel.my/media/...
   |
   v
/admin review dashboard
```

The MCP does not connect directly to PostgreSQL. It uses the existing editorial API so validation and persistence remain centralized. Thumbnail files are stored on persistent VPS media storage; PostgreSQL stores only the resulting public `coverImageUrl`.

## Configuration

The deployed container expects:

```bash
WISEL_API_URL=http://127.0.0.1:3003
WISEL_API_TOKEN=<existing editorial API token>
MCP_API_TOKEN=<separate long random secret>
WISEL_MEDIA_PUBLIC_URL=https://api.wisel.my/media
PORT=3004
```

Do not reuse `WISEL_API_TOKEN` as the public MCP bearer token.

The Docker Compose file bind-mounts `/opt/apps/wisel/media` into the MCP container at `/media`, so generated thumbnails survive MCP container rebuilds.

## MCP tools

The remote MCP exposes:

- `health_check`
- `list_wisel_stories`
- `get_wisel_story`
- `create_wisel_story_for_review`
- `attach_wisel_story_thumbnail`
- `update_wisel_story`

There is intentionally no MCP publish or schedule tool. Publishing and scheduling remain human actions in the Wisel admin dashboard.

New stories are saved with `review` status. The create tool also reads the saved record back from the Wisel API before reporting success.

`create_wisel_story_for_review` can optionally receive `thumbnailBase64` and `thumbnailMimeType`. When supplied, the MCP stores the image on the VPS and automatically saves the resulting `coverImageUrl` with the story.

`attach_wisel_story_thumbnail` is used when a story already exists. It uploads the image, patches `coverImageUrl`, keeps the story in `review`, and verifies the saved record.

Supported image types are WebP, PNG and JPEG. Keep thumbnails under 1.5 MB; below 300 KB is preferred.

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
WISEL_MEDIA_PUBLIC_URL=https://api.wisel.my/media
```

Then create the media directory and rebuild only the MCP project:

```bash
mkdir -p /opt/apps/wisel/media
chmod 755 /opt/apps/wisel/media
cd /opt/apps/wisel-mcp
git pull
docker compose --env-file /opt/apps/wisel-mcp/.env up -d --build --force-recreate
```

The service uses host networking so it can continue reaching the existing production API at `127.0.0.1:3003`. It listens on port `3004`.

## Serving media

The public web server/reverse proxy for `api.wisel.my` should serve the media directory directly. For Nginx:

```nginx
location /media/ {
    alias /opt/apps/wisel/media/;
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

After reloading Nginx, a file such as `/opt/apps/wisel/media/example.webp` should be available at:

```text
https://api.wisel.my/media/example.webp
```

## Health check

```bash
curl -sS http://127.0.0.1:3004/health
```

Expected:

```json
{"status":"ok","service":"wisel-mcp"}
```

## Reverse proxy for MCP

Expose the MCP through TLS, preferably as:

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
4. Generate a 16:9 editorial thumbnail, preferably WebP below 300 KB.
5. Call `create_wisel_story_for_review` with the thumbnail included, or use `attach_wisel_story_thumbnail` when updating an existing story.
6. Confirm both the thumbnail URL and article read-back verification succeeded.
7. Tell the editor the story is ready in `/admin`.

If the slug already exists, inspect the existing story and use `update_wisel_story` only when the new material is genuinely an update to that coverage.
