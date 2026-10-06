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
for (const [path, { model: Model, schema }] of Object.entries(resources)) {
  adminRoutes.get(`/${path}`, async (req, res) => {
    const q = page.parse(req.query);
    res.json({
      data: await Model.find()
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
    });
  });
  adminRoutes.get(`/${path}/:id`, async (req, res) => {
    const row = await Model.findById(id.parse(req.params.id));
    ensure(row, 404, 'NOT_FOUND');
    res.json(row);
  });
  adminRoutes.post(`/${path}`, async (req, res) => {
    const input = schema.parse(req.body);
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
    res.status(201).json(await Model.create(input));
  });
  adminRoutes.patch(`/${path}/:id`, async (req, res) => {
    const updateSchema =
      path === 'categories' ? schema.omit({ parent: true }).partial() : schema.partial();
    const input = updateSchema.parse(req.body);
    if (
      path === 'plans' &&
      Object.keys(input).some((key) =>
        ['offlineLimit', 'deviceLimit', 'offlineDays', 'qualities'].includes(key),
      )
    )
      ensure(
        !(await Subscription.exists({
          plan: id.parse(req.params.id),
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
      id.parse(req.params.id),
      { $set: input },
      { new: true, runValidators: true },
    );
    ensure(row, 404, 'NOT_FOUND');
    res.json(row);
  });
}
adminRoutes.delete('/playlists/:id', controller.deletePlaylistsId);
adminRoutes.get('/users', controller.getUsers);
adminRoutes.patch('/users/:id', controller.patchUsersId);
adminRoutes.put('/licenses/:songId', controller.putLicensesSongId);
adminRoutes.get('/licenses', controller.getLicenses);
adminRoutes.post('/songs/:id/publish', controller.postSongsIdPublish);
adminRoutes.post('/songs/:id/uploads', controller.postSongsIdUploads);
adminRoutes.post('/uploads/:id/complete', controller.postUploadsIdComplete);
adminRoutes.get('/jobs/:id', controller.getJobsId);
adminRoutes.post('/jobs/:id/retry', controller.postJobsIdRetry);
adminRoutes.get('/subscriptions', controller.getSubscriptions);
adminRoutes.put('/subscriptions/:userId', controller.putSubscriptionsUserId);
adminRoutes.post('/notifications', controller.postNotifications);
adminRoutes.get('/analytics', controller.getAnalytics);
