import mongoose from 'mongoose';
import { RequestHandler } from 'express';
import { z } from 'zod';
import { ensure } from '../../shared/errors';
import { streamBucketFile, streamFile } from '../../infrastructure/media';
import { identityForResourceId } from '../../shared/ids';
import { name, page, publicOrMongoId, quality, songId } from '../../shared/validation';
import { User } from '../auth/models';
import { Song } from '../catalog/models';
import { findSong, songView } from '../catalog/service';
import { ListeningEvent } from '../playback/models';
import { Device, Download, Favorite, Notification, Playlist } from './models';
import * as service from './service';
import { requestCountry } from '../../shared/request-country';
import { hasCloudinaryConfig, uploadProfileImageToCloudinary } from '../../infrastructure/cloudinary';

async function migrateLegacyProfileImage(user: any) {
  const image = normalizeUserImage(user?.image);
  const match = image?.url.match(/^\/api\/v1\/users\/me\/avatar\/([a-f\d]{24})$/i);
  if (!match) return user;
  ensure(hasCloudinaryConfig(), 503, 'CLOUDINARY_CONFIG_MISSING');
  ensure(mongoose.connection.db, 503, 'DATABASE_UNAVAILABLE');

  const fileId = new mongoose.Types.ObjectId(match[1]);
  const file = await mongoose.connection.db.collection('profiles.files').findOne({ _id: fileId });
  ensure(file, 404, 'MEDIA_NOT_FOUND');
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = new mongoose.mongo.GridFSBucket(mongoose.connection.db!, { bucketName: 'profiles' }).openDownloadStream(fileId);
    stream.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > 10 * 1024 * 1024) {
        stream.destroy(new Error('PROFILE_IMAGE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const uploaded = await uploadProfileImageToCloudinary(Buffer.concat(chunks), String(user._id));
  const cloudinaryImage = { url: uploaded.url, alt: uploaded.alt || 'Profile image', publicId: uploaded.publicId };
  await User.updateOne(
    { _id: user._id, 'image.url': image?.url },
    { $set: { image: cloudinaryImage } },
  );
  return await User.findById(user._id).select('name email role createdAt image');
}

function normalizeUserImage(value: unknown) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { url: trimmed, alt: 'Profile image' } : null;
  }
  if (typeof value === 'object' && 'url' in value && typeof (value as { url?: unknown }).url === 'string') {
    return {
      url: String((value as { url?: unknown }).url),
      alt: typeof (value as { alt?: unknown }).alt === 'string' ? String((value as { alt?: unknown }).alt) : 'Profile image',
      publicId:
        typeof (value as { publicId?: unknown }).publicId === 'string'
          ? String((value as { publicId?: unknown }).publicId)
          : undefined,
    };
  }
  return null;
}

function serializeUser(user: any) {
  return {
    id: String(user?._id ?? user?.id ?? ''),
    email: user?.email,
    createdAt: user?.createdAt,
    name: user?.name,
    role: user?.role,
    image: normalizeUserImage(user?.image),
  };
}

export const getUsersMe: RequestHandler = async (req, res) => {
  const user = await User.findById(req.auth.userId).select('name email role createdAt image');
  const currentUser = await migrateLegacyProfileImage(user);
  res.json(serializeUser(currentUser));
};
export const postUsersMeAvatar: RequestHandler = async (req, res) => {
  const contentType = String(req.headers['content-type'] || 'image/png');
  ensure(/^image\//.test(contentType), 400, 'UNSUPPORTED_CONTENT_TYPE');
  const imageData = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
  ensure(imageData.length > 0, 400, 'EMPTY_IMAGE');
  ensure(hasCloudinaryConfig(), 503, 'CLOUDINARY_CONFIG_MISSING');
  try {
    const cloudinaryUpload = await uploadProfileImageToCloudinary(imageData, req.auth.userId);
    const user = await User.findByIdAndUpdate(
      req.auth.userId,
      {
        $set: {
          image: {
            url: cloudinaryUpload.url,
            alt: cloudinaryUpload.alt || 'Profile image',
            publicId: cloudinaryUpload.publicId,
          },
        },
      },
      { new: true },
    ).select('name email role image createdAt');
    return res.status(201).json(serializeUser(user));
  } catch (error) {
    const message = String((error as Error)?.message || '');
    if (message.includes('Invalid image file') || message.includes('CLOUDINARY_UPLOAD_FAILED')) {
      throw new Error('INVALID_IMAGE');
    }
    throw error;
  }
};
export const getUsersMeAvatarId: RequestHandler = async (req, res) => {
  const fileId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const user = await User.findById(req.auth.userId).select('image');
  const rawImage = user?.image;
  const currentImage =
    typeof rawImage === 'string'
      ? rawImage
      : rawImage && typeof rawImage === 'object' && 'url' in rawImage
        ? String(rawImage.url)
        : '';
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
      image: z
        .union([
          z.string().trim().max(5000),
          z.object({
            url: z.string().trim().max(5000),
            alt: z.string().trim().max(200).optional(),
            publicId: z.string().trim().max(500).optional(),
          }),
        ])
        .optional(),
    })
    .strict()
    .parse(req.body);
  const user = await User.findByIdAndUpdate(req.auth.userId, { $set: input }, { new: true }).select(
    'name email role image createdAt',
  );
  res.json(serializeUser(user));
};
export const getPlaylists: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  const [data, total] = await Promise.all([
    Playlist.find({ owner: req.auth.userId })
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    Playlist.countDocuments({ owner: req.auth.userId }),
  ]);
  res.json({
    data,
    page: q.page,
    limit: q.limit,
    total,
    pages: Math.ceil(total / q.limit),
  });
};
export const postPlaylists: RequestHandler = async (req, res) => {
  const input = z
    .object({ name: name.optional(), public: z.boolean().default(false) })
    .strict()
    .parse(req.body);
  const playlistName = input.name || `Playlist ${(await Playlist.countDocuments({ owner: req.auth.userId })) + 1}`;
  res.status(201).json(await Playlist.create({ ...input, name: playlistName, owner: req.auth.userId }));
};
export const getPlaylistsId: RequestHandler = async (req, res) => {
  const row = await Playlist.findOne({
    ...identityForResourceId(publicOrMongoId.parse(req.params.id)),
    $or: [{ owner: req.auth.userId }, { public: true }],
  });
  ensure(row, 404, 'NOT_FOUND');
  const playlistSongs = ((row as any).songs ?? []) as any[];
  const items = await Song.find({ _id: { $in: playlistSongs }, published: true, processing: 'ready' });
  const itemsById = new Map(items.map((song: any) => [String(song._id), song]));
  const populatedItems = playlistSongs
    .map((songId: any) => itemsById.get(String(songId)))
    .filter(Boolean);
  res.json({ ...row.toObject(), items: await Promise.all(populatedItems.map(songView)) });
};
export const patchPlaylistsId: RequestHandler = async (req, res) => {
  const input = z
    .object({ name: name.optional(), public: z.boolean().optional() })
    .strict()
    .parse(req.body);
  const row = await Playlist.findOneAndUpdate(
    { ...identityForResourceId(publicOrMongoId.parse(req.params.id)), owner: req.auth.userId },
    { $set: input },
    { new: true },
  );
  ensure(row, 404, 'NOT_FOUND');
  res.json(row);
};
export const deletePlaylistsId: RequestHandler = async (req, res) => {
  await Playlist.deleteOne({ ...identityForResourceId(publicOrMongoId.parse(req.params.id)), owner: req.auth.userId });
  res.sendStatus(204);
};
export const putPlaylistsIdSongsSongId: RequestHandler = async (req, res) => {
  const song = await findSong(songId.parse(req.params.songId), { published: true, processing: 'ready' });
  ensure(song, 404, 'SONG_UNAVAILABLE');
  const playlist = await Playlist.findOneAndUpdate(
    {
      ...identityForResourceId(publicOrMongoId.parse(req.params.id)),
      owner: req.auth.userId,
      $or: [{ songs: song._id }, { 'songs.999': { $exists: false } }],
    },
    { $addToSet: { songs: song._id } },
    { new: true },
  );
  ensure(playlist, 409, 'PLAYLIST_UNAVAILABLE_OR_FULL');
  res.json(playlist);
};
export const deletePlaylistsIdSongsSongId: RequestHandler = async (req, res) => {
  const requestedSongId = songId.parse(req.params.songId);
  const song = await findSong(requestedSongId);
  const mongoSongId = song?._id ?? (/^[a-f\d]{24}$/i.test(requestedSongId) ? requestedSongId : null);
  if (mongoSongId) await Playlist.updateOne(
    { ...identityForResourceId(publicOrMongoId.parse(req.params.id)), owner: req.auth.userId },
    { $pull: { songs: mongoSongId } },
  );
  res.sendStatus(204);
};
export const getFavorites: RequestHandler = async (req, res) => {
  const q = page.parse(req.query);
  const filter = { user: req.auth.userId };
  const [data, total] = await Promise.all([
    Favorite.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
    Favorite.countDocuments(filter),
  ]);
  res.json({ data, page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) });
};
export const putFavoritesSongId: RequestHandler = async (req, res) => {
  const song = await findSong(songId.parse(req.params.songId), { published: true, processing: 'ready' });
  ensure(song, 404, 'SONG_UNAVAILABLE');
  res.json(
    await Favorite.findOneAndUpdate(
      { user: req.auth.userId, song: song._id },
      { $setOnInsert: { user: req.auth.userId, song: song._id } },
      { upsert: true, new: true },
    ),
  );
};
export const deleteFavoritesSongId: RequestHandler = async (req, res) => {
  const requestedSongId = songId.parse(req.params.songId);
  const song = await findSong(requestedSongId);
  const mongoSongId = song?._id ?? (/^[a-f\d]{24}$/i.test(requestedSongId) ? requestedSongId : null);
  if (mongoSongId) await Favorite.deleteOne({ user: req.auth.userId, song: mongoSongId });
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
  await service.revokeDevice(req.auth.userId, publicOrMongoId.parse(req.params.id));
  res.sendStatus(204);
};
export const postDownloads: RequestHandler = async (req, res) => {
  const input = z.object({ song: songId, device: publicOrMongoId, quality }).strict().parse(req.body);
  res.status(201).json(await service.grantDownload(req.auth.userId, input, requestCountry(req)));
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
  const { device } = z.object({ device: publicOrMongoId }).strict().parse(req.body);
  res
    .set('Cache-Control', 'no-store')
    .json(await service.downloadUrl(req.auth.userId, publicOrMongoId.parse(req.params.id), device, requestCountry(req)));
};
export const getDownloadsIdAudio: RequestHandler = async (req, res) => {
  const device = publicOrMongoId.parse(req.query.device);
  const media = await service.downloadFile(req.auth.userId, publicOrMongoId.parse(req.params.id), device, requestCountry(req));
  streamFile(media.fileId, media.mime, res);
};
export const deleteDownloadsId: RequestHandler = async (req, res) => {
  await Download.updateOne(
    { ...identityForResourceId(publicOrMongoId.parse(req.params.id)), user: req.auth.userId },
    { $set: { revokedAt: new Date() } },
  );
  res.sendStatus(204);
};
export const getNotifications: RequestHandler = async (req, res) => {
  const q = page.extend({ unreadOnly: z.enum(['true', 'false']).default('false') }).parse(req.query);
  const filter = {
    user: req.auth.userId,
    ...(q.unreadOnly === 'true' ? { readAt: { $exists: false } } : {}),
  };
  const [data, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .select('id title body readAt createdAt')
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: req.auth.userId, readAt: { $exists: false } }),
  ]);
  res.json({
    data,
    page: q.page,
    limit: q.limit,
    total,
    unreadCount,
  });
};
export const getNotificationsUnreadCount: RequestHandler = async (req, res) => {
  const count = await Notification.countDocuments({ user: req.auth.userId, readAt: { $exists: false } });
  res.json({ count });
};
export const patchNotificationsIdRead: RequestHandler = async (req, res) => {
  const notificationId = publicOrMongoId.parse(req.params.id);
  const identity = /^[a-f\d]{24}$/i.test(notificationId) ? { _id: notificationId } : { id: notificationId };
  const notification = await Notification.findOneAndUpdate(
    { ...identity, user: req.auth.userId },
    { $set: { readAt: new Date() } },
    { new: true },
  );
  ensure(notification, 404, 'NOT_FOUND');
  res.sendStatus(204);
};
export const patchNotificationsReadAll: RequestHandler = async (req, res) => {
  const result = await Notification.updateMany(
    { user: req.auth.userId, readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
  );
  res.json({ updated: result.modifiedCount });
};
