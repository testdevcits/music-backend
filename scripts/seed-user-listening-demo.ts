import { Types } from 'mongoose';
import { connect, disconnect } from '../src/infrastructure/connections';
import { User } from '../src/modules/auth/models';
import { Song } from '../src/modules/catalog/models';
import { ListeningEvent, PlaybackSession } from '../src/modules/playback/models';

async function main() {
  if (process.env.DEMO_LISTENING_SEED_CONFIRM !== 'YES') {
    throw new Error('Set DEMO_LISTENING_SEED_CONFIRM=YES to confirm demo activity will be written.');
  }
  const email = process.env.DEMO_USER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Set DEMO_USER_EMAIL to an existing user email.');

  await connect();
  const user = await User.findOne({ email }).select('_id email name');
  if (!user) throw new Error('No user found for DEMO_USER_EMAIL.');
  const songs = await Song.find({ published: true, processing: 'ready' }).sort({ createdAt: 1 }).limit(100).select('_id duration');
  if (!songs.length) throw new Error('Publish at least one ready song before creating demo listening activity.');

  const now = Date.now();
  let sessionCount = 0;
  const eventRows: Array<Record<string, unknown>> = [];
  for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
    const date = new Date(now - dayOffset * 86400000);
    date.setUTCHours([7, 12, 20][dayOffset % 3], 15, 0, 0);
    const song = songs[(13 - dayOffset) % songs.length];
    const sessionId = new Types.ObjectId();
    const listenedSeconds = Math.min(55 + ((dayOffset * 17) % 150), Math.max(55, song.duration || 180));
    const createdAt = date;
    await PlaybackSession.create({
      _id: sessionId,
      user: user._id,
      song: song._id,
      quality: '192',
      expiresAt: new Date(now + 30 * 86400000),
      lastSequence: 2,
      listenedSeconds,
      lastEventAt: createdAt,
      state: 'heartbeat',
      createdAt,
      updatedAt: createdAt,
    });
    const first = new Date(createdAt.getTime() + 1000);
    const second = new Date(createdAt.getTime() + 60000);
    eventRows.push(
      { _id: new Types.ObjectId(), user: user._id, song: song._id, session: sessionId, sequence: 1, type: 'play', seconds: 0, createdAt: first, updatedAt: first },
      { _id: new Types.ObjectId(), user: user._id, song: song._id, session: sessionId, sequence: 2, type: 'heartbeat', seconds: listenedSeconds, createdAt: second, updatedAt: second },
    );
    sessionCount += 1;
  }
  await ListeningEvent.insertMany(eventRows, { ordered: true });
  console.log(`Added ${eventRows.length} demo listening events across ${sessionCount} sessions for ${user.email}, using ${songs.length} published song(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(disconnect);
