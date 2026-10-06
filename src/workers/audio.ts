import { Job } from 'bullmq';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../config/env';
import { normalizeCover, probeAudio, transcode } from '../infrastructure/ffmpeg';
import { downloadToPath, saveFile } from '../infrastructure/media';
import { Song, Upload } from '../modules/catalog/models';
import { ensure } from '../shared/errors';
export async function processAudio(job: Job<{ uploadId: string }>) {
  const upload = await Upload.findById(job.data.uploadId);
  ensure(upload, 404, 'UPLOAD_MISSING');
  const song = await Song.findById(upload.song);
  ensure(song, 404, 'SONG_MISSING');
  const version = String(upload._id);
  if (upload.kind === 'audio' && song.audioVersion === version && song.processing === 'ready')
    return;
  if (upload.kind === 'audio') {
    const reserved = await Song.findOneAndUpdate(
      { _id: song._id, $or: [{ processingUpload: null }, { processingUpload: version }] },
      { $set: { processingUpload: version } },
    );
    ensure(reserved, 409, 'AUDIO_PROCESSING_IN_PROGRESS');
  }
  const dir = await mkdtemp(join(tmpdir(), 'music-'));
  const source = join(dir, 'source');
  try {
    await downloadToPath(upload.fileId!, source, Math.min(upload.bytes!, env.MAX_UPLOAD_BYTES));
    ensure((await stat(source)).size === upload.bytes, 400, 'SIZE_MISMATCH');
    if (upload.kind === 'cover') {
      const output = join(dir, 'cover.jpg');
      await normalizeCover(source, output);
      const { fileId } = await saveFile(output, `cover-${song._id}-${version}.jpg`, 'image/jpeg');
      await Song.updateOne(
        { _id: song._id },
        { $set: { coverFileId: fileId, coverMime: 'image/jpeg' } },
      );
      return;
    }
    await Song.updateOne(
      { _id: song._id },
      { $set: { processing: 'processing', published: false } },
    );
    const duration = await probeAudio(source);
    const audio = [];
    for (const quality of ['64', '128', '192']) {
      const output = join(dir, `${quality}.mp3`);
      await transcode(source, output, quality);
      const { fileId, bytes } = await saveFile(
        output,
        `audio-${song._id}-${version}-${quality}.mp3`,
        'audio/mpeg',
      );
      audio.push({ quality, fileId, bytes, mime: 'audio/mpeg' });
      await job.updateProgress((audio.length / 3) * 100);
    }
    await Song.updateOne(
      { _id: song._id },
      {
        $set: {
          audio,
          duration,
          audioVersion: version,
          sourceFileId: upload.fileId,
          processing: 'ready',
          processingUpload: null,
          published: false,
        },
      },
    );
  } catch (error) {
    if (upload.kind === 'audio')
      await Song.updateOne(
        { _id: song._id },
        { $set: { processing: 'failed', processingUpload: null, published: false } },
      );
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
