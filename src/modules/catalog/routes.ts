import { Router } from 'express';
import { ensure } from '../../shared/errors';
import { id, page } from '../../shared/validation';
import * as controller from './controller';
import { Album, Artist, Category, Tag } from './models';
export const catalogRoutes = Router();
catalogRoutes.get('/songs', controller.getSongs);
catalogRoutes.get('/songs/:id', controller.getSongsId);
catalogRoutes.get('/search', controller.getSearch);
catalogRoutes.get('/media/covers/:id', controller.getMediaCoversId);
for (const [path, model] of Object.entries({
  artists: Artist,
  albums: Album,
  categories: Category,
  tags: Tag,
})) {
  const Model: any = model;
  const view = async (doc: any) => {
    const obj = doc.toObject();
    delete obj.imageFileId;
    delete obj.coverFileId;
    return obj;
  };
  catalogRoutes.get(`/${path}`, async (req, res) => {
    const q = page.parse(req.query);
    res.json({
      data: await Promise.all(
        (
          await Model.find()
            .sort({ _id: 1 })
            .skip((q.page - 1) * q.limit)
            .limit(q.limit)
        ).map(view),
      ),
      page: q.page,
    });
  });
  catalogRoutes.get(`/${path}/:id`, async (req, res) => {
    const row = await Model.findById(id.parse(req.params.id));
    ensure(row, 404, 'NOT_FOUND');
    res.json(await view(row));
  });
}
