import { AsyncLocalStorage } from "node:async_hooks";
import type { MosaddTool, SupabaseEnv } from "@mosadd/mcp";

// The hosted gateway owns these network side effects. Decorate the public tool registry once;
// never capture a tenant's JWT in it. The separate ALS follows the same lifetime as the MCP ALS.
const receiptEnv = new AsyncLocalStorage<SupabaseEnv>();
const installed = new WeakSet<MosaddTool>();
export const withDmReceipts = <T>(env: SupabaseEnv, run: () => T): T => receiptEnv.run(env, run);

type ReadMessage = { id: string; sender_identity_id: string; thread_id: string; timestamp: string; text: string };

export function readableMessageIds(messages: ReadMessage[], selfId: string): string[] {
  // A thread cursor cannot represent holes. A failed decryption blocks receipts at and after
  // that message, even when a newer message decrypted successfully. Compare microseconds too.
  const micros = (timestamp: string) => {
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) throw new Error('Invalid message timestamp');
    const fraction = (timestamp.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(0, 6);
    return BigInt(Math.floor(ms / 1000)) * 1_000_000n + BigInt(fraction);
  };
  const inbound = messages.filter(m => m.sender_identity_id !== selfId).map(m => ({ ...m, at: micros(m.timestamp) }));
  const blockedAt = new Map<string, bigint>();
  for (const m of inbound) {
    if (m.text !== '<undecryptable>' && typeof m.text === 'string') continue;
    const before = blockedAt.get(m.thread_id);
    if (before === undefined || m.at < before) blockedAt.set(m.thread_id, m.at);
  }
  return inbound.filter(m => !blockedAt.has(m.thread_id) || m.at < blockedAt.get(m.thread_id)!)
    .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).map(m => m.id);
}

async function rpc(env: SupabaseEnv, name: string, args: object): Promise<unknown> {
  const res = await fetch(`${env.url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: env.anonKey, Authorization: `Bearer ${env.userJwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(4000),
  });
  // Do not log response bodies or request headers; they can contain tenant data.
  if (!res.ok) throw new Error(`receipt_http_${res.status}`);
  return res.json();
}

export function installDmReceipts(tools: MosaddTool[]): void {
  for (const tool of tools) {
    if (installed.has(tool) || !["mDM_list", "mDM_send", "mDM_send_unencrypted"].includes(tool.name)) continue;
    installed.add(tool);
    if (tool.name === "mDM_list") {
      tool.annotations = { ...tool.annotations, readOnlyHint: false, destructiveHint: false, idempotentHint: true };
      tool.description += " Successfully decoded incoming text is marked read, respecting receipt privacy; failed decryption never advances the read pointer past that message.";
    }
    const original = tool.handler;
    tool.handler = async (input, ctx) => {
      const result = await original(input, ctx); // Failure must never become a read or reply receipt.
      const env = receiptEnv.getStore();
      if (!env?.userJwt || !result || typeof result !== "object") return result;
      const value = result as Record<string, unknown>;
      try {
        let receipt: unknown;
        if (tool.name === "mDM_list" && Array.isArray(value.messages)) {
          const selfId = await ctx.providers.dm.selfId();
          const ids = readableMessageIds(value.messages as ReadMessage[], selfId);
          if (!ids.length) return { ...value, read_receipt: { ok: true, threads: 0 } };
          receipt = await rpc(env, "mosadd_mcp_dm_read", { p_reader_identity_id: selfId, p_message_ids: ids });
        } else if (typeof value.message_id === "string") {
          receipt = await rpc(env, "mosadd_mcp_dm_reply", { p_message_id: value.message_id });
        } else return result;
        return { ...value, [tool.name === "mDM_list" ? "read_receipt" : "reply_receipt"]: receipt };
      } catch {
        ctx.log("warn", "DM delivered/read but receipt was not confirmed", { tool: tool.name });
        // Preserve successful send IDs. Returning isError would tempt clients to resend the DM.
        return { ...value, receipt_warning: "Message operation succeeded; its receipt was not confirmed. Do not resend the message to retry the receipt." };
      }
    };
  }
}
