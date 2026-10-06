import { env } from '../../config/env';
import { saveBuffer } from '../../infrastructure/media';
import { queuesEnabled, requireAudioQueue } from '../../infrastructure/queues';
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
export async function createUpload(
  songId: string,
  input: { kind: 'audio' | 'cover'; contentType: string; data: Buffer },
) {
  ensure(queuesEnabled, 503, 'AUDIO_PROCESSING_REQUIRES_REDIS');
  ensure(await Song.exists({ _id: songId }), 404, 'NOT_FOUND');
  const bytes = input.data.length;
  ensure(bytes <= env.MAX_UPLOAD_BYTES, 413, 'UPLOAD_TOO_LARGE');
  const allowed =
    input.kind === 'audio'
      ? ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/x-wav']
      : ['image/jpeg', 'image/png', 'image/webp'];
  ensure(allowed.includes(input.contentType), 400, 'UNSUPPORTED_CONTENT_TYPE');
  if (input.kind === 'cover') ensure(bytes <= 10 * 1024 * 1024, 413, 'COVER_TOO_LARGE');
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
  ensure(queuesEnabled, 503, 'AUDIO_PROCESSING_REQUIRES_REDIS');
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
