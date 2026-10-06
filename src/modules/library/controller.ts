import mongoose from 'mongoose';
import { RequestHandler } from 'express';
import { z } from 'zod';
import { ensure } from '../../shared/errors';
import { saveBufferToBucket, streamBucketFile, streamFile } from '../../infrastructure/media';
import { id, name, page, quality } from '../../shared/validation';
import { User } from '../auth/models';
import { Song } from '../catalog/models';
import { ListeningEvent } from '../playback/models';
import { Device, Download, Favorite, Notification, Playlist } from './models';
import * as service from './service';
export const getUsersMe: RequestHandler = async (req, res) =>
  res.json(await User.findById(req.auth.userId).select('name email role createdAt image'));
export const postUsersMeAvatar: RequestHandler = async (req, res) => {
  const contentType = String(req.headers['content-type'] || 'image/png');
  ensure(/^image\//.test(contentType), 400, 'UNSUPPORTED_CONTENT_TYPE');
  const imageData = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
  ensure(imageData.length > 0, 400, 'EMPTY_IMAGE');
  const fileId = await saveBufferToBucket(
    imageData,
    `profile-${req.auth.userId}-${Date.now()}.png`,
    contentType,
    'profiles',
  );
  const image = `/api/v1/users/me/avatar/${fileId}`;
  const user = await User.findByIdAndUpdate(req.auth.userId, { $set: { image } }, { new: true }).select(
    'name email role image createdAt',
  );
  res.status(201).json(user);
};
export const getUsersMeAvatarId: RequestHandler = async (req, res) => {
  const fileId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const user = await User.findById(req.auth.userId).select('image');
  const currentImage = user?.image ? String(user.image) : '';
  const expectedPath = `/api/v1/users/me/avatar/${fileId}`;
  if (!currentImage || currentImage !== expectedPath) {
    return res.status(403).json({ error: { code: 'FORBIDDEN' } });
  }
  if (!mongoose.connection.db) {
    return res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE' } });
  }
  const file = await mongoose.connection.db.collection('profiles.files').findOne({
    _id: new mongoose.Types.ObjectId(fileId),
  });
  if (!file) return res.status(404).json({ error: { code: 'MEDIA_NOT_FOUND' } });
  streamBucketFile('profiles', fileId, String(file.contentType || 'image/jpeg'), res);
};
export const patchUsersMe: RequestHandler = async (req, res) => {
  const input = z
    .object({
      name: name.optional(),
      image: z.string().trim().max(5000).optional(),
    })
    .strict()
    .parse(req.body);
  res.json(
    await User.findByIdAndUpdate(req.auth.userId, { $set: input }, { new: true }).select(
      'name email role image createdAt',
    ),
  );
};
export const getPlaylists: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await Playlist.find({ owner: req.auth.userId })
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const postPlaylists: RequestHandler = async (req, res) => {
  const input = z
    .object({ name, public: z.boolean().default(false) })
    .strict()
    .parse(req.body);
  res.status(201).json(await Playlist.create({ ...input, owner: req.auth.userId }));
};
export const getPlaylistsId: RequestHandler = async (req, res) => {
  const row = await Playlist.findOne({
    _id: id.parse(req.params.id),
    $or: [{ owner: req.auth.userId }, { public: true }],
  });
  ensure(row, 404, 'NOT_FOUND');
  res.json(row);
};
export const patchPlaylistsId: RequestHandler = async (req, res) => {
  const input = z
    .object({ name: name.optional(), public: z.boolean().optional() })
    .strict()
    .parse(req.body);
  const row = await Playlist.findOneAndUpdate(
    { _id: id.parse(req.params.id), owner: req.auth.userId },
    { $set: input },
    { new: true },
  );
  ensure(row, 404, 'NOT_FOUND');
  res.json(row);
};
export const deletePlaylistsId: RequestHandler = async (req, res) => {
  await Playlist.deleteOne({ _id: id.parse(req.params.id), owner: req.auth.userId });
  res.sendStatus(204);
};
export const putPlaylistsIdSongsSongId: RequestHandler = async (req, res) => {
  const songId = id.parse(req.params.songId);
  ensure(await Song.exists({ _id: songId, published: true }), 404, 'SONG_UNAVAILABLE');
  const playlist = await Playlist.findOneAndUpdate(
    {
      _id: id.parse(req.params.id),
      owner: req.auth.userId,
      $or: [{ songs: songId }, { 'songs.999': { $exists: false } }],
    },
    { $addToSet: { songs: songId } },
    { new: true },
  );
  ensure(playlist, 409, 'PLAYLIST_UNAVAILABLE_OR_FULL');
  res.json(playlist);
};
export const deletePlaylistsIdSongsSongId: RequestHandler = async (req, res) => {
  await Playlist.updateOne(
    { _id: id.parse(req.params.id), owner: req.auth.userId },
    { $pull: { songs: id.parse(req.params.songId) } },
  );
  res.sendStatus(204);
};
export const getFavorites: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await Favorite.find({ user: req.auth.userId })
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const putFavoritesSongId: RequestHandler = async (req, res) => {
  const song = id.parse(req.params.songId);
  ensure(await Song.exists({ _id: song, published: true }), 404, 'SONG_UNAVAILABLE');
  res.json(
    await Favorite.findOneAndUpdate(
      { user: req.auth.userId, song },
      { $setOnInsert: { user: req.auth.userId, song } },
      { upsert: true, new: true },
    ),
  );
};
export const deleteFavoritesSongId: RequestHandler = async (req, res) => {
  await Favorite.deleteOne({ user: req.auth.userId, song: id.parse(req.params.songId) });
  res.sendStatus(204);
};
export const getHistory: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await ListeningEvent.find({ user: req.auth.userId })
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const deleteHistory: RequestHandler = async (req, res) => {
  await ListeningEvent.deleteMany({ user: req.auth.userId });
  res.sendStatus(204);
};
export const postDevices: RequestHandler = async (req, res) => {
  const input = z
    .object({
      installationId: z.string().uuid(),
      name,
      platform: z.enum(['android', 'ios', 'web']),
    })
    .strict()
    .parse(req.body);
  res.status(201).json(await service.registerDevice(req.auth.userId, input));
};
export const getDevices: RequestHandler = async (req, res) =>
  res.json({ data: await Device.find({ user: req.auth.userId, revokedAt: null }).limit(100) });
export const deleteDevicesId: RequestHandler = async (req, res) => {
  await service.revokeDevice(req.auth.userId, id.parse(req.params.id));
  res.sendStatus(204);
};
export const postDownloads: RequestHandler = async (req, res) => {
  const input = z.object({ song: id, device: id, quality }).strict().parse(req.body);
  res.status(201).json(await service.grantDownload(req.auth.userId, input));
};
export const getDownloads: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await Download.find({
      user: req.auth.userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const postDownloadsIdUrl: RequestHandler = async (req, res) => {
  const { device } = z.object({ device: id }).strict().parse(req.body);
  res
    .set('Cache-Control', 'no-store')
    .json(await service.downloadUrl(req.auth.userId, id.parse(req.params.id), device));
};
export const getDownloadsIdAudio: RequestHandler = async (req, res) => {
  const device = id.parse(req.query.device);
  const media = await service.downloadFile(req.auth.userId, id.parse(req.params.id), device);
  streamFile(media.fileId, media.mime, res);
};
export const deleteDownloadsId: RequestHandler = async (req, res) => {
  await Download.updateOne(
    { _id: id.parse(req.params.id), user: req.auth.userId },
    { $set: { revokedAt: new Date() } },
  );
  res.sendStatus(204);
};
export const getNotifications: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  res.json({
    data: await Notification.find({ user: req.auth.userId })
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
  });
};
export const patchNotificationsIdRead: RequestHandler = async (req, res) => {
  await Notification.updateOne(
    { _id: id.parse(req.params.id), user: req.auth.userId },
    { $set: { readAt: new Date() } },
  );
  res.sendStatus(204);
};
