import { test } from "node:test";
import assert from "node:assert/strict";
import { installDmReceipts, readableMessageIds, withDmReceipts } from "./dm-receipts.js";
import type { MosaddTool, MosaddToolContext, SupabaseEnv } from "@mosadd/mcp";

const env = (id: string): SupabaseEnv => ({ url: 'https://example.invalid', anonKey: 'public', userJwt: id });
const context = (id = 'self') => ({ providers: { dm: { selfId: async () => id } }, log: () => {} }) as unknown as MosaddToolContext;
const message = (id: string, timestamp: string, text = id, thread_id = 'dm:peer:self') => ({ id, timestamp, text, thread_id, sender_identity_id: 'peer' });
const makeTool = (name: string, handler: MosaddTool['handler']) => ({ name, handler, description: 'Test', annotations: { readOnlyHint: true } }) as MosaddTool;

test('failed decryption blocks newer receipts in that thread, not other threads or older decoded texts', () => {
  const rows = [message('new', '2026-09-11T04:00:00.123999+00:00'), message('bad', '2026-09-11T04:00:00.123456+00:00', '<undecryptable>'),
    message('old', '2026-09-11T04:00:00.123455+00:00'), message('other', '2026-09-11T04:01:00.000000+00:00', 'ok', 'dm:peer:self:other')];
  assert.deepEqual(readableMessageIds(rows, 'self'), ['old', 'other']);
  assert.deepEqual(readableMessageIds([{ ...rows[1], sender_identity_id: 'self' }, rows[0]], 'self'), ['new']);
});

test('hosted read awaits the receipt; installation is idempotent and annotation is honest', async () => {
  const oldFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), body: JSON.parse(String(opts?.body)) }); return Response.json({ ok: true, threads: 1 }); };
  try {
    const t = makeTool('mDM_list', async () => ({ messages: [message('in', '2026-09-11T00:00:00Z')] }));
    installDmReceipts([t]); installDmReceipts([t]);
    const result = await withDmReceipts(env('A'), () => t.handler({}, context())) as Record<string, unknown>;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { p_reader_identity_id: 'self', p_message_ids: ['in'] });
    assert.deepEqual(result.read_receipt, { ok: true, threads: 1 });
    assert.equal(t.annotations?.readOnlyHint, false);
  } finally { globalThis.fetch = oldFetch; }
});

test('equal timestamps and timezone spellings cannot move a cursor past an unread message', () => {
  const rows = [message('same', '2026-09-11T04:00:00.123456Z'),
    message('bad', '2026-09-11T05:00:00.123456+01:00', '<undecryptable>'),
    message('old', '2026-09-11T04:00:00.123455Z')];
  assert.deepEqual(readableMessageIds(rows, 'self'), ['old']);
});

test('failed send produces no receipt; receipt failure preserves successful send ID', async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }); };
  try {
    const failed = makeTool('mDM_send', async () => { throw new Error('transport failed'); });
    const sent = makeTool('mDM_send', async () => ({ message_id: 'saved-id' }));
    installDmReceipts([failed, sent]);
    await assert.rejects(withDmReceipts(env('A'), () => failed.handler({}, context())), /transport failed/);
    assert.equal(calls, 0);
    const result = await withDmReceipts(env('A'), () => sent.handler({}, context())) as Record<string, unknown>;
    assert.equal(calls, 1); assert.equal(result.message_id, 'saved-id');
    assert.match(String(result.receipt_warning), /Do not resend/);
    assert.equal(result.isError, undefined);
  } finally { globalThis.fetch = oldFetch; }
});

test('simultaneous requests retain their own credentials and readers', async () => {
  const oldFetch = globalThis.fetch;
  const calls: Array<{ auth: string; id: string }> = [];
  globalThis.fetch = async (_url, opts) => {
    calls.push({ auth: new Headers(opts?.headers).get('Authorization')!, id: JSON.parse(String(opts?.body)).p_reader_identity_id });
    return Response.json({ ok: true });
  };
  try {
    const t = makeTool('mDM_list', async () => { await new Promise(r => setTimeout(r, 5)); return { messages: [message('in', '2026-09-11T00:00:00Z')] }; });
    installDmReceipts([t]);
    await Promise.all(['A', 'B'].map(id => withDmReceipts(env(id), () => t.handler({}, context(id)))));
    assert.deepEqual(calls.sort((a, b) => a.id.localeCompare(b.id)), [{ auth: 'Bearer A', id: 'A' }, { auth: 'Bearer B', id: 'B' }]);
  } finally { globalThis.fetch = oldFetch; }
});

test('empty inbox and non-hosted calls write nothing', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network'); };
  try {
    const empty = makeTool('mDM_list', async () => ({ messages: [] }));
    const local = makeTool('mDM_send', async () => ({ message_id: 'local' }));
    installDmReceipts([empty, local]);
    assert.deepEqual(await withDmReceipts(env('A'), () => empty.handler({}, context())), { messages: [], read_receipt: { ok: true, threads: 0 } });
    assert.deepEqual(await local.handler({}, context()), { message_id: 'local' });
  } finally { globalThis.fetch = oldFetch; }
});
