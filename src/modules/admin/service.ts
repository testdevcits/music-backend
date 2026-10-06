import { env } from '../../config/env';
import { uploadCoverToCloudinary, uploadArtistImageToCloudinary, uploadAlbumCoverToCloudinary, uploadCategoryIconToCloudinary } from '../../infrastructure/cloudinary';
import { saveBuffer } from '../../infrastructure/media';
import { isQueuesEnabled, requireAudioQueue } from '../../infrastructure/queues';
import { ensure } from '../../shared/errors';
import { Album, Artist, Category, Song, Tag, Upload } from '../catalog/models';
export async function validateReferences(input: any) {
  for (const [key, Model] of [
    ['artist', Artist],
    ['album', Album],
    ['categories', Category],
    ['tags', Tag],
  ] as const) {
    if (input[key]) {
      const values = Array.isArray(input[key]) ? [...new Set(input[key])] : [input[key]];
      const count = await (Model as any).countDocuments({ _id: { $in: values } });
      ensure(count === values.length, 400, `INVALID_${key.toUpperCase()}`);
    }
  }
}

export async function ensureUniqueArtistName(name: string, excludeId?: string) {
  const query: Record<string, unknown> = { name };
  if (excludeId) query._id = { $ne: excludeId };
  const duplicate = await Artist.exists(query).collation({ locale: 'en', strength: 2 });
  ensure(!duplicate, 409, 'ARTIST_NAME_EXISTS');
}

const parseFields = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

function pickFirst(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === 'string' && candidate.trim() === '') continue;
    if (Array.isArray(candidate)) {
      const nested: unknown = pickFirst(...candidate);
      if (nested !== undefined) return nested;
      continue;
    }
    if (typeof candidate === 'object') {
      const nested: unknown = pickFirst(
        (candidate as { name?: unknown }).name,
        (candidate as { title?: unknown }).title,
        (candidate as { value?: unknown }).value,
      );
      if (nested !== undefined) return nested;
    }
    return candidate;
  }
  return undefined;
}

function normalizeImportedValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function toNumeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function allowListedRecord(record: Record<string, any>) {
  const allowed = new Set(parseFields(env.MUSIC_IMPORT_PERMITTED_FIELDS));
  const permitted: Record<string, any> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!allowed.has(key.toLowerCase())) continue;
    const normalized = normalizeImportedValue(value);
    if (normalized === undefined || normalized === null || normalized === '') continue;
    permitted[key] = normalized;
  }
  if (!env.MUSIC_IMPORT_ALLOW_AUDIO) delete permitted.url;
  if (!env.MUSIC_IMPORT_ALLOW_IMAGES) delete permitted.artwork;
  return permitted;
}

export async function searchMusicImport(query: string, provider = 'configured') {
  if (!env.MUSIC_IMPORT_PROVIDER_BASE_URL) {
    throw new Error('MUSIC_IMPORT_DISABLED');
  }
  const source = new URL(env.MUSIC_IMPORT_PROVIDER_BASE_URL);
  source.searchParams.set('q', query.trim());
  source.searchParams.set('provider', provider);
  const response = await fetch(source.toString(), {
    method: 'GET',
    headers: {
      ...(env.MUSIC_IMPORT_PROVIDER_TOKEN
        ? { Authorization: `Bearer ${env.MUSIC_IMPORT_PROVIDER_TOKEN}` }
        : {}),
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`IMPORT_PROVIDER_${response.status}`);
  }
  const payload = await response.json();
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.results)
        ? payload.results
        : [];
  return records.map((item: any, index: number) => {
    const externalSongId = String(pickFirst(item.externalSongId, item.external_id, item.id, item.songId, item.song_id, `${provider}-${index}`) ?? `${provider}-${index}`);
    const title = pickFirst(item.title, item.name, item.trackName, item.song, item.track?.title);
    const artist = pickFirst(item.artist, item.artistName, item.artist?.name, item.performer, item.artist?.title);
    const album = pickFirst(item.album, item.albumName, item.album?.name, item.release?.title, item.collectionName);
    const category = pickFirst(item.category, item.genre, item.genreName, item.categoryName, item.tags?.[0], item.categories?.[0]?.name);
    const language = pickFirst(item.language, item.lang, 'en') || 'en';
    const duration = toNumeric(pickFirst(item.duration, item.lengthSeconds, item.length, item.track?.duration));
    const year = toNumeric(pickFirst(item.year, item.releaseYear, item.album?.year, item.releasedAt?.slice(0, 4)));
    const artwork = pickFirst(item.artwork, item.coverArt, item.cover, item.image, item.albumArt, item.artworkUrl, item.imageUrl);
    const url = pickFirst(item.url, item.audioUrl, item.previewUrl, item.streamUrl, item.playbackUrl, item.fileUrl, item.mp3Url, item.trackUrl);
    const allowed = allowListedRecord({
      title,
      artist,
      album,
      category,
      language,
      duration,
      year,
      artwork,
      url,
      lyrics: pickFirst(item.lyrics, item.lyric, item.description),
      genre: category,
      format: pickFirst(item.format, item.fileType),
      bitrate: toNumeric(pickFirst(item.bitrate, item.audioBitrate)),
      externalSongId,
    });
    return {
      provider:
        provider === 'configured' ? 'configured' : provider,
      externalSongId,
      title: allowed.title,
      artist: allowed.artist,
      album: allowed.album,
      category: allowed.category,
      language: allowed.language,
      duration: allowed.duration,
      year: allowed.year,
      artwork: allowed.artwork,
      url: allowed.url,
      format: allowed.format,
      bitrate: allowed.bitrate,
      lyrics: allowed.lyrics,
      sourceLicense: item.license || 'provider-license-required',
      ...allowed,
    };
  });
}

export async function importMusicRecord(input: any) {
  const provider = String(input.provider || 'configured').trim() || 'configured';
  const externalSongId = String(input.externalSongId || input.id || '').trim();
  ensure(externalSongId, 400, 'IMPORT_ID_REQUIRED');
  ensure(!(await Song.exists({ provider, externalSongId })), 409, 'IMPORT_DUPLICATE');

  const artistName = String(input.artist || 'Unknown Artist').trim();
  const albumName = input.album ? String(input.album).trim() : undefined;
  const artist =
    (await Artist.findOne({ name: artistName })) ||
    (await Artist.create({ name: artistName }));

  let albumId: string | undefined;
  if (albumName) {
    const album =
      (await Album.findOne({ title: albumName, artist: artist._id })) ||
      (await Album.create({ title: albumName, artist: artist._id }));
    albumId = String(album._id);
  }

  const categoryIds: string[] = [];
  if (input.category) {
    const names = Array.isArray(input.category) ? input.category : [input.category];
    for (const rawCategory of names) {
      const categoryName = String(rawCategory).trim();
      if (!categoryName) continue;
      const slug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const category =
        (await Category.findOne({ slug })) ||
        (await Category.create({ name: categoryName, slug }));
      categoryIds.push(String(category._id));
    }
  }

  const record = {
    title: input.title || 'Untitled track',
    artist: artist._id,
    album: albumId,
    language: input.language || 'en',
    duration: input.duration ?? 0,
    genre: input.genre || input.category || undefined,
    year: input.year,
    trackNumber: input.trackNumber,
    discNumber: input.discNumber,
    format: input.format,
    bitrate: input.bitrate,
    artwork: input.artwork,
    url: input.url,
    coverUrl: input.artwork || input.coverUrl,
    coverPublicId: input.coverPublicId,
    lyrics: input.lyrics,
    categories: categoryIds,
    published: false,
    processing: 'pending',
    provider,
    externalSongId,
    sourceLicense: input.sourceLicense || 'provider-license-required',
    dateAdded: new Date(),
  };

  return Song.create(record);
}

export async function createUpload(
  songId: string,
  input: { kind: 'audio' | 'cover'; contentType: string; data: Buffer },
) {
  ensure(await Song.exists({ _id: songId }), 404, 'NOT_FOUND');
  const bytes = input.data.length;
  ensure(bytes <= env.MAX_UPLOAD_BYTES, 413, 'UPLOAD_TOO_LARGE');
  const allowed =
    input.kind === 'audio'
      ? ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/x-wav']
      : ['image/jpeg', 'image/png', 'image/webp'];
  ensure(allowed.includes(input.contentType), 400, 'UNSUPPORTED_CONTENT_TYPE');
  if (input.kind === 'cover') {
    ensure(bytes <= 10 * 1024 * 1024, 413, 'COVER_TOO_LARGE');
    const cloudinaryUpload = await uploadCoverToCloudinary(input.data, songId);
    if (cloudinaryUpload) {
      await Song.findByIdAndUpdate(songId, {
        $set: {
          coverUrl: cloudinaryUpload.url,
          coverPublicId: cloudinaryUpload.publicId,
          coverMime: input.contentType,
        },
      });
      return { uploadId: String(songId), status: 'completed', jobId: String(songId) };
    }
  } else {
    ensure(isQueuesEnabled(), 503, 'AUDIO_PROCESSING_REQUIRES_REDIS');
  }
  const fileId = await saveBuffer(input.data, `incoming-${songId}`, input.contentType);
  const upload = await Upload.create({
    song: songId,
    fileId,
    kind: input.kind,
    contentType: input.contentType,
    bytes,
    expiresAt: new Date(Date.now() + 600000),
  });
  await completeUpload(String(upload._id));
  return { uploadId: upload._id, status: 'queued', jobId: String(upload._id) };
}
export async function completeUpload(uploadId: string) {
  ensure(isQueuesEnabled(), 503, 'AUDIO_PROCESSING_REQUIRES_REDIS');
  const upload = await Upload.findById(uploadId);
  ensure(upload, 404, 'UPLOAD_NOT_FOUND');
  if (upload.completed) return { status: 'queued', jobId: String(upload._id) };
  const reservation = await Song.exists({
    _id: upload.song,
    processingUpload: String(upload._id),
  });
  ensure(upload.expiresAt! > new Date() || reservation, 410, 'UPLOAD_EXPIRED');
  if (upload.kind === 'audio') {
    const reserved = await Song.findOneAndUpdate(
      {
        _id: upload.song,
        audioVersion: { $ne: String(upload._id) },
        $or: [{ processingUpload: null }, { processingUpload: String(upload._id) }],
      },
      { $set: { processingUpload: String(upload._id) } },
    );
    if (!reserved) {
      const alreadyProcessed = await Song.exists({
        _id: upload.song,
        audioVersion: String(upload._id),
        processing: 'ready',
      });
      ensure(alreadyProcessed, 409, 'AUDIO_PROCESSING_IN_PROGRESS');
      await Upload.updateOne({ _id: upload._id }, { $set: { completed: true } });
      return { status: 'completed', jobId: String(upload._id) };
    }
  }
  // Queue before marking complete: a failed database write can safely be retried with the same job ID.
  await requireAudioQueue().add('process', { uploadId: String(upload._id) }, { jobId: String(upload._id) });
  await Upload.updateOne({ _id: upload._id }, { $set: { completed: true } });
  return { status: 'queued', jobId: String(upload._id) };
}

export async function uploadArtistImage(artistId: string, data: Buffer) {
  ensure(await Artist.exists({ _id: artistId }), 404, 'NOT_FOUND');
  const cloudinaryUpload = await uploadArtistImageToCloudinary(data, artistId);
  if (cloudinaryUpload) {
    await Artist.findByIdAndUpdate(artistId, {
      $set: {
        imageUrl: cloudinaryUpload.url,
        imagePublicId: cloudinaryUpload.publicId,
      },
    });
    return { status: 'completed', url: cloudinaryUpload.url };
  }
  throw new Error('UPLOAD_FAILED');
}

export async function uploadAlbumImage(albumId: string, data: Buffer) {
  ensure(await Album.exists({ _id: albumId }), 404, 'NOT_FOUND');
  const cloudinaryUpload = await uploadAlbumCoverToCloudinary(data, albumId);
  if (cloudinaryUpload) {
    await Album.findByIdAndUpdate(albumId, {
      $set: {
        coverUrl: cloudinaryUpload.url,
        coverPublicId: cloudinaryUpload.publicId,
      },
    });
    return { status: 'completed', url: cloudinaryUpload.url };
  }
  throw new Error('UPLOAD_FAILED');
}

export async function uploadCategoryImage(categoryId: string, data: Buffer) {
  ensure(await Category.exists({ _id: categoryId }), 404, 'NOT_FOUND');
  const cloudinaryUpload = await uploadCategoryIconToCloudinary(data, categoryId);
  if (cloudinaryUpload) {
    await Category.findByIdAndUpdate(categoryId, {
      $set: {
        imageUrl: cloudinaryUpload.url,
        imagePublicId: cloudinaryUpload.publicId,
      },
    });
    return { status: 'completed', url: cloudinaryUpload.url };
  }
  throw new Error('UPLOAD_FAILED');
}
