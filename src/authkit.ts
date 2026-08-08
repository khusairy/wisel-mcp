import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

function requiredHttpsUrl(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required.`);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must be an HTTPS URL.`);
  return url.toString().replace(/\/$/, "");
}

export const authkitDomain = requiredHttpsUrl("WORKOS_AUTHKIT_DOMAIN", process.env.WORKOS_AUTHKIT_DOMAIN);
export const mcpResourceUrl = requiredHttpsUrl("WISEL_MCP_RESOURCE_URL", process.env.WISEL_MCP_RESOURCE_URL || "https://api.wisel.my/mcp");
export const authkitResourceMetadataUrl = `${mcpResourceUrl}/.well-known/oauth-protected-resource`;
const authorizationServerMetadataUrl = `${authkitDomain}/.well-known/oauth-authorization-server`;
const jwks = createRemoteJWKSet(new URL(`${authkitDomain}/oauth2/jwks`));

export const authkitMetadata = {
  resource: mcpResourceUrl,
  authorization_servers: [authkitDomain],
  bearer_methods_supported: ["header"],
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export async function authkitAuthorizeBearer(authorization?: string) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return false;

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: authkitDomain,
      audience: mcpResourceUrl,
    });
    return typeof payload.sub === "string" && payload.sub.length > 0;
  } catch {
    return false;
  }
}

export async function handleAuthkitMetadataRequest(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")
  ) {
    sendJson(res, 200, authkitMetadata, { "access-control-allow-origin": "*" });
    return true;
  }

  // Compatibility for MCP clients that query authorization-server metadata from
  // the resource server instead of following protected-resource metadata.
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    try {
      const upstream = await fetch(authorizationServerMetadataUrl, {
        headers: { accept: "application/json" },
      });
      if (!upstream.ok) throw new Error(`AuthKit metadata request failed: ${upstream.status}`);
      sendJson(res, 200, await upstream.json(), { "access-control-allow-origin": "*" });
    } catch (error) {
      sendJson(res, 503, { error: "AuthKit authorization metadata is unavailable" });
      console.error(error);
    }
    return true;
  }

  return false;
}
