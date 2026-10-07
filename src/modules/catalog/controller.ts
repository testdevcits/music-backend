import { RequestHandler } from 'express';
import { streamFile } from '../../infrastructure/media';
import { z } from 'zod';
import { ensure } from '../../shared/errors';
import { id, page, songId } from '../../shared/validation';
import { Artist, Category, Song } from './models';
import { findSong, songView } from './service';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const catalogQuery = page.extend({
  q: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().max(100).optional(),
  categoryId: id.optional(),
  tag: id.optional(),
  artist: z.string().trim().max(200).optional(),
  artistName: z.string().trim().max(200).optional(),
  album: id.optional(),
  language: z.string().trim().max(50).optional(),
  genre: z.string().trim().max(100).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  fromYear: z.coerce.number().int().min(1900).max(2100).optional(),
  toYear: z.coerce.number().int().min(1900).max(2100).optional(),
  decade: z.coerce.number().int().min(1900).max(2090).refine((value) => value % 10 === 0).optional(),
  sort: z.enum(['recent', 'year-asc', 'year-desc', 'popular', 'title']).default('recent'),
});

async function buildSongFilter(query: z.infer<typeof catalogQuery>) {
  const filter: Record<string, any> = { published: true, processing: 'ready' };
  if (query.q) filter.$text = { $search: query.q };
  if (query.tag) filter.tags = query.tag;
  if (query.album) filter.album = query.album;
  if (query.language) filter.language = new RegExp(`^${escapeRegex(query.language)}$`, 'i');
  if (query.genre) filter.genre = new RegExp(escapeRegex(query.genre), 'i');

  const artistQuery = query.artistName || query.artist;
  if (artistQuery) {
    const artistIds = /^[a-f\d]{24}$/i.test(artistQuery)
      ? [artistQuery]
      : (await Artist.find({ name: new RegExp(escapeRegex(artistQuery), 'i') }).distinct('_id'));
    filter.artist = { $in: artistIds };
  }

  if (query.categoryId || query.category) {
    const categoryQuery = query.categoryId || query.category!;
    const categoryIds = /^[a-f\d]{24}$/i.test(categoryQuery)
      ? [categoryQuery]
      : (await Category.find({
          $or: [
            { slug: categoryQuery.toLowerCase() },
            { name: new RegExp(`^${escapeRegex(categoryQuery)}$`, 'i') },
          ],
        }).distinct('_id'));
    filter.categories = { $in: categoryIds };
  }

  if (query.year !== undefined) filter.year = query.year;
  else if (query.decade !== undefined) filter.year = { $gte: query.decade, $lt: query.decade + 10 };
  else if (query.fromYear !== undefined || query.toYear !== undefined) {
    filter.year = {
      ...(query.fromYear !== undefined ? { $gte: query.fromYear } : {}),
      ...(query.toYear !== undefined ? { $lte: query.toYear } : {}),
    };
  }
  return filter;
}

const sortOptions: Record<string, Record<string, 1 | -1>> = {
  recent: { createdAt: -1, _id: -1 },
  'year-asc': { year: 1, title: 1 },
  'year-desc': { year: -1, title: 1 },
  popular: { playCount: -1, createdAt: -1 },
  title: { title: 1 },
};

export const getSongs: RequestHandler = async (req, res) => {
  const query = catalogQuery.parse(req.query);
  const filter = await buildSongFilter(query);
  const [rows, total] = await Promise.all([
    Song.find(filter)
      .sort(query.q ? { score: { $meta: 'textScore' }, ...sortOptions[query.sort] } as any : sortOptions[query.sort])
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Song.countDocuments(filter),
  ]);
  res.json({
    data: await Promise.all(rows.map(songView)),
    page: query.page,
    limit: query.limit,
    total,
    pages: Math.ceil(total / query.limit),
  });
};

export const getSongsId: RequestHandler = async (req, res) => {
  const song = await findSong(songId.parse(req.params.id), {
    published: true,
    processing: 'ready',
  });
  ensure(song, 404, 'NOT_FOUND');
  res.json(await songView(song));
};

export const getSearch: RequestHandler = async (req, res) => {
  const query = catalogQuery.extend({ q: z.string().trim().min(2).max(100) }).parse(req.query);
  const filter = await buildSongFilter(query);
  const [songs, total] = await Promise.all([
    Song.find(filter)
      .sort({ score: { $meta: 'textScore' }, ...sortOptions[query.sort] } as any)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Song.countDocuments(filter),
  ]);
  res.json({
    data: await Promise.all(songs.map(songView)),
    page: query.page,
    limit: query.limit,
    total,
    pages: Math.ceil(total / query.limit),
  });
};

export const getMediaCoversId: RequestHandler = async (req, res) => {
  const song: any = await Song.findOne({ _id: id.parse(req.params.id), published: true });
  if (song?.coverUrl) {
    res.redirect(song.coverUrl);
    return;
  }
  ensure(song?.coverFileId, 404, 'MEDIA_NOT_FOUND');
  streamFile(song.coverFileId, song.coverMime || 'image/jpeg', res);
};
