import { Router } from 'express';
import { z } from 'zod';
import { admin } from '../../middleware/auth';
import { ensure } from '../../shared/errors';
import { id, name, page } from '../../shared/validation';
import { User } from '../auth/models';
import { Plan, Subscription } from '../billing/models';
import { Album, Artist, Category, Song, Tag } from '../catalog/models';
import { Playlist } from '../library/models';
import * as controller from './controller';
import * as service from './service';
import * as validators from './validators';
export const adminRoutes = Router();
adminRoutes.use(admin);

adminRoutes.get('/import/providers', async (_req, res) => {
  const providers = [
    {
      name: 'configured',
      baseUrl: process.env.MUSIC_IMPORT_PROVIDER_BASE_URL || null,
      allowAudio: !!process.env.MUSIC_IMPORT_ALLOW_AUDIO && process.env.MUSIC_IMPORT_ALLOW_AUDIO === 'true',
      allowImages: !!process.env.MUSIC_IMPORT_ALLOW_IMAGES && process.env.MUSIC_IMPORT_ALLOW_IMAGES !== 'false',
      permittedFields: (process.env.MUSIC_IMPORT_PERMITTED_FIELDS || '').split(',').map((value) => value.trim()).filter(Boolean),
    },
  ];
  res.json({ data: providers.filter((provider) => provider.baseUrl) });
});

adminRoutes.get('/import/search', async (req, res) => {
  const input = z
    .object({
      q: z.string().trim().min(1).max(200),
      provider: z.string().trim().max(100).default('configured'),
    })
    .parse(req.query);
  res.json({ data: await service.searchMusicImport(input.q, input.provider) });
});

adminRoutes.post('/import', async (req, res) => {
  const input = z
    .object({
      provider: z.string().trim().max(100).default('configured'),
      externalSongId: z.string().trim().min(1).max(200),
      title: z.string().trim().min(1).max(200),
      artist: z.string().trim().max(200).optional(),
      album: z.string().trim().max(200).optional(),
      language: z.string().trim().max(50).optional(),
      duration: z.number().int().min(0).max(86400).optional(),
      genre: z.string().trim().max(100).optional(),
      year: z.number().int().min(1900).max(2100).optional(),
      trackNumber: z.number().int().min(1).max(500).optional(),
      discNumber: z.number().int().min(1).max(20).optional(),
      format: z.string().trim().max(20).optional(),
      bitrate: z.number().int().min(1).max(2000).optional(),
      artwork: z.string().url().max(2000).optional(),
      coverUrl: z.string().url().max(2000).optional(),
      url: z.string().url().max(2000).optional(),
      category: z.union([z.string().trim().max(100), z.array(z.string().trim().max(100))]).optional(),
      lyrics: z.string().max(50000).optional(),
      sourceLicense: z.string().trim().max(500).optional(),
    })
    .strict()
    .parse(req.body);
  res.status(201).json(await service.importMusicRecord(input));
});

const resources: Record<string, { model: any; schema: z.AnyZodObject }> = {
  artists: { model: Artist, schema: validators.artistInput },
  albums: { model: Album, schema: validators.albumInput },
  categories: { model: Category, schema: validators.categoryInput },
  tags: { model: Tag, schema: validators.tagInput },
  songs: { model: Song, schema: validators.songInput },
  plans: { model: Plan, schema: validators.planInput },
  playlists: {
    model: Playlist,
    schema: z
      .object({ owner: id, name, public: z.boolean(), songs: z.array(id).max(1000) })
      .strict(),
  },
};
adminRoutes.get('/songs', controller.getSongs);
for (const [path, { model: Model, schema }] of Object.entries(resources)) {
  adminRoutes.get(`/${path}`, async (req, res) => {
    const q = page.parse(req.query);
    const rows = await Model.find()
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean();
    res.json({
      data: rows.map((row: any) => {
        const { _id, ...fields } = row;
        return { ...fields, mongoId: String(_id) };
      }),
    });
  });
  adminRoutes.get(`/${path}/:id`, async (req, res) => {
    const row = await Model.findById(id.parse(req.params.id)).lean();
    ensure(row, 404, 'NOT_FOUND');
    const { _id, ...fields } = row as any;
    res.json({ ...fields, mongoId: String(_id) });
  });
  adminRoutes.post(`/${path}`, async (req, res) => {
    const input = schema.parse(req.body);
    if (path === 'artists') await service.ensureUniqueArtistName(input.name);
    await service.validateReferences(input);
    if (path === 'categories' && input.parent)
      ensure(await Category.exists({ _id: input.parent }), 400, 'INVALID_PARENT');
    if (path === 'playlists') {
      ensure(await User.exists({ _id: input.owner }), 400, 'INVALID_OWNER');
      ensure(
        (await Song.countDocuments({ _id: { $in: input.songs } })) === new Set(input.songs).size,
        400,
        'INVALID_SONGS',
      );
    }
    const created = await Model.create(input);
    res.status(201).json({ ...created.toJSON(), mongoId: String(created._id) });
  });
  adminRoutes.patch(`/${path}/:id`, async (req, res) => {
    const updateSchema =
      path === 'categories' ? schema.omit({ parent: true }).partial() : schema.partial();
    const input = updateSchema.parse(req.body);
    const resourceId = id.parse(req.params.id);
    if (path === 'artists' && input.name)
      await service.ensureUniqueArtistName(input.name, resourceId);
    if (
      path === 'plans' &&
      Object.keys(input).some((key) =>
        ['offlineLimit', 'deviceLimit', 'offlineDays', 'qualities'].includes(key),
      )
    )
      ensure(
        !(await Subscription.exists({
          plan: resourceId,
          status: 'active',
          endsAt: { $gt: new Date() },
        })),
        409,
        'PLAN_IN_USE_CREATE_NEW_VERSION',
      );
    await service.validateReferences(input);
    if (path === 'playlists') {
      if (input.owner) ensure(await User.exists({ _id: input.owner }), 400, 'INVALID_OWNER');
      if (input.songs)
        ensure(
          (await Song.countDocuments({ _id: { $in: input.songs } })) === new Set(input.songs).size,
          400,
          'INVALID_SONGS',
        );
    }
    const row = await Model.findByIdAndUpdate(
      resourceId,
      { $set: input },
      { new: true, runValidators: true },
    );
    ensure(row, 404, 'NOT_FOUND');
    res.json(row);
  });
}
adminRoutes.delete('/artists/:id', async (req, res) => {
  const artistId = id.parse(req.params.id);
  ensure(
    !(await Song.exists({ artist: artistId })) && !(await Album.exists({ artist: artistId })),
    409,
    'ARTIST_IN_USE',
  );
  const artist = await Artist.findByIdAndDelete(artistId);
  ensure(artist, 404, 'NOT_FOUND');
  res.status(204).send();
});
adminRoutes.delete('/categories/:id', async (req, res) => {
  const categoryId = id.parse(req.params.id);
  const category = await Category.findByIdAndDelete(categoryId);
  ensure(category, 404, 'NOT_FOUND');
  res.status(204).send();
});
adminRoutes.delete('/tags/:id', async (req, res) => {
  const tagId = id.parse(req.params.id);
  const tag = await Tag.findByIdAndDelete(tagId);
  ensure(tag, 404, 'NOT_FOUND');
  res.status(204).send();
});
adminRoutes.delete('/songs/:id', async (req, res) => {
  const songId = id.parse(req.params.id);
  const song = await Song.findByIdAndDelete(songId);
  ensure(song, 404, 'NOT_FOUND');
  res.status(204).send();
});
adminRoutes.delete('/playlists/:id', controller.deletePlaylistsId);
adminRoutes.get('/users', controller.getUsers);
adminRoutes.patch('/users/:id', controller.patchUsersId);
adminRoutes.put('/licenses/:songId', controller.putLicensesSongId);
adminRoutes.get('/licenses', controller.getLicenses);
adminRoutes.post('/songs/:id/publish', controller.postSongsIdPublish);
adminRoutes.get('/songs/:id/preview', controller.getSongsIdPreview);
adminRoutes.post('/songs/:id/uploads', controller.postSongsIdUploads);
adminRoutes.get('/songs/:id/cloudinary-signature', controller.getSongsIdCloudinarySignature);
adminRoutes.post('/songs/:id/cloudinary-complete', controller.postSongsIdCloudinaryComplete);
adminRoutes.post('/artists/:id/image', controller.postArtistsIdImage);
adminRoutes.post('/albums/:id/image', controller.postAlbumsIdImage);
adminRoutes.post('/categories/:id/image', controller.postCategoriesIdImage);
adminRoutes.post('/albums/:id/image', controller.postAlbumsIdImage);
adminRoutes.post('/categories/:id/image', controller.postCategoriesIdImage);
adminRoutes.post('/uploads/:id/complete', controller.postUploadsIdComplete);
adminRoutes.get('/jobs/:id', controller.getJobsId);
adminRoutes.post('/jobs/:id/retry', controller.postJobsIdRetry);
adminRoutes.get('/subscriptions', controller.getSubscriptions);
adminRoutes.put('/subscriptions/:userId', controller.putSubscriptionsUserId);
adminRoutes.post('/notifications', controller.postNotifications);
adminRoutes.get('/analytics', controller.getAnalytics);
