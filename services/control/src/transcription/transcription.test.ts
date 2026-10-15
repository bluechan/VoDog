import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import Fastify, {type FastifyRequest} from 'fastify';
import pg from 'pg';
import {PostgresTranscriptJobRepository} from './repository.js';
import {registerTranscriptionRoutes} from './routes.js';
import {freezeRecordingManifest, TranscriptionWorker} from './worker.js';
import {createOpenAICompatibleTranscriptionProvider, degenerateTranscript} from './provider.js';
import {canonicalWav} from './wav-chunks.js';
import {mixTracks} from './mix.js';
import {attributeSegments} from './attribution.js';
import type {PixelRecordingDescriptor} from '../recording-archive.js';
import {dropScratchDatabase} from '../../test/scratch-database.js';

const {Pool} = pg;
const databaseName = `vodog_transcription_test_${process.pid}_${Date.now()}`;
const admin = new Pool({connectionString: 'postgresql:///postgres', max: 1});
let db: pg.Pool;

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('PostgreSQL transcription repository, worker, and owner routes', async (t) => {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  db = new Pool({connectionString: `postgresql:///${databaseName}`, max: 6});
  t.after(async () => {
    await db.end();
    await dropScratchDatabase(admin, databaseName);
    await admin.end();
  });
  await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));

  const owner1 = (await db.query(`INSERT INTO users(email,password_hash) VALUES('transcript-one@example.test','x') RETURNING id`)).rows[0].id;
  const owner2 = (await db.query(`INSERT INTO users(email,password_hash) VALUES('transcript-two@example.test','x') RETURNING id`)).rows[0].id;
  const gateway = (await db.query(`INSERT INTO gateways(name) VALUES('transcript-test') RETURNING id`)).rows[0].id;
  const sim = (await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label) VALUES($1,0,$2,'SIM 1') RETURNING id`, [gateway, owner1])).rows[0].id;
  const makeCall = async (ownerId = owner1, startedAt = new Date()) => (await db.query(
    `INSERT INTO call_records(gateway_id,sim_id,snapshot_owner_id,direction,state,generation,mode_snapshot,started_at,ended_at,recording_status)
     VALUES($1,$2,$3,'incoming','ended',1,'normal',$4,$4,'complete') RETURNING id`, [gateway, sim, ownerId, startedAt])).rows[0].id as string;

  const remote = Buffer.from('OggS remote test'.padEnd(256, '.'));
  const caller = Buffer.from('OggS caller test'.padEnd(256, '.'));
  const timeline = Buffer.from('{}\n');
  const buildManifest = (callId: string) => ({
    version: 1, callId, finalizedAt: new Date().toISOString(), complete: true,
    artifacts: [
      {name: 'remote_original.ogg', bytes: remote.length, sha256: sha(remote)},
      {name: 'caller_original.ogg', bytes: caller.length, sha256: sha(caller)},
      {name: 'timeline.jsonl', bytes: timeline.length, sha256: sha(timeline)},
    ],
  });

  await t.test('enqueue is idempotent and only one concurrent claimant wins', async () => {
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const disabledReads: unknown[] = [];
    const disabled = new TranscriptionWorker(repository, {
      reader: {readTrack: async (input) => { disabledReads.push(input); return remote; }},
      provider: {transcribe: async () => { throw new Error('disabled worker invoked provider'); }},
    });
    assert.equal(await disabled.tickOnce(), 'disabled');
    assert.equal(disabledReads.length, 0);

    const worker = new TranscriptionWorker(repository, {reader: {readTrack: async () => remote}});
    const frozenManifest = buildManifest(callId);
    const first = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: frozenManifest});
    const duplicate = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: frozenManifest});
    assert.equal(first.id, duplicate.id);
    await assert.rejects(worker.enqueueCall({callId, snapshotOwnerId: owner2, manifest: frozenManifest}), /OWNER_MISMATCH/);
    const [a, b] = await Promise.all([repository.claim({leaseMs: 10_000}), repository.claim({leaseMs: 10_000})]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  await t.test('expired lease cannot overwrite a replacement worker result or failure', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const worker = new TranscriptionWorker(repository, {reader: {readTrack: async () => remote}});
    const queued = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    const stale = (await repository.claim({leaseMs: 10_000}))!;
    await db.query(`UPDATE transcript_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [queued.id]);
    const current = (await repository.claim({leaseMs: 10_000}))!;
    assert.notEqual(stale.leaseToken, current.leaseToken);
    assert.equal(await repository.renewLease({jobId: queued.id, leaseToken: stale.leaseToken!, leaseMs: 10_000}), false);
    assert.equal(await repository.renewLease({jobId: queued.id, leaseToken: current.leaseToken!, leaseMs: 10_000}), true);
    assert.equal(await repository.complete({jobId: queued.id, leaseToken: stale.leaseToken!, result: {stale: true}}), false);
    assert.equal(await repository.fail({jobId: queued.id, leaseToken: stale.leaseToken!, terminal: true, nextAttemptAt: null, errorCode: 'STALE', errorMessage: 'stale'}), false);
    assert.equal(await repository.complete({jobId: queued.id, leaseToken: current.leaseToken!, result: {current: true}}), true);
    assert.deepEqual((await repository.get(queued.id))!.result, {current: true});
  });

  await t.test('enabled worker verifies frozen bytes and stores real provider metadata', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    const reads: any[] = [];
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => { reads.push(request); return request.track === 'remote_original' ? remote : caller; }},
      provider: {
        transcribe: async (_bytes, context) => ({text: context.track === 'remote_original' ? '客户内容' : '坐席内容', provider: 'local-fake', model: 'test-model', version: 'v1'}),
        classify: async () => ({
          classification: 'not_advertising', summary: '真实分类器摘要', actionItems: ['回电'],
          provider: 'openai-compatible', model: 'report-model', version: 'report-model-v1', enrichmentError: null,
        }),
      },
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    assert.equal(await worker.tickOnce(), 'succeeded');
    const stored = (await repository.get(job.id))!;
    assert.equal((stored.result as any).providers[0].version, 'v1');
    assert.equal((stored.result as any).summary, '真实分类器摘要');
    assert.deepEqual((stored.result as any).enrichment, {
      provider: 'openai-compatible', model: 'report-model', version: 'report-model-v1', error: null,
    });
    assert.equal(reads.length, 2);
    assert.ok(reads.every((read) => read.snapshotOwnerId === owner1 && read.mediaType === 'audio/ogg'));
  });

  await t.test('classification failure preserves successful ASR without retranscription', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    let transcriptions = 0;
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {
        transcribe: async (_bytes, context) => { transcriptions++; return {text: context.track, provider: 'local-fake', model: 'asr-model'}; },
        classify: async () => ({
          classification: 'unknown', summary: null, actionItems: [],
          provider: 'openai-compatible', model: 'report-model', version: null,
          enrichmentError: {code: 'CLASSIFIER_HTTP_ERROR', message: 'Classifier HTTP 503'},
        }),
      },
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    assert.equal(await worker.tickOnce(), 'succeeded');
    assert.equal(transcriptions, 2);
    const stored = (await repository.get(job.id))!;
    assert.equal((stored.result as any).advertisingClassification, 'unknown');
    assert.equal((stored.result as any).summary, null);
    assert.deepEqual((stored.result as any).actionItems, []);
    assert.deepEqual((stored.result as any).enrichment, {
      provider: 'openai-compatible', model: 'report-model', version: null,
      error: {code: 'CLASSIFIER_HTTP_ERROR', message: 'Classifier HTTP 503'},
    });
    assert.equal(await worker.tickOnce(), 'idle');
    assert.equal(transcriptions, 2);
  });

  await t.test('20 MiB manifest limit is enforced before Reader I/O', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const oversized = buildManifest(callId);
    oversized.artifacts[0] = {name: 'remote_original.ogg', bytes: 20 * 1024 * 1024 + 1, sha256: 'a'.repeat(64)};
    let reads = 0, providerCalls = 0;
    const worker = new TranscriptionWorker(repository, {
      enabled: true, reader: {readTrack: async () => { reads++; return remote; }},
      provider: {transcribe: async () => { providerCalls++; return {text: 'unexpected'}; }},
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: oversized});
    assert.equal(await worker.tickOnce(), 'failed');
    assert.equal(reads, 0); assert.equal(providerCalls, 0);
    assert.equal((await repository.get(job.id))!.errorCode, 'RECORDING_TOO_LARGE');
  });

  await t.test('provider timeout aborts, releases to retry, and persisted errors stay bounded', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    let aborted = false;
    const worker = new TranscriptionWorker(repository, {
      enabled: true, providerTimeoutMs: 10, leaseGraceMs: 100,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {transcribe: async (_bytes, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => { aborted = true; reject(new Error('x'.repeat(2_000))); }, {once: true});
      })},
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    assert.equal(await worker.tickOnce(), 'retry');
    assert.equal(aborted, true);
    const stored = (await repository.get(job.id))!;
    assert.equal(stored.errorCode, 'OPERATION_TIMEOUT');
    assert.ok((stored.errorMessage?.length ?? 0) <= 500);
    await db.query('UPDATE transcript_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1', [job.id]);
    const retryLease = (await repository.claim({leaseMs: 10_000}))!;
    assert.equal(await repository.fail({jobId: job.id, leaseToken: retryLease.leaseToken!, terminal: true, nextAttemptAt: null, errorCode: 'PROVIDER_ERROR', errorMessage: 'x'.repeat(2_000)}), true);
    assert.equal((await repository.get(job.id))!.errorMessage?.length, 500);
  });

  await t.test('S23 决策 6: a deferred rate limit hands the attempt back to the job', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    const job = await repository.enqueue({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId), manifestFingerprint: 'c'.repeat(64)});
    const limited = (await repository.claim({leaseMs: 10_000}))!;
    assert.equal(limited.attempts, 1);
    const nextAttemptAt = new Date(Date.now() + 90_000);
    assert.equal(await repository.fail({jobId: job.id, leaseToken: limited.leaseToken!, terminal: false, nextAttemptAt,
      errorCode: 'PROVIDER_RATE_LIMITED', errorMessage: 'Transcription provider HTTP 429', countAttempt: false}), true);
    const deferred = (await repository.get(job.id))!;
    assert.equal(deferred.state, 'retry');
    assert.equal(deferred.attempts, 0);
    assert.equal(deferred.nextAttemptAt.toISOString(), nextAttemptAt.toISOString());
    // A real failure on the next claim still spends its attempt.
    await db.query('UPDATE transcript_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1', [job.id]);
    const real = (await repository.claim({leaseMs: 10_000}))!;
    assert.equal(real.attempts, 1);
    assert.equal(await repository.fail({jobId: job.id, leaseToken: real.leaseToken!, terminal: false, nextAttemptAt,
      errorCode: 'PROVIDER_HTTP_ERROR', errorMessage: 'Transcription provider HTTP 503'}), true);
    assert.equal((await repository.get(job.id))!.attempts, 1);
  });

  await t.test('runtime cancellation aborts the current provider operation and safely requeues', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall();
    let providerAborted = false;
    let providerStarted!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const worker = new TranscriptionWorker(repository, {
      enabled: true, providerTimeoutMs: 10_000,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {transcribe: async (_bytes, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => { providerAborted = true; reject(new Error('runtime stopped')); }, {once: true});
        providerStarted();
      })},
    });
    await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    const controller = new AbortController();
    const running = worker.tickOnce(controller.signal);
    // Cancel the active provider, not the preceding database claim on a busy host.
    await Promise.race([started, running.then(() => { throw new Error('worker ended before provider started'); })]);
    controller.abort();
    assert.equal(await running, 'retry');
    assert.equal(providerAborted, true);
  });

  await t.test('transcript and report routes enforce immutable owner and reuse the voice calendar function', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const reportCallId = await makeCall(owner1, new Date());
    const reportWorker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => request.track === 'remote_original' ? remote : caller},
      provider: {
        transcribe: async () => ({text: '报告内容', provider: 'local-fake', version: 'v1'}),
        classify: async () => ({classification: 'not_advertising', summary: '真实分类器摘要', actionItems: ['回电']}),
      },
    });
    await reportWorker.enqueueCall({callId: reportCallId, snapshotOwnerId: owner1, manifest: buildManifest(reportCallId)});
    assert.equal(await reportWorker.tickOnce(), 'succeeded');
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof RouteError) return reply.code(error.status).send({error: {code: error.code, message: error.message}});
      return reply.send(error);
    });
    const voiceModuleUrl = new URL('../../../voice/report-window.mjs', import.meta.url).href;
    const voice = await import(voiceModuleUrl) as {reportWindow(input: any): any};
    registerTranscriptionRoutes(app, db, {
      requireUser: (request: FastifyRequest) => {
        const userId = request.headers['x-test-user'];
        if (typeof userId !== 'string') throw new RouteError(401, 'UNAUTHENTICATED', 'Authentication required');
        return {userId};
      },
      mutationOrigin: () => { throw new Error('GET routes must not invoke mutationOrigin'); },
      fail: (status, code, message, details) => { throw new RouteError(status, code, message, details); },
      reportWindow: voice.reportWindow,
      now: () => new Date(),
    });
    const owned = reportCallId;
    const ownTranscript = await app.inject({method: 'GET', url: `/api/v1/calls/${owned}/transcript`, headers: {'x-test-user': owner1}});
    assert.equal(ownTranscript.statusCode, 200, ownTranscript.body);
    assert.equal(ownTranscript.json().transcript.result.summary, '真实分类器摘要');
    assert.equal(ownTranscript.json().transcript.dialog.timebase, 'end_aligned');
    // S101: `dialog` is synthesized from the same row's result + manifest + call; the stored result stays untouched.
    const fixture = JSON.parse(await readFile(new URL('../../test/fixtures/s101-dialog.json', import.meta.url), 'utf8'));
    const seeded = async (sample: any, answeredBy: string | null, state = 'succeeded') => {
      const callId = await makeCall(owner1, new Date());
      await db.query(`UPDATE call_records SET answered_by_platform=$2,answered_at=$3 WHERE id=$1`, [callId, answeredBy, sample.call.answeredAt]);
      await db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,result,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5='succeeded' THEN now() END)`,
        [callId, owner1, JSON.stringify(sample.manifest), sha(Buffer.from(callId)), state, state === 'succeeded' ? JSON.stringify(sample.result) : null]);
      return (await app.inject({method: 'GET', url: `/api/v1/calls/${callId}/transcript`, headers: {'x-test-user': owner1}})).json().transcript;
    };
    const human = await seeded(fixture.humanCall, 'web');
    assert.deepEqual(human.dialog, fixture.humanCall.expected);
    assert.deepEqual(human.result, fixture.humanCall.result);
    assert.deepEqual((await seeded(fixture.aiCallWithoutRealtime, 'ai')).dialog, fixture.aiCallWithoutRealtime.expected);
    assert.equal((await seeded(fixture.humanCall, 'web', 'queued')).dialog, null);
    // S128: `recording.callerTailActive` in the stored result marks the last AI line of an AI-answered call
    // at read time; a run the owner took over (`owner_joined`) is left alone. The stored result is untouched.
    const cutOff = {...fixture.aiCallRealtime, result: {...fixture.aiCallRealtime.result, recording: {callerTailActive: true}}};
    const seededAi = async (failureCode: string | null) => {
      const callId = await makeCall(owner1, new Date());
      const runId = (await db.query(`INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at,state,failure_code)
        VALUES($1,$2,$3,1,1,'ai',1,1,45,now(),'ended',$4) RETURNING id`, [callId, gateway, owner1, failureCode])).rows[0].id;
      await db.query(`UPDATE call_records SET answered_by_platform='ai',answered_at=$2,ai_run_id=$3 WHERE id=$1`, [callId, cutOff.call.answeredAt, runId]);
      for (const [sequence, line] of cutOff.aiLines.entries()) {
        await db.query(`INSERT INTO ai_run_transcripts(run_id,call_id,role,sequence,text,at) VALUES($1,$2,$3,$4,$5,$6)`, [runId, callId, line.role, sequence, line.text, line.at]);
      }
      await db.query(`INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint,state,result,completed_at)
        VALUES($1,$2,$3,$4,'succeeded',$5,now())`, [callId, owner1, JSON.stringify(cutOff.manifest), sha(Buffer.from(callId)), JSON.stringify(cutOff.result)]);
      return (await app.inject({method: 'GET', url: `/api/v1/calls/${callId}/transcript`, headers: {'x-test-user': owner1}})).json().transcript;
    };
    const marked = await seededAi(null);
    assert.deepEqual(marked.dialog.turns.map((turn: any) => turn.text), ['您好，这里是王总的助理，请问哪位？', '你好，我找王总', '好的，请问您贵姓？（未播完）']);
    assert.deepEqual(marked.result, cutOff.result);
    assert.deepEqual((await seededAi('owner_joined')).dialog, fixture.aiCallRealtime.expected);
    const crossOwner = await app.inject({method: 'GET', url: `/api/v1/calls/${owned}/transcript`, headers: {'x-test-user': owner2}});
    assert.equal(crossOwner.statusCode, 404, crossOwner.body);
    const report = await app.inject({method: 'GET', url: '/api/v1/reports/calls?period=7d&timeZone=America%2FNew_York', headers: {'x-test-user': owner1}});
    assert.equal(report.statusCode, 200, report.body);
    assert.equal(report.json().items.some((item: any) => item.callId === owned), true);
    const otherReport = await app.inject({method: 'GET', url: '/api/v1/reports/calls?period=7d&timeZone=America%2FNew_York', headers: {'x-test-user': owner2}});
    assert.deepEqual(otherReport.json().items, []);
    await app.close();
  });
  await t.test('S100: the worker trusts the reader\'s SHA-256 check and never hashes track bytes a second time', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    // Same length, different bytes: only a second worker-side hash could reject this.
    const sameLength = (bytes: Buffer) => Buffer.from(bytes.toString('latin1').replace('test', 'TEST'), 'latin1');
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async (request) => sameLength(request.track === 'remote_original' ? remote : caller)},
      provider: {transcribe: async () => ({text: '内容', provider: 'local-fake'}), classify: async () => ({classification: 'not_advertising'})},
    });
    await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: buildManifest(callId)});
    assert.equal(await worker.tickOnce(), 'succeeded');
  });
  await t.test('an empty recording falls back to the realtime AI transcript instead of the provider', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    const header = Buffer.alloc(95); // a bare Ogg page header: the media node saw no RTP at all
    const emptyManifest = {
      version: 1, callId, finalizedAt: new Date().toISOString(), complete: false,
      artifacts: [
        {name: 'remote_original.ogg', bytes: header.length, sha256: sha(header)},
        {name: 'caller_original.ogg', bytes: header.length, sha256: sha(header)},
        {name: 'timeline.jsonl', bytes: 0, sha256: sha(Buffer.alloc(0))},
      ],
    };
    let transcriptions = 0, classifiedText = '';
    const worker = new TranscriptionWorker(repository, {
      enabled: true,
      reader: {readTrack: async () => { throw new Error('an empty track must never be read'); }},
      provider: {
        transcribe: async () => { transcriptions++; return {text: 'never', provider: 'local-fake'}; },
        classify: async ({text}) => { classifiedText = text; return {
          classification: 'advertising', category: 'insurance', blockRecommended: false, reason: '保险销售',
          summary: '推销重疾险', actionItems: ['考虑屏蔽'], provider: 'openai-compatible', model: 'report-model', version: null, enrichmentError: null}; },
      },
      aiTranscripts: async (input) => {
        assert.equal(input.callId, callId);
        assert.equal(input.snapshotOwnerId, owner1);
        return [{role: 'ai', text: '您好，这里是 AI 助理', at: '2026-09-11T14:00:00.000Z'},
          {role: 'caller', text: '我想了解重疾险', at: '2026-09-11T14:00:05.000Z'}];
      },
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: emptyManifest});
    assert.equal(await worker.tickOnce(), 'succeeded');
    assert.equal(transcriptions, 0, 'a header-only track must never reach the paid provider');
    const result = (await repository.get(job.id))!.result as any;
    assert.equal(result.recording.source, 'ai_realtime_transcript');
    assert.equal(result.recording.complete, false);
    assert.equal(result.text, 'AI: 您好，这里是 AI 助理\n来电: 我想了解重疾险');
    assert.equal(classifiedText, result.text);
    assert.deepEqual(result.segments.map((segment: any) => [segment.track, segment.speaker, segment.text]),
      [['ai_realtime_transcript', 'ai', '您好，这里是 AI 助理'], ['ai_realtime_transcript', 'remote', '我想了解重疾险']]);
    assert.deepEqual(result.providers, []);
    // The server derives the block decision from the category, never from the model's own flag.
    assert.equal(result.blockCategory, 'insurance');
    assert.equal(result.blockRecommended, true);
    assert.equal(result.blockReason, '保险销售');
    assert.equal(result.classifierVersion, 2);
    assert.equal(result.summary, '推销重疾险');
  });

  await t.test('an empty recording with no AI conversation fails terminally with RECORDING_EMPTY', async () => {
    await db.query('TRUNCATE transcript_jobs');
    const repository = new PostgresTranscriptJobRepository(db);
    const callId = await makeCall(owner1, new Date());
    const header = Buffer.alloc(44); // a WAV header with no samples
    let transcriptions = 0;
    const worker = new TranscriptionWorker(repository, {
      enabled: true, maxAttempts: 4,
      reader: {readTrack: async () => header},
      provider: {transcribe: async () => { transcriptions++; return {text: 'never', provider: 'local-fake'}; }},
      aiTranscripts: async () => [],
    });
    const job = await worker.enqueueCall({callId, snapshotOwnerId: owner1, manifest: {
      version: 1, callId, finalizedAt: new Date().toISOString(), complete: true,
      artifacts: [
        {name: 'remote_original.ogg', bytes: 44, sha256: sha(header)},
        {name: 'caller_original.ogg', bytes: 44, sha256: sha(header)},
        {name: 'timeline.jsonl', bytes: 0, sha256: sha(Buffer.alloc(0))},
      ],
    }});
    assert.equal(await worker.tickOnce(), 'failed');
    assert.equal(transcriptions, 0);
    const stored = (await repository.get(job.id))!;
    assert.equal(stored.state, 'failed');
    assert.equal(stored.errorCode, 'RECORDING_EMPTY');
    assert.equal(stored.errorMessage, '录音为空或采集失败');
  });
});

// S102: mixed-track transcription. Pixel WAV fixtures, a fake job repository and the real OpenAI-compatible
// provider behind an injected fetcher, so prompt, parsing, the degenerate guard and the worker run together.
const s102CallId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const s102Owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function s102Track(ms: number, voiced: Array<[number, number]>) {
  const pcm = Buffer.alloc(ms * 32);
  for (const [from, to] of voiced) for (let index = from * 16; index < to * 16; index++) pcm.writeInt16LE(Math.round(8000 * Math.sin(index / 3)), index * 2);
  return canonicalWav(pcm);
}
async function s102Run(remote: Buffer, caller: Buffer, answer: (call: number) => unknown, uplink?: Buffer) {
  const bodies: Record<string, Buffer> = {remote_original: remote, caller_original: caller, ...(uplink ? {caller_uplink: uplink} : {})};
  const manifest: PixelRecordingDescriptor = {
    source: 'pixel', version: 2, archiveId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', callId: s102CallId,
    manifestSha256: 'a'.repeat(64), archiveComplete: true, captureComplete: true,
    startedAt: '2026-10-06T02:00:00.000Z', endedAt: '2026-10-06T02:03:20.000Z',
    tracks: (['remote_original', 'caller_original'] as const).map((track) => ({track, sourceRole: 'original_capture' as const, mediaType: 'audio/wav' as const,
      bytes: bodies[track]!.length, sha256: sha(bodies[track]!), captureComplete: true, gapCount: 0, droppedFrames: 0})),
    timeline: {mediaType: 'application/x-ndjson', bytes: 3, sha256: sha(Buffer.from('{}\n'))},
    // S94 / S128: a v4 archive makes the job read caller_uplink for the caller side.
    ...(uplink ? {archiveVersion: 4 as const, uplinkTracks: [{track: 'caller_uplink' as const, sourceRole: 'uplink_capture' as const, mediaType: 'audio/wav' as const,
      bytes: uplink.length, sha256: sha(uplink), captureComplete: true, gapCount: 0, droppedFrames: 0}]} : {}),
  };
  let result: any, failure: any, claimed = false;
  const prompts: string[] = [], audioBytes: number[] = [], diags: Array<{event: string; fields: any; level: string}> = [];
  const repository = {
    claim: async () => claimed ? null : (claimed = true, {id: 'job', callId: s102CallId, snapshotOwnerId: s102Owner, manifest,
      manifestFingerprint: freezeRecordingManifest(manifest, s102CallId).fingerprint, leaseToken: 'lease', attempts: 1}),
    renewLease: async () => true,
    complete: async (input: any) => { result = input.result; return true; },
    fail: async (input: any) => { failure = input; return true; },
  };
  const provider = createOpenAICompatibleTranscriptionProvider({baseURL: 'https://transcribe.example.test/v1', apiKey: 'test-key', model: 'mix-test',
    fetcher: async (_input, init) => {
      const content = JSON.parse(String(init?.body)).messages[0].content;
      prompts.push(content[0].text);
      audioBytes.push(Buffer.from(content[1].input_audio.data, 'base64').length);
      const reply = answer(prompts.length);
      return Response.json({model: 'mix-test', choices: [{finish_reason: 'stop', message: {role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply)}}]});
    }});
  const worker = new TranscriptionWorker(repository as never, {enabled: true, provider,
    reader: {readTrack: async (request) => bodies[request.track]!},
    diag: (event, fields, target) => { diags.push({event, fields, level: target.level}); }});
  const outcome = await worker.tickOnce();
  return {outcome, result, failure, prompts, audioBytes, diags};
}

test('S102 mix path: one provider call per 3 min chunk, energy speakers, overlapping segments, mix timebase', async () => {
  // Remote 200 s, caller 198 s: end-aligned the caller starts 2 s into the call.
  const remote = s102Track(200_000, [[0, 3000], [6000, 9000]]);
  const caller = s102Track(198_000, [[1000, 3000]]);
  const output = await s102Run(remote, caller, (call) => call === 1 ? {segments: [
    {startMs: 500, endMs: 2500, speaker: 'A', text: '喂，你好'},
    {startMs: 3200, endMs: 4800, speaker: 'B', text: '你好，哪位'},
    {startMs: 6500, endMs: 8500, speaker: 'A', text: '我是物业'},
    // Overlaps the previous segment (ends earlier): no longer collapses the answer into one salvaged segment.
    {startMs: 7000, endMs: 7500, speaker: 'B', text: '嗯'},
  ]} : {segments: []});
  assert.equal(output.outcome, 'succeeded');
  // Chunk 0, its tail re-ask (speech ended 8.5 s into a ~170 s chunk), chunk 1.
  assert.equal(output.prompts.length, 3);
  assert.ok(output.prompts.every((prompt) => /"speaker"/.test(prompt)));
  assert.deepEqual(output.result.segments.map((s: any) => [s.track, s.speaker, s.text, s.startMs, s.endMs, s.attribution]), [
    ['mix', 'remote', '喂，你好', 500, 2500, 'energy'],
    ['mix', 'vodog_user', '你好，哪位', 3200, 4800, 'energy'],
    ['mix', 'remote', '我是物业', 6500, 8500, 'energy'],
    ['mix', 'remote', '嗯', 7000, 7500, 'energy'],
  ]);
  assert.ok(output.result.segments.every((s: any) => s.energyRatio >= 2));
  assert.equal(output.result.text, 'remote: 喂，你好\nvodog_user: 你好，哪位\nremote: 我是物业\nremote: 嗯');
  assert.equal(output.result.recording.timebase, 'mix');
  assert.deepEqual(output.result.recording.mix, {remoteOffsetMs: 0, callerOffsetMs: 2000, durationMs: 200_000, chunkMs: 180_000});
  assert.deepEqual(output.result.recording.tracks.map((t: any) => t.track), ['remote_original', 'caller_original']);
  assert.equal(output.result.recording.complete, true);
  assert.deepEqual(output.result.providers.map((p: any) => [p.track, p.model]), [['mix', 'mix-test']]);
  assert.deepEqual(output.diags.map((d) => [d.event, d.level]),
    [['transcript.chunk_tail', 'info'], ['transcript.chunk', 'info'], ['transcript.chunk_truncated', 'warn'], ['transcript.chunk', 'info']]);
  assert.equal(output.diags[0]!.fields.segments, 0);
  assert.deepEqual(output.diags[1]!.fields.attribution, {energy: 4, label: 0, unknown: 0});
  assert.equal(output.diags[1]!.fields.lastEndMs, 8500);
  assert.equal(output.diags[3]!.fields.segments, 0);
});

test('S102 a degenerate provider reply is PROVIDER_DEGENERATE and retried, never stored', async () => {
  const output = await s102Run(s102Track(10_000, [[0, 3000]]), s102Track(10_000, [[4000, 6000]]),
    () => ({segments: [{startMs: 0, endMs: 9000, text: '屈膝'.repeat(200)}]}));
  assert.equal(output.outcome, 'retry');
  assert.equal(output.result, undefined);
  assert.equal(output.failure.errorCode, 'PROVIDER_DEGENERATE');
  assert.equal(output.failure.terminal, false);
  assert.equal(output.prompts.length, 1);
  assert.equal(degenerateTranscript('你好，请问是张先生吗？是的，我是。好的好的。'), false);
  assert.equal(degenerateTranscript('好的好的'), false);
  assert.equal(degenerateTranscript('这是一段正常的通话内容，'.repeat(3) + '不会被判成退化。', 60_000), false);
  assert.equal(degenerateTranscript('这是一段正常但远超音频时长的通话内容'.repeat(5), 2_000), true);
  // One 3-gram covering ≥ 30 % without ever repeating back-to-back (rule 2 alone).
  assert.equal(degenerateTranscript([...'甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉'].map((c) => `屈膝了${c}`).join('')), true);
  assert.equal(degenerateTranscript('前面正常' + '我们去吧'.repeat(30) + '后面也正常但被稀释得不够多'), true);
});

test('S102 falls back to the per-track path when one track is missing (all-zero)', async () => {
  const output = await s102Run(s102Track(10_000, [[0, 3000]]), s102Track(10_000, []),
    () => ({segments: [{startMs: 0, endMs: 2500, text: '喂，你好'}]}));
  assert.equal(output.outcome, 'succeeded');
  assert.equal(output.prompts.length, 1);
  assert.doesNotMatch(output.prompts[0]!, /"speaker"/);
  assert.deepEqual(output.result.segments, [{track: 'remote_original', speaker: 'remote', text: '喂，你好', startMs: 0, endMs: 2500}]);
  assert.equal(output.result.recording.timebase, 'per_track_capture');
  assert.equal(output.result.recording.mix, undefined);
  assert.equal(output.result.recording.skippedTracks[0].reason, 'all_zero_pcm');
  assert.deepEqual(output.diags, []);
});

test('S102b a subtitle-style mix reply becomes timed segments whose A/B labels reach attribution', async () => {
  const output = await s102Run(s102Track(10_000, [[0, 3000]]), s102Track(10_000, [[4000, 6000]]), () =>
    '00:00.500 --> 00:02.500 [speaker:A] 喂，你好00:04.200 --> 00:05.800 [speaker:B] 你好，哪位\n00:08.000 --> 00:09.000 [speaker:B] 嗯');
  assert.equal(output.outcome, 'succeeded');
  assert.equal(output.prompts.length, 1);
  assert.deepEqual(output.result.segments.map((s: any) => [s.speaker, s.text, s.startMs, s.endMs, s.attribution]), [
    ['remote', '喂，你好', 500, 2500, 'energy'],
    ['vodog_user', '你好，哪位', 4200, 5800, 'energy'],
    // Silence on both tracks: the B label maps to the VoDog user by the certain segments' vote.
    ['vodog_user', '嗯', 8000, 9000, 'label'],
  ]);
  assert.deepEqual(output.diags.map((d) => d.event), ['transcript.chunk']);
});

test('S102b a salvaged mix chunk is re-asked once with the JSON prompt, then reported as transcript.chunk_salvaged', async () => {
  const remote = s102Track(10_000, [[0, 3000]]), caller = s102Track(10_000, [[4000, 6000]]);
  const salvaged = await s102Run(remote, caller, () => '喂，你好，我这边是物业。');
  assert.equal(salvaged.outcome, 'succeeded');
  assert.equal(salvaged.prompts.length, 2);
  assert.ok(salvaged.prompts.every((prompt) => /"speaker"/.test(prompt)));
  assert.deepEqual(salvaged.result.segments.map((s: any) => [s.text, s.startMs, s.endMs]), [['喂，你好，我这边是物业。', 0, 10_000]]);
  assert.deepEqual(salvaged.result.providers[0].attempts.map((a: any) => [a.prompt, a.status]), [['json', 200], ['json', 200]]);
  assert.deepEqual(salvaged.diags.map((d) => [d.event, d.level]), [['transcript.chunk_salvaged', 'info'], ['transcript.chunk', 'info']]);
  assert.deepEqual(salvaged.diags[0]!.fields, {chunk: 0, chunkMs: 10_000});
  // The re-ask that answers properly replaces the salvage; no diag.
  const recovered = await s102Run(remote, caller, (call) => call === 1 ? '喂，你好' :
    {segments: [{startMs: 500, endMs: 2500, speaker: 'A', text: '喂，你好'}, {startMs: 4200, endMs: 5800, speaker: 'B', text: '哪位'}]});
  assert.equal(recovered.prompts.length, 2);
  assert.deepEqual(recovered.result.segments.map((s: any) => [s.speaker, s.startMs]), [['remote', 500], ['vodog_user', 4200]]);
  assert.deepEqual(recovered.diags.map((d) => d.event), ['transcript.chunk']);
});

test('S102b a cut-short chunk re-asks its tail once, shifts tail times and drops the overlap', async () => {
  const remote = s102Track(60_000, [[0, 3000], [40_000, 45_000]]), caller = s102Track(60_000, [[4000, 6000]]);
  const output = await s102Run(remote, caller, (call) => call === 1 ? {segments: [
    {startMs: 500, endMs: 2500, speaker: 'A', text: '喂，你好'},
    {startMs: 4200, endMs: 6000, speaker: 'B', text: '你好，哪位'},
  ]} : {segments: [
    // Tail starts at 4 s: 1 s → 5 s on the chunk, inside what chunk 0 already covered.
    {startMs: 1000, endMs: 2000, speaker: 'A', text: '哪位'},
    {startMs: 36_000, endMs: 41_000, speaker: 'A', text: '我是物业'},
  ]});
  assert.equal(output.outcome, 'succeeded');
  assert.equal(output.prompts.length, 2);
  assert.deepEqual(output.audioBytes, [44 + 60_000 * 32, 44 + 56_000 * 32]);
  assert.deepEqual(output.result.segments.map((s: any) => [s.speaker, s.text, s.startMs, s.endMs]), [
    ['remote', '喂，你好', 500, 2500], ['vodog_user', '你好，哪位', 4200, 6000], ['remote', '我是物业', 40_000, 45_000]]);
  assert.deepEqual(output.diags.map((d) => d.event), ['transcript.chunk_tail', 'transcript.chunk']);
  assert.deepEqual(output.diags[0]!.fields, {chunk: 0, tailMs: 56_000, segments: 1});
  assert.equal(output.diags[1]!.fields.lastEndMs, 45_000);
  // A tail that still leaves > 15 s uncovered keeps the truncation warning; one tail re-ask only.
  const short = await s102Run(remote, caller, (call) => call === 1 ? {segments: [{startMs: 500, endMs: 2500, speaker: 'A', text: '喂，你好'}]} : {segments: []});
  assert.equal(short.prompts.length, 2);
  assert.deepEqual(short.diags.map((d) => d.event), ['transcript.chunk_tail', 'transcript.chunk', 'transcript.chunk_truncated']);
});

test('S102b envelope attribution matches sample-level RMS attribution on the S102 fixtures', () => {
  const remote = s102Track(200_000, [[0, 3000], [6000, 9000]]), caller = s102Track(198_000, [[1000, 3000]]);
  const mix = mixTracks({remote, caller})!;
  const sampleRms = (wav: Buffer, offsetMs: number, startMs: number, endMs: number) => {
    const from = Math.max(0, Math.floor((startMs - offsetMs) * 16)), to = Math.min((wav.length - 44) / 2, Math.ceil((endMs - offsetMs) * 16));
    let sum = 0;
    for (let index = from; index < to; index++) sum += wav.readInt16LE(44 + index * 2) ** 2;
    return to > from ? Math.sqrt(sum / (to - from)) : 0;
  };
  const windows = [[500, 2500], [3200, 4800], [6500, 8500], [7000, 7500], [2000, 2000], [100_000, 101_000], [0, 3000]] as const;
  const viaEnvelope = attributeSegments(windows.map(([startMs, endMs]) => ({startMs, endMs, label: 'A'})), mix.envelopes);
  windows.forEach(([startMs, endMs], index) => {
    const [start, end] = endMs > startMs ? [startMs, endMs] : [startMs - 300, startMs + 300];
    const r = Math.max(1, sampleRms(remote, mix.offsets.remoteMs, start, end)), c = Math.max(1, sampleRms(caller, mix.offsets.callerMs, start, end));
    const certain = Math.max(r, c) / Math.min(r, c) >= 2;
    assert.equal(viaEnvelope[index]!.attribution, certain ? 'energy' : 'label', `window ${index}`);
    if (certain) assert.equal(viaEnvelope[index]!.speaker, r >= c ? 'remote' : 'vodog_user', `window ${index}`);
    assert.ok(Math.abs(viaEnvelope[index]!.energyRatio - Math.round(Math.max(r, c) / Math.min(r, c) * 100) / 100) < 0.05, `window ${index}`);
  });
});

// S128: `recording.callerTailActive` — speech in the final 500 ms of the caller-side track the job read.
// Shapes follow measured archive tail behaviour.
test('S128 worker records whether the caller-side track still carried speech at hangup', async () => {
  const remote = s102Track(6000, [[0, 1000]]), silentRemote = s102Track(6000, []);
  const answer = () => ({segments: [{startMs: 0, endMs: 900, speaker: 'A', text: '喂'}, {startMs: 2100, endMs: 3900, speaker: 'B', text: '您好'}]});
  const tail = async (caller: Buffer, remoteTrack = remote, uplink?: Buffer) => {
    const output = await s102Run(remoteTrack, caller, answer, uplink);
    assert.equal(output.outcome, 'succeeded', JSON.stringify(output.failure));
    return output.result.recording;
  };
  // d2013627 / 681fa2ad uplink: the AI is speaking up to the last sample.
  const cut = await tail(s102Track(6000, [[2000, 6000]]));
  assert.equal(cut.timebase, 'mix');
  assert.equal(cut.callerTailActive, true);
  // 64c951e8 / 7424f3c4: the AI hung up itself — speech, then 0.9 s of digital silence.
  assert.equal((await tail(s102Track(6000, [[2000, 5100]]))).callerTailActive, false);
  // 681fa2ad caller_original: speech until 200 ms before the end, then two quiet 100 ms blocks.
  assert.equal((await tail(s102Track(6000, [[2000, 5800]]))).callerTailActive, true);
  // The same shape with a 40 ms dip inside the last 300 ms of speech (a stop consonant) is still speech.
  assert.equal((await tail(s102Track(6000, [[2000, 5620], [5660, 5800]]))).callerTailActive, true);
  // A lone 100 ms click in the tail after the AI finished is not speech.
  assert.equal((await tail(s102Track(6000, [[2000, 5000], [5700, 5800]]))).callerTailActive, false);
  // d2013627: remote_original is all zero, so there is no mix — the caller track goes alone and is still judged.
  const alone = await tail(s102Track(6000, [[2000, 6000]]), silentRemote);
  assert.equal(alone.timebase, 'per_track_capture');
  assert.deepEqual(alone.skippedTracks.map((skipped: any) => skipped.track), ['remote_original']);
  assert.equal(alone.callerTailActive, true);
  // v4 archive: the job reads caller_uplink, never caller_original (here silent at the end), and judges that.
  const v4 = await tail(s102Track(6000, [[2000, 5000]]), remote, s102Track(6000, [[2000, 6000]]));
  assert.deepEqual(v4.tracks.map((track: any) => track.track), ['remote_original', 'caller_uplink']);
  assert.equal(v4.callerTailActive, true);
  assert.equal((await tail(s102Track(6000, [[2000, 6000]]), remote, s102Track(6000, [[2000, 5000]]))).callerTailActive, false);
  // Caller track unusable (all zero → skipped): the fact is unknown, so the field is absent, not false.
  const unusable = await tail(s102Track(6000, []));
  assert.deepEqual(unusable.skippedTracks.map((skipped: any) => skipped.track), ['caller_original']);
  assert.equal('callerTailActive' in unusable, false);
});
