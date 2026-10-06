import mongoose from 'mongoose';
import { ensure } from '../../shared/errors';
import { policy } from '../billing/service';
import { availableSong } from '../catalog/service';
import { ListeningEvent, PlaybackSession } from './models';
export function allowedListeningDelta(state: string, elapsed: number, claimed: number) {
  return ['play', 'heartbeat'].includes(state) ? Math.min(claimed, Math.max(0, elapsed), 60) : 0;
}
export async function stream(user: string, songId: string, quality: string) {
  const { song, license }: any = await availableSong(songId);
  const p: any = await policy(user);
  const preferredQuality = (p.qualities ?? []).includes(quality) ? quality : (p.qualities ?? [])[0];
  ensure(preferredQuality, 403, 'PLAN_RESTRICTED');
  const audio = (song.audio ?? []).find((a: any) => a.quality === preferredQuality) ??
    (song.audio ?? []).find((a: any) => a.url);
  ensure(audio && (song.audio ?? []).some((a: any) => a.quality === preferredQuality) || audio?.url, 403, 'PLAN_RESTRICTED');
  const selectedQuality = audio.quality;
  ensure(audio?.fileId || audio?.url, 409, 'QUALITY_UNAVAILABLE');
  const session: any = await PlaybackSession.create({
    user,
    song: songId,
    quality: selectedQuality,
    expiresAt: new Date(Math.min(Date.now() + 4 * 3600000, license.endsAt!.getTime())),
  });
  return {
    url: `/api/v1/streaming/sessions/${session._id}/audio`,
    sessionId: session._id,
    quality: selectedQuality,
    duration: song.duration,
  };
}
export async function streamingFile(user: string, sessionId: string) {
  const session: any = await PlaybackSession.findOne({
    _id: sessionId,
    user,
    expiresAt: { $gt: new Date() },
  });
  ensure(session, 404, 'SESSION_UNAVAILABLE');
  const { song }: any = await availableSong(String(session.song));
  const audio = (song.audio ?? []).find((item: any) => item.quality === session.quality);
  ensure(audio?.fileId || audio?.url, 409, 'QUALITY_UNAVAILABLE');
  return { fileId: audio.fileId, url: audio.url, mime: audio.mime || 'audio/mpeg' };
}
export async function recordEvent(
  user: string,
  sessionId: string,
  input: { sequence: number; type: string; seconds: number },
) {
  return mongoose.connection.transaction(async (session) => {
    const playback: any = await PlaybackSession.findOne({
      _id: sessionId,
      user,
      expiresAt: { $gt: new Date() },
    }).session(session);
    ensure(playback, 404, 'SESSION_UNAVAILABLE');
    const prior = await ListeningEvent.findOne({
      session: sessionId,
      sequence: input.sequence,
    }).session(session);
    if (prior) return prior;
    ensure(input.sequence === playback.lastSequence! + 1, 409, 'EVENT_SEQUENCE_MISMATCH');
    ensure(!['skip', 'completion'].includes(playback.state!), 409, 'SESSION_ENDED');
    const seconds = allowedListeningDelta(
      playback.state!,
      (Date.now() - playback.lastEventAt!.getTime()) / 1000,
      input.seconds,
    );
    const changed = await PlaybackSession.updateOne(
      { _id: sessionId, lastSequence: playback.lastSequence },
      {
        $set: { lastSequence: input.sequence, lastEventAt: new Date(), state: input.type },
        $inc: { listenedSeconds: seconds },
      },
      { session },
    );
    ensure(changed.modifiedCount, 409, 'EVENT_SEQUENCE_MISMATCH');
    const [event] = await ListeningEvent.create(
      [{ ...input, seconds, user, song: playback.song, session: sessionId }],
      { session },
    );
    return event;
  });
}
