import { RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { audioQueue, notificationQueue } from '../../infrastructure/queues';
import { ensure } from '../../shared/errors';
import { id, name, page } from '../../shared/validation';
import { RefreshSession, User } from '../auth/models';
import { Plan, Subscription } from '../billing/models';
import { lockUser } from '../billing/service';
import { License, Song } from '../catalog/models';
import { Device, Download, Playlist } from '../library/models';
import { ListeningEvent } from '../playback/models';
import * as service from './service';
import * as validators from './validators';
export const deletePlaylistsId: RequestHandler = async (req, res) => {
  await Playlist.deleteOne({ _id: id.parse(req.params.id) });
  res.sendStatus(204);
};
export const getUsers: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await User.find()
      .select('name email role disabled createdAt')
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const patchUsersId: RequestHandler = async (req, res) => {
  const user = id.parse(req.params.id);
  const input = z
    .object({ name: name.optional(), disabled: z.boolean().optional() })
    .strict()
    .parse(req.body);
  ensure(!(user === req.auth.userId && input.disabled), 400, 'CANNOT_DISABLE_SELF');
  await mongoose.connection.transaction(async (session) => {
    const row = await User.findByIdAndUpdate(user, { $set: input }, { new: true, session });
    ensure(row, 404, 'NOT_FOUND');
    if (input.disabled) {
      await RefreshSession.updateMany({ user }, { $set: { revokedAt: new Date() } }, { session });
      await Download.updateMany({ user }, { $set: { revokedAt: new Date() } }, { session });
    }
  });
  res.sendStatus(204);
};
export const putLicensesSongId: RequestHandler = async (req, res) => {
  const input = validators.licenseInput.parse({ ...req.body, song: id.parse(req.params.songId) });
  ensure(await Song.exists({ _id: input.song }), 404, 'NOT_FOUND');
  res.json(
    await License.findOneAndUpdate(
      { song: input.song },
      { $set: input },
      { upsert: true, new: true, runValidators: true },
    ),
  );
};
export const getLicenses: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await License.find()
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const postSongsIdPublish: RequestHandler = async (req, res) => {
  const songId = id.parse(req.params.id);
  const { published } = z.object({ published: z.boolean() }).strict().parse(req.body);
  if (published) {
    const song = await Song.findById(songId);
    ensure(song?.processing === 'ready' && song.audio.length === 3, 409, 'AUDIO_NOT_READY');
    const license = await License.findOne({
      song: songId,
      enabled: true,
      streaming: true,
      startsAt: { $lte: new Date() },
      endsAt: { $gt: new Date() },
    });
    ensure(license, 409, 'LICENSE_REQUIRED');
  }
  const row = await Song.findByIdAndUpdate(songId, { $set: { published } }, { new: true });
  ensure(row, 404, 'NOT_FOUND');
  res.json(row);
};
export const postSongsIdUploads: RequestHandler = async (req, res) => {
  ensure(Buffer.isBuffer(req.body) && req.body.length > 0, 400, 'UPLOAD_BODY_REQUIRED');
  const kind = z.enum(['audio', 'cover']).parse(req.header('x-upload-kind'));
  const contentType = z.string().max(100).parse(req.header('content-type')?.split(';')[0]);
  res
    .status(202)
    .json(
      await service.createUpload(id.parse(req.params.id), { kind, contentType, data: req.body }),
    );
};
export const postUploadsIdComplete: RequestHandler = async (req, res) =>
  res.status(202).json(await service.completeUpload(id.parse(req.params.id)));
export const getJobsId: RequestHandler = async (req, res) => {
  const job = await audioQueue.getJob(id.parse(req.params.id));
  ensure(job, 404, 'NOT_FOUND');
  res.json({
    id: job.id,
    state: await job.getState(),
    attemptsMade: job.attemptsMade,
    progress: job.progress,
    failed: !!job.failedReason,
  });
};
export const postJobsIdRetry: RequestHandler = async (req, res) => {
  const job = await audioQueue.getJob(id.parse(req.params.id));
  ensure(job, 404, 'NOT_FOUND');
  ensure((await job.getState()) === 'failed', 409, 'JOB_NOT_FAILED');
  await job.retry();
  res.sendStatus(202);
};
export const getSubscriptions: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await Subscription.find()
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const putSubscriptionsUserId: RequestHandler = async (req, res) => {
  const user = id.parse(req.params.userId);
  const input = z
    .object({
      plan: id,
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date(),
      status: z.enum(['active', 'cancelled']),
      externalReference: z.string().max(200).optional(),
    })
    .strict()
    .refine((v) => v.endsAt > v.startsAt)
    .parse(req.body);
  ensure(await Plan.exists({ _id: input.plan, active: true }), 400, 'INVALID_PLAN');
  const result = await mongoose.connection.transaction(async (session) => {
    await lockUser(user, session);
    await Download.updateMany({ user }, { $set: { revokedAt: new Date() } }, { session });
    await Device.updateMany({ user }, { $set: { revokedAt: new Date() } }, { session });
    return Subscription.findOneAndUpdate(
      { user },
      { $set: input },
      { upsert: true, new: true, session },
    );
  });
  res.json(result);
};
export const postNotifications: RequestHandler = async (req, res) => {
  const input = z
    .object({
      user: id,
      title: name,
      body: z.string().min(1).max(2000),
      dedupeKey: z.string().uuid(),
    })
    .strict()
    .parse(req.body);
  ensure(await User.exists({ _id: input.user }), 404, 'NOT_FOUND');
  await notificationQueue.add('notify', input, { jobId: input.dedupeKey });
  res.sendStatus(202);
};
export const getAnalytics: RequestHandler = async (req, res) => {
  const input = z
    .object({ days: z.coerce.number().int().min(1).max(90).default(7) })
    .parse(req.query);
  const since = new Date(Date.now() - input.days * 86400000);
  const rows = await ListeningEvent.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$song',
        events: { $sum: 1 },
        listenedSeconds: { $sum: '$seconds' },
        completions: { $sum: { $cond: [{ $eq: ['$type', 'completion'] }, 1, 0] } },
      },
    },
    { $sort: { listenedSeconds: -1 } },
    { $limit: 100 },
  ]).option({ maxTimeMS: 10000 });
  res.json({ since, data: rows });
};
