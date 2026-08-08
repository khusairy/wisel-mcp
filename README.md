# Wisel MCP

Remote editorial bridge for Wisel.my. It exposes an authenticated, review-only MCP server that talks to the Wisel editorial API on the VPS.

## Authentication

The MCP resource server delegates OAuth to WorkOS AuthKit. It does not issue, store, refresh, or validate its own OAuth tokens.

On an unauthenticated request, the MCP advertises:

- Resource: `https://api.wisel.my/mcp`
- Resource metadata: `https://api.wisel.my/.well-known/oauth-protected-resource/mcp`
- Authorization server: the configured `WORKOS_AUTHKIT_DOMAIN`

The service validates each AuthKit JWT against `<WORKOS_AUTHKIT_DOMAIN>/oauth2/jwks`, requiring its issuer to be the AuthKit domain and its audience to be the MCP resource URL. There is no shared `MCP_API_TOKEN` bypass.

### WorkOS setup

1. Create an AuthKit application and choose its AuthKit domain.
2. In **Connect → Configuration**, enable **Client ID Metadata Document (CIMD)**. Enable Dynamic Client Registration as backwards compatibility for clients that need it.
3. In **Connect → Resource indicators**, add `https://api.wisel.my/mcp` and set it as the default resource indicator.
4. Add only the intended Wisel editor account(s) to AuthKit. The MCP itself has no public publish or scheduling operation.

WorkOS hosts the OAuth authorization, token, consent, registration, and refresh-token endpoints. Wisel only serves protected-resource metadata; it also proxies authorization-server metadata for older MCP clients.

## Configuration

The deployed container expects:

```bash
WISEL_API_URL=http://127.0.0.1:3003
WISEL_API_TOKEN=<existing editorial API token>
WORKOS_AUTHKIT_DOMAIN=https://<your-authkit-domain>
WISEL_MCP_RESOURCE_URL=https://api.wisel.my/mcp
WISEL_MEDIA_PUBLIC_URL=https://api.wisel.my/media
PORT=3004
```

Do not add an `MCP_API_TOKEN` or the legacy `OAUTH_*` variables. They are no longer used.

## MCP tools

The remote MCP exposes:

- `health_check`
- `list_wisel_stories`
- `get_wisel_story`
- `create_wisel_story_for_review`
- `attach_wisel_story_thumbnail`
- `update_wisel_story`

There is intentionally no MCP publish or schedule tool. New or updated stories are always kept in `review`; publishing and scheduling remain human actions in the Wisel admin dashboard.

The MCP does not connect directly to PostgreSQL. It uses the existing editorial API so validation and persistence remain centralized. Thumbnail files are stored on persistent VPS media storage; PostgreSQL stores only the resulting public `coverImageUrl`.

## Local build

```bash
npm install
npm run test
npm run build
```

## VPS deployment

The production checkout lives at:

```text
/opt/apps/wisel-mcp
```

After the WorkOS configuration is complete, update `/opt/apps/wisel-mcp/.env` and rebuild:

```bash
cd /opt/apps/wisel-mcp
git pull
docker compose --env-file /opt/apps/wisel-mcp/.env up -d --build --force-recreate
docker compose logs --tail=80 wisel-mcp
```

The service uses host networking and listens on port `3004`.

## Reverse proxy for MCP

Expose the MCP through TLS as:

```text
https://api.wisel.my/mcp
```

Proxy `/mcp` and `/.well-known/oauth-protected-resource/mcp` to `http://127.0.0.1:3004`. The latter is required for OAuth discovery.

## Health check

```bash
curl -sS http://127.0.0.1:3004/health
```

Expected:

```json
{"status":"ok","service":"wisel-mcp","authorization":"workos-authkit"}
```
