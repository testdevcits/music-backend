import mongoose from 'mongoose';
import { RequestHandler } from 'express';
import { z } from 'zod';
import { ensure } from '../../shared/errors';
import { streamBucketFile, streamFile } from '../../infrastructure/media';
import { id, name, page, quality } from '../../shared/validation';
import { User } from '../auth/models';
import { Song } from '../catalog/models';
import { ListeningEvent } from '../playback/models';
import { Device, Download, Favorite, Notification, Playlist } from './models';
import * as service from './service';
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
