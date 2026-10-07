import fs from 'node:fs/promises';
import path from 'node:path';
import { connect, disconnect } from '../src/infrastructure/connections';
import { saveBuffer } from '../src/infrastructure/media';
import { Artist, Category, License, Song, Tag } from '../src/modules/catalog/models';

type PixabayRow = {
  id: number;
  name?: string;
  duration?: number;
  uploadDate?: string;
  href?: string;
  description?: string;
  tagList?: string[][];
  user?: { username?: string; firstName?: string; lastName?: string };
};

function testWave(seed: number, seconds = 12) {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  const frequency = 220 + (seed % 12) * 22;
  for (let i = 0; i < dataSize; i += 1) {
    const fade = Math.min(1, i / 500, (dataSize - i) / 500);
    wav[44 + i] = Math.max(0, Math.min(255, Math.round(128 + 24 * fade * Math.sin((2 * Math.PI * frequency * i) / sampleRate))));
  }
  return wav;
}

function slug(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'devotional';
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('This local test seed cannot run in production.');
  if (process.env.PIXABAY_TEST_AUDIO_SEED_CONFIRM !== 'YES') {
    throw new Error('Set PIXABAY_TEST_AUDIO_SEED_CONFIRM=YES to create local synthetic test tracks.');
  }
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Pass the path to the user-provided Pixabay JSON snapshot.');
  const snapshot = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8'));
  const page = snapshot?.page;
  const rows: PixabayRow[] = page?.results;
  if (page?.query !== 'bhajan' || !Array.isArray(rows) || rows.length === 0) {
    throw new Error('Expected the supplied Pixabay bhajan search snapshot with page.results.');
  }
  await connect();

  const category = await Category.findOne({ slug: 'hindi-devotional' });
  if (!category) throw new Error('Run seed:devotional-catalog first to create devotional categories.');
  const testTag = await Tag.findOneAndUpdate(
    { slug: 'local-synthetic-test-audio' },
    { $setOnInsert: { name: 'Local Synthetic Test Audio', slug: 'local-synthetic-test-audio' } },
    { upsert: true, new: true },
  );
  let created = 0;
  let existing = 0;
  let readyCount = 0;

  for (const row of rows) {
    if (!row.id || !row.name?.trim() || !row.user?.username) continue;
    const artistName = [row.user.firstName, row.user.lastName].filter(Boolean).join(' ').trim() || row.user.username;
    let artist: any = await Artist.findOne({ name: artistName }).collation({ locale: 'en', strength: 2 });
    if (!artist) artist = await Artist.create({ name: artistName, bio: `Pixabay uploader attribution from a user-provided metadata snapshot; ownership not independently verified.` });
    const externalSongId = String(row.id);
    const identity = { provider: 'pixabay-metadata-test', externalSongId };
    let song: any = await Song.findOne(identity);
    if (song) {
      existing += 1;
    } else {
      const sourceUrl = row.href ? new URL(row.href, 'https://pixabay.com').toString() : undefined;
      song = await Song.create({
        ...identity,
        title: row.name.trim(),
        artist: artist._id,
        language: /hindi|\bhindi\b/i.test(`${row.name} ${row.description ?? ''}`) ? 'Hindi' : 'Not specified',
        duration: 12,
        year: row.uploadDate ? new Date(row.uploadDate).getUTCFullYear() : undefined,
        genre: 'Devotional',
        format: 'wav',
        bitrate: 64,
        sourceUrl,
        sourceLicense: `Pixabay metadata only; original recording not imported or rights-verified. Synthetic 12-second local test WAV. Original listed duration: ${row.duration ?? 'unknown'} seconds.`,
        rightsHolder: 'Music Platform local synthetic test audio generator',
        categories: [category._id],
        tags: [testTag._id],
        published: false,
        processing: 'pending',
        audio: [],
      });
    }

    if (!song.audio?.length) {
      const audioBuffer = testWave(row.id);
      const fileId = await saveBuffer(audioBuffer, `local-test-${row.id}.wav`, 'audio/wav');
      song.audio = [{ quality: '64', fileId, bytes: audioBuffer.length, mime: 'audio/wav' }];
    }
    song.processing = 'ready';
    song.published = true;
    await song.save();

    await License.findOneAndUpdate(
      { song: song._id },
      {
        $set: {
          song: song._id,
          holder: 'Music Platform local synthetic test audio generator',
          reference: 'LOCAL_SYNTHETIC_TEST_AUDIO_V1',
          documentReference: 'LOCAL_SYNTHETIC_TEST_AUDIO_V1',
          startsAt: new Date('2020-01-01T00:00:00.000Z'),
          endsAt: new Date('2099-12-31T23:59:59.000Z'),
          streaming: true,
          offline: false,
          territories: [],
          enabled: true,
          source: 'other',
          licenseName: 'Internal local synthetic test audio only',
          inAppStreaming: true,
          audioHosting: true,
          commercialUse: true,
          artworkUse: false,
          lyricsUse: false,
          verificationStatus: 'verified',
          verificationNotes: 'Applies only to the generated synthetic WAV, not to the Pixabay recording or composition represented by its metadata.',
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    created += 1;
    readyCount += 1;
  }
  console.log(`Prepared ${readyCount} playable synthetic local test tracks (${created} imported/updated; ${existing} songs already existed). Original Pixabay audio was not downloaded.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(disconnect);
