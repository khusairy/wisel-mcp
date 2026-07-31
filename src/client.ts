export type Story = Record<string, unknown>;

const apiUrl = (process.env.WISEL_API_URL || "http://127.0.0.1:3003").replace(/\/$/, "");
const token = process.env.WISEL_API_TOKEN;

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`Wisel API ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

export const wisel = {
  health: () => request("/health"),
  list: (status?: string) => request(`/editorial/stories${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  get: (id: string) => request(`/editorial/stories/${encodeURIComponent(id)}`),
  create: async (story: Story, thumbnail?: string) => {
    if (!thumbnail) return request("/editorial/stories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...story, status: "draft" }) });
    const form = new FormData();
    form.set("story", JSON.stringify({ ...story, status: "draft" }));
    const bytes = await import("node:fs/promises").then(fs => fs.readFile(thumbnail));
    form.set("thumbnail", new Blob([bytes]));
    return request("/editorial/stories", { method: "POST", body: form });
  },
  update: (id: string, patch: Story) => request(`/editorial/stories/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
  publish: (id: string) => request(`/editorial/stories/${encodeURIComponent(id)}/publish`, { method: "POST" }),
  schedule: (id: string, publishAt: string) => request(`/editorial/stories/${encodeURIComponent(id)}/schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publishAt }) })
};
