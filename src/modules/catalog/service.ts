import { ensure } from '../../shared/errors';
import { License, Song } from './models';
import { songId as songIdSchema } from '../../shared/validation';

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
