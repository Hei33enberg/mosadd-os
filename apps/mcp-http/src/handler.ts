// Core MCP-over-HTTP request handler — framework-agnostic (Node req/res), so the
// same logic runs under the local dev server (src/index.ts) and the Vercel
// serverless function (api/mcp.ts).
//
// Per request:
//   1. read the caller's API key (Authorization: Bearer mosadd_sk_live_…)
//   2. exchange it for a short-lived Supabase session (hub-key-exchange)
//   3. spin up a stateless MCP server + Streamable HTTP transport
//   4. run the request inside that session's AsyncLocalStorage context, so every
//      tool call resolves the CALLER's credentials (never a shared/global env) —
//      this is what makes one process safe to serve many tenants concurrently.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { allTools, createMosaddServer, runWithSupabaseEnv, type SupabaseEnv } from "@mosadd/mcp";
import { installDmReceipts, withDmReceipts } from "./dm-receipts.js";

installDmReceipts(allTools);

const DEFAULT_EXCHANGE =
  "https://rooffhgbxafyjcwmwpsy.supabase.co/functions/v1/hub-key-exchange";

const API_KEY_RE = /^mosadd_sk_live_[a-f0-9]{16,}$/;

function exchangeEndpoint(): string {
  const base = process.env.MOSADD_HUB_URL;
  if (base) return `${base.replace(/\/$/, "")}/hub-key-exchange`;
  return process.env.MOSADD_HUB_EXCHANGE_URL ?? DEFAULT_EXCHANGE;
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, mcp-session-id, mcp-protocol-version",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
}

// The origin this gateway answers on. Used to point an unauthenticated caller at the metadata that
// tells it how to sign in — see WWW_AUTHENTICATE below.
const PUBLIC_ORIGIN = process.env.MOSADD_MCP_ORIGIN ?? "https://mcp.mosadd.com";

// WHAT TURNS A REJECTION INTO A SIGN-IN. Per the MCP authorization spec (and RFC 9728), a 401 from a
// protected resource must name the metadata document describing who can authorize access. Without
// this header a host that supports OAuth has no way to discover our authorization server, so adding
// this URL as a connector fails with a bare 401 and the user sees "couldn't connect" — the exact
// difference between a URL you curl with a key and a connector you can add.
const WWW_AUTHENTICATE =
  `Bearer realm="mosadd", resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`;

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

// ── Per-key session cache (LINEAR-4813) ─────────────────────────────────────
// The handler used to exchange the API key for a fresh Supabase session on EVERY
// request — one hub-key-exchange round-trip (and one GoTrue magiclink mint) per
// tool call. The exchanged token lives ~an hour; caching it per key in module
// memory kills that overhead. TTL is deliberately WELL below expires_in so a
// cached token is never handed out near its expiry mid-request. Module state
// survives warm serverless invocations and is empty on a cold start — both fine.
// A revoked key keeps working for at most SESSION_TTL_SAFETY_S after revocation;
// acceptable for a cache this hot, same trade Supabase makes with JWTs.
const SESSION_TTL_SAFETY_S = 300; // refresh 5 min before the token would expire
const MAX_CACHED_SESSIONS = 1000; // hard cap — evict oldest, never grow unbounded

type CachedSession = { env: SupabaseEnv; expiresAtMs: number };
const sessionCache = new Map<string, CachedSession>();

async function exchangeKey(apiKey: string, clientName?: string, mcpSessionId?: string): Promise<SupabaseEnv> {
  const cacheKey = mcpSessionId ? `${apiKey}:${mcpSessionId}` : apiKey;
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) return cached.env;
  sessionCache.delete(cacheKey);

  const res = await fetch(exchangeEndpoint(), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    // client_name (from MCP initialize clientInfo, when this request carries it) lets
    // hub-key-exchange stamp agent_name on its per-exchange mcp_sessions telemetry row.
    // mcp_session_id lets hub-key-exchange stamp mcpSessionId in capabilities telemetry.
    body: JSON.stringify({
      ...(clientName ? { client_name: clientName } : {}),
      ...(mcpSessionId ? { mcp_session_id: mcpSessionId } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? "invalid_key" : `exchange_failed_${res.status}`);
  }
  const d = (await res.json()) as {
    url?: string;
    anon_key?: string;
    access_token?: string;
    expires_in?: number;
    user_id?: string;
  };
  if (!d.url || !d.anon_key || !d.access_token) throw new Error("exchange_incomplete");
  const env: SupabaseEnv = { url: d.url, anonKey: d.anon_key, userJwt: d.access_token };

  const expiresInS = typeof d.expires_in === "number" && d.expires_in > 0 ? d.expires_in : 3600;
  const ttlS = Math.max(60, expiresInS - SESSION_TTL_SAFETY_S); // TTL strictly < expires_in
  if (sessionCache.size >= MAX_CACHED_SESSIONS) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  sessionCache.set(cacheKey, { env, expiresAtMs: Date.now() + ttlS * 1000 });
  return env;
}

/** Best-effort: pull clientInfo.name out of an MCP initialize request body. */
function clientNameFrom(parsedBody: unknown): string | undefined {
  const b = parsedBody as { method?: unknown; params?: { clientInfo?: { name?: unknown } } } | null;
  if (!b || b.method !== "initialize") return undefined;
  const name = b.params?.clientInfo?.name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : undefined;
}

/**
 * Handle one MCP HTTP request. `parsedBody` is the already-parsed JSON-RPC body
 * (the dev server / Vercel function reads + parses it before calling).
 */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
): Promise<void> {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // BARE-HOST LESSON (2026-08-17, the founder's own connector setup). A static public/index.html
  // used to SHADOW the "/" → /api/mcp rewrite (Vercel's filesystem check precedes rewrites), so a
  // connector that saved the bare URL completed OAuth and then POSTed initialize into a static HTML
  // page — invisibly (static hits produce no function logs), surfacing as "no MCP server was found
  // at the provided URL". The static file is gone; this handler now owns the bare host too:
  //   GET  /  (unauthenticated, a human in a browser)  → the landing text, 200
  //   POST /                                            → exactly like /mcp (401→OAuth, then MCP)
  //   GET  /mcp                                         → 401 + WWW-Authenticate (the OAuth trigger)
  // Canonical connector URL stays https://mcp.mosadd.com/mcp — but the bare host must never again
  // be a silent dead end.
  const reqPath = (() => {
    try { return new URL(req.url ?? "/", PUBLIC_ORIGIN).pathname; } catch { return "/"; }
  })();
  if (req.method === "GET" && reqPath === "/") {
    setCors(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      // ⛔ FAVICON = CONNECTOR ICON (founder 2026-08-19: the connector showed an old/default glyph).
      // Claude derives a custom connector's icon from the origin's favicon, and this gateway served
      // none — so it fell back to a stale default. public/favicon.svg|.ico now carry the live mosADD
      // brand mark (copied from mosadd.com), and this <link> points at them. A connector already
      // added may keep its cached icon until it is removed and re-added.
      "<!doctype html><meta charset=utf-8><title>mosADD MCP gateway</title>" +
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="32x32">' +
      "mosADD MCP gateway — add https://mcp.mosadd.com/mcp as a connector and sign in " +
      "(the bare host works too), or POST JSON-RPC with header Authorization: Bearer " +
      "mosadd_sk_live_… (keys: https://mosadd.com/keys)",
    );
    return;
  }

  const authHeader = req.headers["authorization"];
  const apiKey = (typeof authHeader === "string" ? authHeader : "").replace(/^Bearer\s+/i, "").trim();
  if (!API_KEY_RE.test(apiKey)) {
    jsonRpcError(
      res, 401, -32001,
      "Unauthorized — add this server as a connector and sign in, or send Authorization: Bearer mosadd_sk_live_… (keys: https://mosadd.com/keys)",
      { "WWW-Authenticate": WWW_AUTHENTICATE },
    );
    return;
  }

  const mcpSessionId = String(req.headers["mcp-session-id"] ?? "").trim() || undefined;

  let env: SupabaseEnv;
  try {
    env = await exchangeKey(apiKey, clientNameFrom(parsedBody), mcpSessionId);
    // Tożsamość sesji dla bezstanowej bramy: stabilna per KLUCZ API (hash, nigdy goły klucz),
    // identyczna między procesami lambd — więc deklaracja linii (comms_session_attach) przeżywa
    // przełączenia instancji, a strażnik 409 w message-send odróżnia dwie różne bramy/klucze
    // zamiast strzelać fałszywymi odmowami przy każdym routingu. Patrz sessionId() w @mosadd/mcp.
    // ⛔ `Mcp-Session-Id` DOKŁADA SIĘ DO HASZA, GDY KLIENT GO PRZYŚLE — i to jest cała poprawka.
    //
    // Powód, dla którego NIE zmieniam tego na czystą tożsamość per połączenie: powyższy akapit
    // opisuje ŚWIADOMĄ decyzję, nie przeoczenie. Stabilność per KLUCZ jest tym, co pozwala
    // deklaracji linii przeżyć przełączenie instancji lambdy i co chroni strażnik 409 w
    // message-send przed strzelaniem fałszywymi odmowami przy każdym routingu. Zerwanie tego
    // naprawiłoby jeden problem i odtworzyło dwa starsze.
    //
    // ⛔ ALE BEZ ROZRÓŻNIENIA SESJI ARBITER JEST ŚLEPY. `mosadd_gateway_binding_claim` porównuje
    // `session_id` i zgłasza `took_over`, gdy linię odebrała INNA sesja. Dopóki dwie sesje na tym
    // samym kluczu mają IDENTYCZNY `session_id`, ten warunek nie ma jak się zapalić — więc
    // przejęcie podpisu, które kosztowało 30 h awarii, dalej byłoby ciche.
    //
    // Rozwiązanie jest addytywne: nagłówek jest częścią tożsamości TYLKO wtedy, gdy klient
    // naprawdę prowadzi własną sesję MCP i go przysyła. Konektor bezstanowy, który go nie wysyła,
    // dostaje BIT W BIT dotychczasowy klucz — więc nic nie może się zepsuć u tych, którzy działają.
    const ziarno = mcpSessionId ? `${apiKey}|${mcpSessionId}` : apiKey;
    env.sessionKey = `gw:${createHash("sha256").update(ziarno).digest("hex").slice(0, 16)}`;
  } catch (e) {
    const msg = (e as Error).message === "invalid_key" ? "Invalid or revoked API key" : "Key exchange failed";
    // A revoked key must also advertise how to get a new one — this is the path a connector takes
    // after the user revokes it from the keys page and then tries to use it again.
    jsonRpcError(res, 401, -32001, msg, { "WWW-Authenticate": WWW_AUTHENTICATE });
    return;
  }

  // TODO(metering, LINEAR-4813): `public.hub_usage_increment(p_user_id uuid, p_period text,
  // p_messages bigint, p_ptt_minutes bigint)` exists with ZERO callers, and this handler CAN
  // see `parsedBody.method === "tools/call"` cheaply. It is NOT wired here on purpose: the RPC
  // meters MESSAGES and PTT MINUTES against the plan quotas hub-key-exchange returns —
  // incrementing it once per tools/call would burn a user's message allowance on read-only
  // calls (mDM_list_threads, mIRC_read, …), which is metering fraud in the user's disfavor.
  // The correct wiring is inside the SEND-path tool implementations in @mosadd/mcp (or their
  // EFs), where "this call produced N outbound messages / M PTT minutes" is actually known.
  // The exchange already returns user_id for exactly that attribution.

  // ── Per-call OBSERVABILITY (epic 5409; deliberately NOT the quota TODO above) ──
  // One row per tools/call into public.mcp_tool_calls via PostgREST under the caller's own
  // short-lived session: RLS insert-own with `user_id default auth.uid()`, so no id crosses the
  // wire and one tenant can never write another's row. Fire-and-forget — telemetry must never
  // add latency to (or fail) the actual tool call. Read-only listing/initialize is not logged.
  const method = (parsedBody as { method?: unknown } | null)?.method;
  if (method === "tools/call") {
    const tool = String((parsedBody as { params?: { name?: unknown } }).params?.name ?? "unknown");
    void fetch(`${env.url.replace(/\/$/, "")}/rest/v1/mosadd_mcp_tool_calls`, {
      method: "POST",
      headers: {
        apikey: env.anonKey,
        Authorization: `Bearer ${env.userJwt}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ tool }),
    }).catch(() => { /* telemetry only — never surface */ });
  }

  // Stateless: a fresh server + transport per request (no session store), and
  // JSON responses (not SSE) so the gateway works behind any serverless host.
  const server = createMosaddServer({ apiKey, mode: "cloud" });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  setCors(res);
  await server.connect(transport);
  // EVERY tool call dispatched during handleRequest runs with THIS caller's
  // session via AsyncLocalStorage — no global env, safe for concurrent tenants.
  await runWithSupabaseEnv(env, () => withDmReceipts(env, () => transport.handleRequest(req, res, parsedBody)));
}
