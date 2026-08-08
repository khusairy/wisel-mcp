import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const issuer = (process.env.OAUTH_ISSUER_URL || "https://api.wisel.my").replace(/\/$/, "");
const resource = (process.env.OAUTH_RESOURCE_URL || `${issuer}/mcp`).replace(/\/$/, "");
const adminPassword = process.env.OAUTH_ADMIN_PASSWORD || "";
const stateFile = process.env.OAUTH_STATE_FILE || "/data/oauth-state.json";
const editorialScope = "wisel:editorial";
const allowedScopes = new Set([editorialScope, "offline_access"]);
const defaultScope = `${editorialScope} offline_access`;
const accessTokenLifetimeSeconds = 60 * 60;
const refreshTokenLifetimeSeconds = 60 * 60 * 24 * 90;

export const oauthResourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;

interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  scope?: string;
  created_at: number;
}

interface TokenGrant {
  clientId: string;
  scope: string;
  expiresAt: number;
}

interface OAuthState {
  clients: Record<string, OAuthClient>;
  accessTokens: Record<string, TokenGrant>;
  refreshTokens: Record<string, TokenGrant>;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

let loaded = false;
let state: OAuthState = { clients: {}, accessTokens: {}, refreshTokens: {} };
const authorizationCodes = new Map<string, AuthorizationCode>();

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const randomToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

async function readRawBody(req: IncomingMessage, maxBytes = 1_000_000) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new Error("Request body too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage) {
  return new URLSearchParams(await readRawBody(req));
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<OAuthState>;
    state = {
      clients: parsed.clients || {},
      accessTokens: parsed.accessTokens || {},
      refreshTokens: parsed.refreshTokens || {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Unable to load OAuth state:", error);
  }
  pruneExpired();
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, grant] of Object.entries(state.accessTokens)) if (grant.expiresAt <= now) delete state.accessTokens[key];
  for (const [key, grant] of Object.entries(state.refreshTokens)) if (grant.expiresAt <= now) delete state.refreshTokens[key];
  for (const [code, grant] of authorizationCodes) if (grant.expiresAt <= now) authorizationCodes.delete(code);
}

async function persistState() {
  await mkdir(dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temp, stateFile);
}

function requestedScopes(raw: string | null | undefined) {
  const scope = (raw || defaultScope).trim().split(/\s+/).filter(Boolean);
  if (!scope.includes(editorialScope) || scope.some(item => !allowedScopes.has(item))) return null;
  return [...new Set(scope)].join(" ");
}

function validRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function clientRedirectAllowed(client: OAuthClient, redirectUri: string) {
  return client.redirect_uris.includes(redirectUri);
}

function appendOAuthError(redirectUri: string, error: string, stateParam?: string | null) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (stateParam) target.searchParams.set("state", stateParam);
  return target.toString();
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

function authorizationServerMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [editorialScope, "offline_access"],
  };
}

function protectedResourceMetadata() {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [editorialScope, "offline_access"],
    bearer_methods_supported: ["header"],
  };
}

async function registerClient(req: IncomingMessage, res: ServerResponse) {
  await ensureLoaded();
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("application/json")) return sendJson(res, 415, { error: "invalid_client_metadata" });

  let body: Record<string, unknown>;
  try { body = JSON.parse(await readRawBody(req)); } catch { return sendJson(res, 400, { error: "invalid_client_metadata" }); }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((item): item is string => typeof item === "string") : [];
  if (!redirectUris.length || redirectUris.some(uri => !validRedirectUri(uri))) return sendJson(res, 400, { error: "invalid_redirect_uri" });

  const clientId = randomToken("wisel_client");
  const scope = requestedScopes(typeof body.scope === "string" ? body.scope : undefined) || defaultScope;
  const client: OAuthClient = {
    client_id: clientId,
    redirect_uris: [...new Set(redirectUris)],
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
    scope,
    created_at: Math.floor(Date.now() / 1000),
  };
  state.clients[clientId] = client;
  await persistState();

  return sendJson(res, 201, {
    client_id: client.client_id,
    client_id_issued_at: client.created_at,
    redirect_uris: client.redirect_uris,
    client_name: client.client_name,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: client.scope,
  });
}

async function validateAuthorize(params: URLSearchParams) {
  await ensureLoaded();
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const client = state.clients[clientId];
  if (!client || !clientRedirectAllowed(client, redirectUri)) return { error: "invalid_client" as const };
  if (params.get("response_type") !== "code") return { error: "unsupported_response_type" as const, redirectUri };
  if (!params.get("code_challenge") || params.get("code_challenge_method") !== "S256") return { error: "invalid_request" as const, redirectUri };
  const scope = requestedScopes(params.get("scope"));
  if (!scope) return { error: "invalid_scope" as const, redirectUri };
  const requestedResource = params.get("resource") || resource;
  if (requestedResource.replace(/\/$/, "") !== resource) return { error: "invalid_target" as const, redirectUri };
  return { client, clientId, redirectUri, scope, requestedResource };
}

async function authorizeGet(url: URL, res: ServerResponse) {
  if (!adminPassword) return sendHtml(res, 503, "<!doctype html><meta charset=utf-8><title>Wisel OAuth</title><p>OAuth is not configured.</p>");
  const validation = await validateAuthorize(url.searchParams);
  if ("error" in validation) {
    if (validation.redirectUri) return redirect(res, appendOAuthError(validation.redirectUri, validation.error, url.searchParams.get("state")));
    return sendJson(res, 400, { error: validation.error });
  }

  const hidden = [...url.searchParams.entries()].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
  const clientName = escapeHtml(validation.client.client_name || "ChatGPT");
  return sendHtml(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Wisel MCP</title><style>body{margin:0;background:#f4f6f1;color:#102a43;font:16px system-ui,sans-serif}.card{max-width:460px;margin:10vh auto;padding:32px;background:white;border:1px solid #d9dedc;border-radius:18px;box-shadow:0 16px 45px #102a4318}h1{margin:0 0 10px}p{line-height:1.5;color:#52606d}label{display:block;font-weight:650;margin:24px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px 14px;border:1px solid #bcccdc;border-radius:10px;font-size:16px}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#102a43;color:#fff;font-weight:700;font-size:16px;cursor:pointer}.scope{padding:10px 12px;background:#f4f6f1;border-radius:9px;color:#334e68;font-size:14px}</style></head><body><main class="card"><h1>Authorize Wisel MCP</h1><p><strong>${clientName}</strong> is requesting access to Wisel's editorial review workflow.</p><div class="scope">Permission: create, read and update Wisel editorial stories and thumbnails. Publishing remains a human action.</div><form method="post" action="/oauth/authorize">${hidden}<label for="password">Wisel OAuth password</label><input id="password" type="password" name="password" autocomplete="current-password" required autofocus><button type="submit">Authorize ChatGPT</button></form></main></body></html>`);
}

async function authorizePost(req: IncomingMessage, res: ServerResponse) {
  const form = await readForm(req);
  const validation = await validateAuthorize(form);
  if ("error" in validation) {
    if (validation.redirectUri) return redirect(res, appendOAuthError(validation.redirectUri, validation.error, form.get("state")));
    return sendJson(res, 400, { error: validation.error });
  }
  const suppliedPassword = form.get("password") || "";
  if (!adminPassword || !safeEqual(suppliedPassword, adminPassword)) return sendHtml(res, 401, "<!doctype html><meta charset=utf-8><title>Authorization denied</title><p>Invalid Wisel OAuth password. Return to ChatGPT and try again.</p>");

  const code = randomToken("wisel_code");
  authorizationCodes.set(code, {
    clientId: validation.clientId,
    redirectUri: validation.redirectUri,
    codeChallenge: form.get("code_challenge") || "",
    scope: validation.scope,
    resource: validation.requestedResource,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  const target = new URL(validation.redirectUri);
  target.searchParams.set("code", code);
  const stateParam = form.get("state");
  if (stateParam) target.searchParams.set("state", stateParam);
  return redirect(res, target.toString());
}

function pkceMatches(verifier: string, challenge: string) {
  const digest = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(digest, challenge);
}

async function issueTokens(clientId: string, scope: string) {
  pruneExpired();
  const accessToken = randomToken("wisel_at");
  const refreshToken = randomToken("wisel_rt");
  state.accessTokens[tokenHash(accessToken)] = { clientId, scope, expiresAt: Date.now() + accessTokenLifetimeSeconds * 1000 };
  state.refreshTokens[tokenHash(refreshToken)] = { clientId, scope, expiresAt: Date.now() + refreshTokenLifetimeSeconds * 1000 };
  await persistState();
  return { accessToken, refreshToken };
}

async function tokenEndpoint(req: IncomingMessage, res: ServerResponse) {
  await ensureLoaded();
  const form = await readForm(req);
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") || "";
  if (!state.clients[clientId]) return sendJson(res, 401, { error: "invalid_client" });

  if (grantType === "authorization_code") {
    const codeValue = form.get("code") || "";
    const code = authorizationCodes.get(codeValue);
    if (!code || code.expiresAt <= Date.now()) return sendJson(res, 400, { error: "invalid_grant" });
    authorizationCodes.delete(codeValue);
    if (code.clientId !== clientId || code.redirectUri !== (form.get("redirect_uri") || "")) return sendJson(res, 400, { error: "invalid_grant" });
    const verifier = form.get("code_verifier") || "";
    if (!verifier || !pkceMatches(verifier, code.codeChallenge)) return sendJson(res, 400, { error: "invalid_grant" });
    const requestedResource = form.get("resource");
    if (requestedResource && requestedResource.replace(/\/$/, "") !== code.resource.replace(/\/$/, "")) return sendJson(res, 400, { error: "invalid_target" });
    const tokens = await issueTokens(clientId, code.scope);
    return sendJson(res, 200, {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: accessTokenLifetimeSeconds,
      refresh_token: tokens.refreshToken,
      scope: code.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refreshValue = form.get("refresh_token") || "";
    const key = tokenHash(refreshValue);
    const grant = state.refreshTokens[key];
    if (!grant || grant.expiresAt <= Date.now() || grant.clientId !== clientId) return sendJson(res, 400, { error: "invalid_grant" });
    delete state.refreshTokens[key];
    const scope = form.has("scope") ? requestedScopes(form.get("scope")) : grant.scope;
    if (!scope) return sendJson(res, 400, { error: "invalid_scope" });
    const tokens = await issueTokens(clientId, scope);
    return sendJson(res, 200, {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: accessTokenLifetimeSeconds,
      refresh_token: tokens.refreshToken,
      scope,
    });
  }

  return sendJson(res, 400, { error: "unsupported_grant_type" });
}

export async function oauthAuthorizeBearer(authorization?: string) {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const token = authorization.slice(prefix.length);
  if (!token) return false;
  await ensureLoaded();
  pruneExpired();
  const grant = state.accessTokens[tokenHash(token)];
  return Boolean(grant && grant.expiresAt > Date.now() && grant.scope.split(/\s+/).includes(editorialScope));
}

export async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
    sendJson(res, 200, protectedResourceMetadata(), { "access-control-allow-origin": "*" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, authorizationServerMetadata(), { "access-control-allow-origin": "*" });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/oauth/register") {
    await registerClient(req, res);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    await authorizeGet(url, res);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/oauth/authorize") {
    await authorizePost(req, res);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/oauth/token") {
    await tokenEndpoint(req, res);
    return true;
  }
  return false;
}
