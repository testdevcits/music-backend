import { RequestHandler } from 'express';
import { streamFile } from '../../infrastructure/media';
import { z } from 'zod';
import { ensure } from '../../shared/errors';
import { id, page, songId } from '../../shared/validation';
import { Song } from './models';
import { findSong, songView } from './service';
export const getSongs: RequestHandler = async (req, res) => {
  const q = page
    .extend({
      category: id.optional(),
      tag: id.optional(),
      artist: id.optional(),
      album: id.optional(),
      language: z.string().max(50).optional(),
    })
    .parse(req.query);
  const filter = {
    published: true,
    processing: 'ready',
    ...(q.category ? { categories: q.category } : {}),
    ...(q.tag ? { tags: q.tag } : {}),
    ...(q.artist ? { artist: q.artist } : {}),
    ...(q.album ? { album: q.album } : {}),
    ...(q.language ? { language: q.language } : {}),
  };
  const rows = await Song.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((q.page - 1) * q.limit)
    .limit(q.limit);
  res.json({ data: await Promise.all(rows.map(songView)), page: q.page, limit: q.limit });
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
  const q = page.extend({ q: z.string().trim().min(2).max(100) }).parse(req.query);
  const songs = await Song.find(
    { $text: { $search: q.q }, published: true, processing: 'ready' },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .skip((q.page - 1) * q.limit)
    .limit(q.limit);
  res.json({ data: await Promise.all(songs.map(songView)), page: q.page });
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
