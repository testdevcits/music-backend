import { ensure } from '../../shared/errors';
import { License, Song } from './models';
import { songId as songIdSchema } from '../../shared/validation';
import { Category } from './models';
import { ListeningEvent } from '../playback/models';

export async function findSong(songId: string, filter: Record<string, unknown> = {}) {
  const parsedId = songIdSchema.parse(songId);
  const identity = /^[a-f\d]{24}$/i.test(parsedId) ? { _id: parsedId } : { id: parsedId };
  return Song.findOne({ ...identity, ...filter });
}

export async function availableSong(songId: string, offline = false, country?: string) {
  const song: any = await findSong(songId, { published: true, processing: 'ready' });
  ensure(song, 404, 'SONG_UNAVAILABLE');
  const license: any = await License.findOne({
    song: song._id,
    enabled: true,
    startsAt: { $lte: new Date() },
    endsAt: { $gt: new Date() },
    streaming: true,
    verificationStatus: 'verified',
    inAppStreaming: true,
    audioHosting: true,
    commercialUse: true,
    ...(offline ? { offline: true } : {}),
  });
  ensure(license, 403, 'LICENSE_UNAVAILABLE');
  const territories: string[] = license.territories ?? [];
  ensure(
    territories.length === 0 || Boolean(country && territories.includes(country)),
    403,
    country ? 'LICENSE_NOT_AVAILABLE_IN_COUNTRY' : 'TERRITORY_VERIFICATION_REQUIRED',
  );
  return { song, license };
}
export async function songView(song: any) {
  const value = typeof song.toObject === 'function' ? song.toObject() : { ...song };
  const audio = value.audio ?? [];
  const qualities = audio.map((a: any) => a.quality);
  // Audio files are served through the authenticated admin preview endpoint.
  delete value.audio;
  delete value.sourceFileId;
  delete value.audioVersion;
  delete value.processingUpload;
  const hasCover = Boolean(value.coverFileId || value.coverUrl);
  delete value.coverFileId;
  delete value.coverMime;
  return {
    ...value,
    qualities,
    ...(hasCover
      ? {
          coverUrl: value.coverUrl || `/api/v1/media/covers/${value._id}`,
        }
      : {}),
  };
}

export async function getTrendingCatalog(days = 7, limit = 20) {
  const since = new Date(Date.now() - days * 86400000);
  const ranked = await ListeningEvent.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$song',
        plays: { $sum: { $cond: [{ $eq: ['$type', 'play'] }, 1, 0] } },
        completions: { $sum: { $cond: [{ $eq: ['$type', 'completion'] }, 1, 0] } },
        listenedSeconds: { $sum: '$seconds' },
        listeners: { $addToSet: '$user' },
        lastPlayedAt: { $max: '$createdAt' },
      },
    },
    { $sort: { plays: -1, listenedSeconds: -1, lastPlayedAt: -1 } },
    { $limit: 200 },
  ]).option({ maxTimeMS: 10000 });

  if (!ranked.length) return { days, since, songs: [], categories: [] };
  const songs = await Song.find({
    _id: { $in: ranked.map((row: any) => row._id) },
    published: true,
    processing: 'ready',
  })
    .select('id title artist categories genre year language duration coverUrl coverFileId playCount')
    .populate('artist', 'id name')
    .lean();
  const songsById = new Map(songs.map((song: any) => [String(song._id), song]));
  const rows = ranked
    .map((stats: any) => ({ song: songsById.get(String(stats._id)), stats }))
    .filter((row: any) => row.song);
  const categoryIds = [...new Set(rows.flatMap(({ song }: any) => song.categories ?? []).map(String))];
  const categories = categoryIds.length
    ? await Category.find({ _id: { $in: categoryIds } }).select('id name slug').lean()
    : [];
  const categoriesById = new Map(categories.map((category: any) => [String(category._id), category]));
  const categoryStats = new Map<string, { plays: number; listenedSeconds: number; songs: number }>();

  for (const { song, stats } of rows as any[]) {
    for (const categoryId of new Set<string>((song.categories ?? []).map((value: unknown) => String(value)))) {
      const current = categoryStats.get(categoryId) ?? { plays: 0, listenedSeconds: 0, songs: 0 };
      current.plays += stats.plays;
      current.listenedSeconds += stats.listenedSeconds;
      current.songs += 1;
      categoryStats.set(categoryId, current);
    }
  }

  return {
    days,
    since,
    songs: (rows as any[]).slice(0, limit).map(({ song, stats }) => ({
      id: song.id,
      title: song.title,
      artist: song.artist?.name ?? 'Unknown artist',
      categories: (song.categories ?? []).map((categoryId: unknown) => categoriesById.get(String(categoryId))?.name).filter(Boolean),
      genre: song.genre ?? null,
      year: song.year ?? null,
      language: song.language,
      duration: song.duration,
      coverUrl: song.coverUrl || (song.coverFileId ? `/api/v1/media/covers/${song._id}` : null),
      plays: stats.plays,
      completions: stats.completions,
      listenedSeconds: stats.listenedSeconds,
      listeners: stats.listeners.length,
      lastPlayedAt: stats.lastPlayedAt,
    })),
    categories: [...categoryStats.entries()]
      .map(([categoryId, stats]) => {
        const category: any = categoriesById.get(categoryId);
        return category ? { id: category.id, name: category.name, slug: category.slug, ...stats } : null;
      })
      .filter(Boolean)
      .sort((left: any, right: any) => right.plays - left.plays || right.listenedSeconds - left.listenedSeconds)
      .slice(0, 10),
  };
}

export async function getPopularSongs(limit = 10) {
  const songs = await Song.find({ published: true, processing: 'ready' })
    .sort({ playCount: -1, lastPlayedAt: -1, createdAt: -1 })
    .limit(limit)
    .select('id title artist categories genre year language duration coverUrl coverFileId playCount lastPlayedAt')
    .populate('artist', 'id name')
    .lean();
  const categoryIds = [...new Set(songs.flatMap((song: any) => song.categories ?? []).map(String))];
  const categories = categoryIds.length
    ? await Category.find({ _id: { $in: categoryIds } }).select('name').lean()
    : [];
  const categoryNames = new Map(categories.map((category: any) => [String(category._id), category.name]));
  return songs.map((song: any) => ({
    id: song.id,
    title: song.title,
    artist: song.artist?.name ?? 'Unknown artist',
    categories: (song.categories ?? []).map((categoryId: unknown) => categoryNames.get(String(categoryId))).filter(Boolean),
    genre: song.genre ?? null,
    year: song.year ?? null,
    language: song.language,
    duration: song.duration,
    coverUrl: song.coverUrl || (song.coverFileId ? `/api/v1/media/covers/${song._id}` : null),
    plays: song.playCount ?? 0,
    lastPlayedAt: song.lastPlayedAt ?? null,
  }));
}
