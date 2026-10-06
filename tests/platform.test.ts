import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:http';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { Worker } from 'bullmq';
let dir: string;
let mongo: ChildProcess;
let redisProcess: ChildProcess;
let api: Server;
let worker: Worker;
let port: number;
let connections: any;
let queues: any;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn: () => Promise<any>) {
  let error: unknown;
  for (let i = 0; i < 100; i++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await delay(100);
    }
  }
  throw error;
}
before(
  async () => {
    dir = await mkdtemp(join(tmpdir(), 'music-tests-'));
    mongo = spawn(
      'mongod',
      [
        '--dbpath',
        dir,
        '--port',
        '27919',
        '--bind_ip',
        '127.0.0.1',
        '--replSet',
        'music-test',
        '--quiet',
        '--logpath',
        join(dir, 'mongo.log'),
      ],
      { stdio: 'ignore' },
    );
    redisProcess = spawn(
      'redis-server',
      ['--port', '16399', '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
      { stdio: 'ignore' },
    );
    const bootstrap = await eventually(async () => {
      const client = mongoose.createConnection(
        'mongodb://127.0.0.1:27919/admin?directConnection=true',
        { serverSelectionTimeoutMS: 200 },
      );
      try {
        return await client.asPromise();
      } catch (e) {
        await client.close();
        throw e;
      }
    });
    await bootstrap.db!.admin().command({
      replSetInitiate: { _id: 'music-test', members: [{ _id: 0, host: '127.0.0.1:27919' }] },
    });
    await eventually(async () => {
      const hello = await bootstrap.db!.admin().command({ hello: 1 });
      assert.equal(hello.isWritablePrimary, true);
    });
    await bootstrap.close();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      MONGO_URI: 'mongodb://127.0.0.1:27919/music_test?replicaSet=music-test',
      REDIS_URL: 'redis://127.0.0.1:16399',
      BACKGROUND_JOBS_ENABLED: 'true',
      JWT_SECRET: 'integration-test-secret-at-least-32-chars',
      QUEUE_PREFIX: 'music-platform-test',
    });
    connections = await import('../src/infrastructure/connections');
    await Promise.all(Array.from({ length: 8 }, () => connections.connect()));
    queues = await import('../src/infrastructure/queues');
    const { app } = await import('../src/app');
    for (const model of Object.values(mongoose.models)) await model.init();
    const { processAudio } = await import('../src/workers/audio');
    worker = new Worker('audio', processAudio, {
      connection: queues.queueConnection,
      prefix: 'music-platform-test',
    });
    api = app.listen(0, '127.0.0.1');
    await once(api, 'listening');
    port = (api.address() as any).port;
  },
  { timeout: 30000 },
);
after(async () => {
  if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
  if (worker) await worker.close();
  if (queues) await queues.closeQueues();
  if (connections) await connections.disconnect();
  for (const process of [mongo, redisProcess])
    if (process && process.exitCode === null) {
      const stopped = once(process, 'exit');
      process.kill('SIGTERM');
      await stopped;
    }
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function request(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
async function mediaUpload(path: string, data: Buffer, kind: 'audio' | 'cover', token: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': kind === 'audio' ? 'audio/wav' : 'image/png',
      'X-Upload-Kind': kind,
    },
    body: data,
  });
  return { status: response.status, data: await response.json() };
}
test(
  'end-to-end authorization, rotation, media, quotas, ownership and revocation',
  async () => {
    const { User } = await import('../src/modules/auth/models');
    const { Plan, Subscription } = await import('../src/modules/billing/models');
    const { Artist, Song, License } = await import('../src/modules/catalog/models');
    const { Device, Download } = await import('../src/modules/library/models');
    const library = await import('../src/modules/library/service');
    const auth = await import('../src/modules/auth/service');
    assert.equal((await request('GET', '/songs')).status, 401);
    assert.equal(
      (
        await request('POST', '/auth/register', {
          email: 'bad',
          password: 'short',
          name: 'Bad',
          role: 'admin',
        })
      ).status,
      400,
    );
    const registered = await request('POST', '/auth/register', {
      email: 'listener@example.com',
      password: 'strong-password-123',
      name: 'Listener',
    });
    assert.equal(registered.status, 201);
    let token = registered.data.accessToken;
    const user = await User.findOne({ email: 'listener@example.com' });
    assert.ok(user);
    assert.equal((await request('GET', '/admin/users', undefined, token)).status, 403);
    const rotated = await auth.rotate(registered.data.refreshToken);
    await assert.rejects(() => auth.rotate(registered.data.refreshToken), /REFRESH_REUSE/);
    await assert.rejects(() => auth.rotate(rotated.refreshToken), /REFRESH_REUSE/);
    const logged = await request('POST', '/auth/login', {
      email: 'listener@example.com',
      password: 'strong-password-123',
    });
    assert.equal(logged.status, 200);
    token = logged.data.accessToken;
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    const artist = await Artist.create({ name: 'Test Artist' });
    const song = await Song.create({ title: 'Test Song', artist: artist._id, language: 'hi' });
    assert.equal(
      (await request('POST', `/admin/songs/${song._id}/publish`, { published: true }, token))
        .status,
      409,
    );
    const { run } = await import('../src/infrastructure/ffmpeg');
    const source = join(dir, 'test.wav');
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-y',
      source,
    ]);
    const body = await readFile(source);
    const upload = await mediaUpload(`/admin/songs/${song._id}/uploads`, body, 'audio', token);
    assert.equal(upload.status, 202);
    await eventually(async () => {
      const job = await queues.audioQueue.getJob(upload.data.uploadId);
      const state = await job.getState();
      assert.equal(state, 'completed', job.failedReason);
    });
    const processed = await Song.findById(song._id);
    assert.equal(processed!.audio.length, 3);
    assert.ok(processed!.duration! > 0);
    assert.equal(processed!.published, false);
    assert.equal((await Song.findById(song._id))!.processingUpload, null);
    const coverFile = join(dir, 'test.png');
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-y',
      coverFile,
    ]);
    const coverBytes = await readFile(coverFile);
    const coverUpload = await mediaUpload(
      `/admin/songs/${song._id}/uploads`,
      coverBytes,
      'cover',
      token,
    );
    assert.equal(coverUpload.status, 202);
    await eventually(async () => {
      const job = await queues.audioQueue.getJob(coverUpload.data.uploadId);
      assert.equal(await job.getState(), 'completed', job.failedReason);
    });
    await License.create({
      song: song._id,
      holder: 'Test rights holder',
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 86400000),
      streaming: true,
      offline: true,
    });
    assert.equal(
      (await request('POST', `/admin/songs/${song._id}/publish`, { published: true }, token))
        .status,
      200,
    );
    const publicSong = await request('GET', `/songs/${song._id}`, undefined, token);
    assert.equal(publicSong.data.audio, undefined);
    assert.equal(publicSong.data.sourceFileId, undefined);
    assert.equal(publicSong.data.processingUpload, undefined);
    assert.match(publicSong.data.coverUrl, /^\/api\/v1\/media\/covers\//);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}${publicSong.data.coverUrl}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    assert.deepEqual(publicSong.data.qualities, ['64', '128', '192']);
    const streamed = await request('POST', `/streaming/${song._id}`, { quality: '64' }, token);
    assert.equal(streamed.status, 200);
    assert.match(streamed.data.url, /^\/api\/v1\/streaming\/sessions\//);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}${streamed.data.url}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (await request('POST', `/streaming/${song._id}`, { quality: '192' }, token)).status,
      403,
    );
    const event = await request(
      'POST',
      `/streaming/sessions/${streamed.data.sessionId}/events`,
      { sequence: 1, type: 'pause', seconds: 60 },
      token,
    );
    assert.equal(event.status, 201);
    assert.ok(event.data.seconds < 60);
    const duplicate = await request(
      'POST',
      `/streaming/sessions/${streamed.data.sessionId}/events`,
      { sequence: 1, type: 'pause', seconds: 60 },
      token,
    );
    assert.equal(duplicate.data._id, event.data._id);
    assert.equal(
      (
        await request(
          'POST',
          `/streaming/sessions/${streamed.data.sessionId}/events`,
          { sequence: 3, type: 'play', seconds: 0 },
          token,
        )
      ).status,
      409,
    );
    const plan = await Plan.create({
      name: 'Test',
      slug: 'test',
      priceMinor: 100,
      offlineLimit: 1,
      deviceLimit: 1,
      offlineDays: 30,
      qualities: ['64', '128', '192'],
    });
    await Subscription.create({
      user: user._id,
      plan: plan._id,
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600000),
    });
    assert.equal(
      (await request('PATCH', `/admin/plans/${plan._id}`, { offlineLimit: 10 }, token)).status,
      409,
    );
    const deviceResults = await Promise.allSettled([
      library.registerDevice(String(user._id), {
        installationId: '00000000-0000-4000-8000-000000000001',
        name: 'One',
        platform: 'android',
      }),
      library.registerDevice(String(user._id), {
        installationId: '00000000-0000-4000-8000-000000000002',
        name: 'Two',
        platform: 'ios',
      }),
    ]);
    assert.equal(deviceResults.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await Device.countDocuments({ user: user._id, revokedAt: null }), 1);
    const device = await Device.findOne({ user: user._id, revokedAt: null });
    const song2 = await Song.create({
      title: 'Other',
      artist: artist._id,
      language: 'hi',
      published: true,
      processing: 'ready',
      audio: [{ quality: '64', fileId: processed!.audio[0].fileId, mime: 'audio/mpeg' }],
    });
    await License.create({
      song: song2._id,
      holder: 'Test',
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 86400000),
      streaming: true,
      offline: true,
    });
    const grants = await Promise.allSettled(
      [song, song2].map((s) =>
        library.grantDownload(String(user._id), {
          song: String(s._id),
          device: String(device!._id),
          quality: '64',
        }),
      ),
    );
    assert.equal(grants.filter((r) => r.status === 'fulfilled').length, 1);
    const grant = await Download.findOne({ user: user._id });
    assert.ok(grant);
    assert.ok(grant.expiresAt!.getTime() <= Date.now() + 3600000);
    const download = await library.downloadUrl(
      String(user._id),
      String(grant._id),
      String(device!._id),
    );
    assert.match(download.url, /^\/api\/v1\/downloads\//);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}${download.url}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    const stranger = await User.create({
      email: 'other@example.com',
      name: 'Other',
      passwordHash: 'unused',
    });
    await assert.rejects(
      () => library.downloadUrl(String(stranger._id), String(grant._id), String(device!._id)),
      /ENTITLEMENT/,
    );
    const strangerToken = (await auth.issue(String(stranger._id))).accessToken;
    const playlist = await request('POST', '/playlists', { name: 'Private' }, token);
    assert.equal(
      (await request('GET', `/playlists/${playlist.data._id}`, undefined, strangerToken)).status,
      404,
    );
    await library.revokeDevice(String(user._id), String(device!._id));
    await assert.rejects(
      () => library.downloadUrl(String(user._id), String(grant._id), String(device!._id)),
      /ENTITLEMENT/,
    );
    await License.updateOne({ song: song._id }, { $set: { territories: ['IN'] } });
    assert.equal((await request('POST', `/streaming/${song._id}`, {}, token)).status, 403);
    await User.updateOne({ _id: user._id }, { $set: { disabled: true } });
    assert.equal((await request('GET', '/users/me', undefined, token)).status, 401);
  },
  { timeout: 30000 },
);
test('paused listening cannot inflate analytics', async () => {
  const { allowedListeningDelta } = await import('../src/modules/playback/service');
  assert.equal(allowedListeningDelta('pause', 60, 60), 0);
  assert.equal(allowedListeningDelta('play', 5, 60), 5);
  assert.equal(allowedListeningDelta('play', 500, 60), 60);
});
