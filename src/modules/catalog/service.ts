import { ensure } from '../../shared/errors';
import { License, Song } from './models';
export async function availableSong(songId: string, offline = false) {
  const song = await Song.findOne({ _id: songId, published: true, processing: 'ready' });
  ensure(song, 404, 'SONG_UNAVAILABLE');
  const license = await License.findOne({
    song: songId,
    enabled: true,
    startsAt: { $lte: new Date() },
    endsAt: { $gt: new Date() },
    streaming: true,
    ...(offline ? { offline: true } : {}),
  });
  ensure(license, 403, 'LICENSE_UNAVAILABLE');
  // Fail closed for territorial licenses until a trusted edge geolocation integration is configured.
  ensure(license.territories.length === 0, 403, 'TERRITORY_VERIFICATION_REQUIRED');
  return { song, license };
}
export async function songView(song: any) {
  const value = typeof song.toObject === 'function' ? song.toObject() : { ...song };
  const qualities = (value.audio ?? []).map((a: any) => a.quality);
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
