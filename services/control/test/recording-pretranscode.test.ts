import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pretranscodePixelRecording } from "../src/app.js";
import { errorReason, throttled } from "../src/diag.js";
import { PushWorker } from "../src/push-worker.js";
import type { Db } from "../src/db.js";

function fakeDb(failNonDiag = false) {
  const diags: { event: string; fields: any; callId: unknown; level: unknown }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO diag_events")) {
        diags.push({ event: params[5] as string, fields: JSON.parse(params[6] as string), callId: params[3], level: params[4] });
        return { rows: [], rowCount: 1 };
      }
      if (failNonDiag) throw Object.assign(new Error("boom 13800000000"), { code: "57P01" });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Db;
  return { db, diags };
}
const callId = "11111111-2222-4333-8444-555555555555";
const reader = {
  manifest: async () => ({ tracks: [{ track: "remote_original" }, { track: "caller_original" }] }) as any,
  openTrack: async () => ({ stream: Readable.from([]) }) as any,
};

test("a completed Pixel archive pre-builds each track's mp3 into the route's cache path once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-mp3-"));
  try {
    const { db, diags } = fakeDb();
    const targets: string[] = [];
    const transcode = async (_db: Db, _dir: string, target: string) => { targets.push(target); await writeFile(target, "mp3"); };
    await pretranscodePixelRecording(db, reader, dir, callId, transcode);
    assert.deepEqual(targets, [join(dir, `${callId}-pixel-remote_original.mp3`), join(dir, `${callId}-pixel-caller_original.mp3`)]);
    await pretranscodePixelRecording(db, reader, dir, callId, transcode);
    assert.equal(targets.length, 2, "cached files are skipped");
    assert.equal(diags.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed pre-transcode is one warn diag row and never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-mp3-"));
  try {
    const { db, diags } = fakeDb();
    await pretranscodePixelRecording(db, reader, dir, callId, async () => { throw Object.assign(new Error(`/srv/${callId}.wav`), { code: "FFMPEG_FAILED" }); });
    assert.equal(diags.length, 1);
    assert.deepEqual(diags[0], { event: "recording.pretranscode_failed", fields: { track: "remote_original", reason: "Error:FFMPEG_FAILED" }, callId, level: "warn" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// S100: scripted answers for the yield loop's two questions — is this call's transcript pending, is any call live.
function waitingDb(pending: boolean[], live: boolean[]) {
  const { db, diags } = fakeDb();
  const queries: string[] = [];
  const inner = db.query.bind(db);
  (db as any).query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("transcript_jobs")) { queries.push("transcript"); return { rows: [{ pending: pending.shift() ?? false }], rowCount: 1 }; }
    if (sql.includes("FROM call_records call")) { queries.push("live"); const hit = live.shift() ?? false; return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 }; }
    return inner(sql, params);
  };
  return { db, diags, queries };
}
async function deferred(pending: boolean[], live: boolean[], maxWaitMs: number) {
  const dir = await mkdtemp(join(tmpdir(), "cc-mp3-"));
  try {
    const { db, diags, queries } = waitingDb(pending, live);
    const targets: string[] = [];
    await pretranscodePixelRecording(db, reader, dir, callId, async (_db, _dir, target) => { targets.push(target); await writeFile(target, "mp3"); },
      { maxWaitMs, pollMs: 5, transcriptionEnabled: true });
    return { diags, queries, targets };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("S100: the pre-transcode waits for the call's transcript job, then transcodes", async () => {
  const { diags, queries, targets } = await deferred([true, true, false], [false], 10_000);
  assert.equal(targets.length, 2);
  assert.deepEqual(queries, ["transcript", "transcript", "transcript", "live"]);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].event, "recording.pretranscode_deferred");
  assert.equal(diags[0].fields.reason, "transcript_running");
  assert.ok(diags[0].fields.waitedMs >= 8, String(diags[0].fields.waitedMs));
});

test("S100: the pre-transcode waits while any call is live", async () => {
  const { diags, targets } = await deferred([false, false], [true, false], 10_000);
  assert.equal(targets.length, 2);
  assert.deepEqual(diags.map((d) => [d.event, d.fields.reason]), [["recording.pretranscode_deferred", "live_call"]]);
});

test("S100: the pre-transcode transcodes anyway at the hard cap", async () => {
  const { diags, targets } = await deferred(Array(1000).fill(true), [], 30);
  assert.equal(targets.length, 2);
  assert.deepEqual(diags.map((d) => [d.event, d.fields.reason]), [["recording.pretranscode_deferred", "max_wait"]]);
  assert.ok(diags[0].fields.waitedMs >= 30);
});

test("S100: nothing to wait for (or a 0 cap) transcodes at once with no deferred row", async () => {
  const idle = await deferred([false], [false], 10_000);
  assert.deepEqual([idle.targets.length, idle.diags.length, idle.queries], [2, 0, ["transcript", "live"]]);
  const off = await deferred([true], [true], 0);
  assert.deepEqual([off.targets.length, off.diags.length, off.queries], [2, 0, []]);
});

test("throttled allows one hit per window and errorReason drops the message", () => {
  assert.equal(throttled("t", 60_000, 1_000), true);
  assert.equal(throttled("t", 60_000, 30_000), false);
  assert.equal(throttled("t", 60_000, 61_001), true);
  assert.equal(errorReason(Object.assign(new Error("secret 13800000000"), { code: "E1" })), "Error:E1");
});

test("a failing push worker run files one rate-limited push.worker_error row and still rejects", async () => {
  const { db, diags } = fakeDb(true);
  const worker = new PushWorker(db, { sendIncoming: async () => ({}) } as any);
  await assert.rejects(worker.tick());
  await assert.rejects(worker.tick());
  assert.deepEqual(diags.map((d) => [d.event, d.fields, d.level]), [["push.worker_error", { worker: "apns", reason: "Error:57P01" }, "warn"]]);
});
