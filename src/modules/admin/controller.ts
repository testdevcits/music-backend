import { RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAudioQueue, requireNotificationQueue } from '../../infrastructure/queues';
import { ensure } from '../../shared/errors';
import { id, name, page } from '../../shared/validation';
import { allocateUserPublicId, RefreshSession, User } from '../auth/models';
import { Plan, Subscription } from '../billing/models';
import { lockUser } from '../billing/service';
import { Artist, Category, License, Song, Tag } from '../catalog/models';
import { Device, Download, Playlist } from '../library/models';
import { ListeningEvent } from '../playback/models';
import { cloudinaryAudioUrl, createCloudinaryAudioUploadSignature, hasCloudinaryConfig } from '../../infrastructure/cloudinary';
import { streamFile } from '../../infrastructure/media';
import * as service from './service';
import * as validators from './validators';
export const deletePlaylistsId: RequestHandler = async (req, res) => {
  await Playlist.deleteOne({ _id: id.parse(req.params.id) });
  res.sendStatus(204);
};
export const getUsers: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  const users = await User.find()
    .select('id name email image publicId role disabled createdAt')
    .skip((q.page - 1) * q.limit)
    .limit(q.limit);
  await Promise.all(users.map(async (user: any) => {
    if (user.publicId) return;
    const publicId = await allocateUserPublicId();
    await User.updateOne({ _id: user._id, $or: [{ publicId: { $exists: false } }, { publicId: null }] }, { $set: { publicId } });
    user.publicId = (await User.findById(user._id).select('publicId').lean() as any)?.publicId;
  }));
  res.json({
    data: users,
  });
};
export const getUsersIdDetails: RequestHandler = async (req, res) => {
  const routeId = z.string().regex(/^(?:[a-f\d]{24}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i).parse(req.params.id);
  const user: any = await User.findOne(/^[a-f\d]{24}$/i.test(routeId) ? { _id: routeId } : { id: routeId })
    .select('id name email image publicId role disabled createdAt')
    .lean();
  ensure(user, 404, 'NOT_FOUND');
  if (!user.publicId) {
    const publicId = await allocateUserPublicId();
    await User.updateOne({ _id: user._id, $or: [{ publicId: { $exists: false } }, { publicId: null }] }, { $set: { publicId } });
    user.publicId = (await User.findById(user._id).select('publicId').lean() as any)?.publicId;
  }

  const match = { user: new mongoose.Types.ObjectId(String(user._id)) };
  const [totalsRows, songRows, weekdayRows, recentEvents] = await Promise.all([
    ListeningEvent.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        events: { $sum: 1 },
        listenedSeconds: { $sum: '$seconds' },
        plays: { $sum: { $cond: [{ $eq: ['$type', 'play'] }, 1, 0] } },
        completions: { $sum: { $cond: [{ $eq: ['$type', 'completion'] }, 1, 0] } },
      } },
    ]),
    ListeningEvent.aggregate([
      { $match: match },
      { $group: {
        _id: '$song',
        events: { $sum: 1 },
        listenedSeconds: { $sum: '$seconds' },
        plays: { $sum: { $cond: [{ $in: ['$type', ['play', 'completion']] }, 1, 0] } },
        completions: { $sum: { $cond: [{ $eq: ['$type', 'completion'] }, 1, 0] } },
        lastPlayedAt: { $max: '$createdAt' },
      } },
      { $lookup: { from: Song.collection.name, localField: '_id', foreignField: '_id', as: 'song' } },
      { $unwind: '$song' },
      { $sort: { listenedSeconds: -1 } },
      { $limit: 100 },
      { $project: { events: 1, listenedSeconds: 1, plays: 1, completions: 1, lastPlayedAt: 1, title: '$song.title', genre: '$song.genre', categories: '$song.categories', duration: '$song.duration', coverUrl: '$song.coverUrl', artwork: '$song.artwork' } },
    ]),
    ListeningEvent.aggregate([
      { $match: match },
      { $group: { _id: { $dayOfWeek: '$createdAt' }, events: { $sum: 1 }, listenedSeconds: { $sum: '$seconds' } } },
    ]),
    ListeningEvent.find(match).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const categoryIds = [...new Set(songRows.flatMap((row: any) => row.categories ?? []).map(String))];
  const categories = categoryIds.length ? await Category.find({ _id: { $in: categoryIds } }).select('name').lean() : [];
  const categoryNames = new Map(categories.map((category: any) => [String(category._id), category.name]));
  const categoryTotals = new Map<string, number>();
  for (const song of songRows as any[]) {
    const names = new Set<string>();
    if (song.genre) names.add(String(song.genre));
    for (const categoryId of song.categories ?? []) {
      const categoryName = categoryNames.get(String(categoryId));
      if (categoryName) names.add(categoryName);
    }
    for (const categoryName of names) categoryTotals.set(categoryName, (categoryTotals.get(categoryName) ?? 0) + song.listenedSeconds);
  }
  const songIds = [...new Set(recentEvents.map((event: any) => String(event.song)))];
  const recentSongs = songIds.length ? await Song.find({ _id: { $in: songIds } }).select('title genre').lean() : [];
  const recentSongMap = new Map(recentSongs.map((song: any) => [String(song._id), song]));
  const totals = totalsRows[0] ?? { events: 0, listenedSeconds: 0, plays: 0, completions: 0 };
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdayMap = new Map(weekdayRows.map((row: any) => [row._id - 1, row]));

  res.json({
    user: { ...user, id: String(user.id || user._id), _id: undefined },
    listening: {
      totalEvents: totals.events,
      totalListenedSeconds: totals.listenedSeconds,
      totalListenedMinutes: Math.round(totals.listenedSeconds / 60),
      plays: totals.plays,
      completions: totals.completions,
      topSongs: songRows.map((song: any) => ({ ...song, id: String(song._id), _id: undefined, categories: (song.categories ?? []).map((value: unknown) => categoryNames.get(String(value))).filter(Boolean) })),
      topCategories: [...categoryTotals].map(([name, listenedSeconds]) => ({ name, listenedSeconds })).sort((a, b) => b.listenedSeconds - a.listenedSeconds).slice(0, 10),
      weekdays: weekdayNames.map((name, index) => ({ name, events: weekdayMap.get(index)?.events ?? 0, listenedSeconds: weekdayMap.get(index)?.listenedSeconds ?? 0 })),
      recentActivity: recentEvents.map((event: any) => ({ type: event.type, seconds: event.seconds, createdAt: event.createdAt, song: recentSongMap.get(String(event.song))?.title ?? 'Deleted song', genre: recentSongMap.get(String(event.song))?.genre ?? null })),
    },
  });
};
export const getDashboardOverview: RequestHandler = async (_req, res) => {
  const now = new Date();
  const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  const [
    totalUsers,
    activeUsers,
    restrictedUsers,
    totalSongs,
    publishedSongs,
    readySongs,
    artists,
    categories,
    tags,
    playlists,
    listeningEvents,
    userTrend,
    songTrend,
    playTrend,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ disabled: { $ne: true } }),
    User.countDocuments({ disabled: true }),
    Song.countDocuments(),
    Song.countDocuments({ published: true }),
    Song.countDocuments({ processing: 'ready' }),
    Artist.countDocuments(),
    Category.countDocuments(),
    Tag.countDocuments(),
    Playlist.countDocuments(),
    ListeningEvent.countDocuments({ type: { $in: ['play', 'completion'] } }),
    User.aggregate([{ $match: { createdAt: { $gte: firstMonth } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'UTC' } }, count: { $sum: 1 } } }]),
    Song.aggregate([{ $match: { createdAt: { $gte: firstMonth } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'UTC' } }, count: { $sum: 1 } } }]),
    ListeningEvent.aggregate([{ $match: { type: { $in: ['play', 'completion'] }, createdAt: { $gte: firstMonth } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'UTC' } }, count: { $sum: 1 } } }]),
  ]);
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return {
      key,
      label: new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(date),
      users: userTrend.find((item: any) => item._id === key)?.count ?? 0,
      songs: songTrend.find((item: any) => item._id === key)?.count ?? 0,
      plays: playTrend.find((item: any) => item._id === key)?.count ?? 0,
    };
  });
  res.json({
    summary: { totalUsers, activeUsers, restrictedUsers, totalSongs, publishedSongs, readySongs, artists, categories, tags, playlists, listeningEvents },
    months,
  });
};
export const patchUsersId: RequestHandler = async (req, res) => {
  const routeId = z.string().regex(/^(?:[a-f\d]{24}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i).parse(req.params.id);
  const existingUser: any = await User.findOne(/^[a-f\d]{24}$/i.test(routeId) ? { _id: routeId } : { id: routeId }).select('_id');
  ensure(existingUser, 404, 'NOT_FOUND');
  const user = String(existingUser._id);
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
export const getSongs: RequestHandler = async (req, res) => {
  const query = page.extend({
    q: z.string().trim().max(200).optional(),
    processing: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
    published: z.enum(['true', 'false']).optional(),
    quality: z.enum(['64', '128', '192']).optional(),
  }).parse(req.query);
  const filter: Record<string, any> = {
    ...(query.processing ? { processing: query.processing } : {}),
    ...(query.published !== undefined ? { published: query.published === 'true' } : {}),
    ...(query.quality ? { 'audio.quality': query.quality } : {}),
    ...(query.q ? { $or: [
      { title: { $regex: query.q, $options: 'i' } },
      { language: { $regex: query.q, $options: 'i' } },
      { genre: { $regex: query.q, $options: 'i' } },
    ] } : {}),
  };
  const [data, total] = await Promise.all([
    Song.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Song.countDocuments(filter),
  ]);
  res.json({ data: data.map(({ _id, ...fields }: any) => ({ ...fields, mongoId: String(_id) })), page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) });
};
export const getSongsIdPreview: RequestHandler = async (req, res) => {
  const song: any = await Song.findById(id.parse(req.params.id)).select('+sourceFileId');
  ensure(song?.processing === 'ready', 404, 'AUDIO_NOT_READY');
  const audio = (song.audio ?? []).find((item: any) => item.fileId || item.url);
  ensure(audio, 404, 'MEDIA_NOT_FOUND');
  if (audio.url) {
    res.redirect(302, audio.url);
    return;
  }
  streamFile(audio.fileId, audio.mime || 'audio/mpeg', res);
};
export const postSongsIdPublish: RequestHandler = async (req, res) => {
  const songId = id.parse(req.params.id);
  const { published } = z.object({ published: z.boolean() }).strict().parse(req.body);
  if (published) {
    const song: any = await Song.findById(songId);
    ensure(song?.processing === 'ready' && (song.audio ?? []).length > 0, 409, 'AUDIO_NOT_READY');
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

export const getSongsIdCloudinarySignature: RequestHandler = async (req, res) => {
  const songId = id.parse(req.params.id);
  ensure(hasCloudinaryConfig(), 503, 'CLOUDINARY_CONFIG_MISSING');
  const song: any = await Song.findById(songId);
  ensure(song, 404, 'NOT_FOUND');
  const input = z.object({ bytes: z.coerce.number().int().positive().max(200 * 1024 * 1024) }).parse(req.query);
  ensure(input.bytes <= 200 * 1024 * 1024, 413, 'UPLOAD_TOO_LARGE');
  res.json(createCloudinaryAudioUploadSignature(songId));
};

export const postSongsIdCloudinaryComplete: RequestHandler = async (req, res) => {
  const songId = id.parse(req.params.id);
  ensure(hasCloudinaryConfig(), 503, 'CLOUDINARY_CONFIG_MISSING');
  const input = z.object({ publicId: z.string().min(1).max(300), bytes: z.number().int().positive().max(200 * 1024 * 1024) }).strict().parse(req.body);
  const song = await Song.findById(songId);
  ensure(song, 404, 'NOT_FOUND');
  const expectedPublicId = `music-platform/audio/song-${songId}`;
  ensure(input.publicId === expectedPublicId, 400, 'INVALID_CLOUDINARY_PUBLIC_ID');
  const audio = [{
    quality: '192',
    url: cloudinaryAudioUrl(input.publicId),
    publicId: input.publicId,
    bytes: input.bytes,
    mime: 'audio/mpeg',
  }];
  song.audio = audio as typeof song.audio;
  song.processing = 'ready';
  await song.save();
  res.json({ status: 'completed', audio: song.audio });
};

export const postArtistsIdImage: RequestHandler = async (req, res) => {
  ensure(Buffer.isBuffer(req.body) && req.body.length > 0, 400, 'UPLOAD_BODY_REQUIRED');
  res.status(202).json(await service.uploadArtistImage(id.parse(req.params.id), req.body));
};

export const postAlbumsIdImage: RequestHandler = async (req, res) => {
  ensure(Buffer.isBuffer(req.body) && req.body.length > 0, 400, 'UPLOAD_BODY_REQUIRED');
  res.status(202).json(await service.uploadAlbumImage(id.parse(req.params.id), req.body));
};

export const postCategoriesIdImage: RequestHandler = async (req, res) => {
  ensure(Buffer.isBuffer(req.body) && req.body.length > 0, 400, 'UPLOAD_BODY_REQUIRED');
  res.status(202).json(await service.uploadCategoryImage(id.parse(req.params.id), req.body));
};
export const postUploadsIdComplete: RequestHandler = async (req, res) =>
  res.status(202).json(await service.completeUpload(id.parse(req.params.id)));
export const getJobsId: RequestHandler = async (req, res) => {
  const job = await requireAudioQueue().getJob(id.parse(req.params.id));
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
  const job = await requireAudioQueue().getJob(id.parse(req.params.id));
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
  await requireNotificationQueue().add('notify', input, { jobId: input.dedupeKey });
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
