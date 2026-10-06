import type { Response } from 'express';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { ensure } from '../shared/errors';

function bucket() {
  ensure(mongoose.connection.db, 503, 'DATABASE_UNAVAILABLE');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'media' });
}

export async function saveBuffer(data: Buffer, filename: string, contentType: string) {
  const upload = bucket().openUploadStream(filename, { contentType });
  await pipeline(Readable.from(data), upload);
  return String(upload.id);
}

export async function saveFile(path: string, filename: string, contentType: string) {
  const upload = bucket().openUploadStream(filename, { contentType });
  await pipeline(createReadStream(path), upload);
  return { fileId: String(upload.id), bytes: (await stat(path)).size };
}

export async function downloadToPath(fileId: string, path: string, maxBytes: number) {
  let total = 0;
  const bound = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > maxBytes ? new Error('Media file exceeds allowed size') : null, chunk);
    },
  });
  await pipeline(
    bucket().openDownloadStream(new mongoose.Types.ObjectId(fileId)),
    bound,
    createWriteStream(path),
  );
}

export function streamFile(fileId: string, contentType: string, res: Response) {
  const source = bucket().openDownloadStream(new mongoose.Types.ObjectId(fileId));
  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'none',
  });
  source.on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: { code: 'MEDIA_NOT_FOUND' } });
    else res.destroy();
  });
  source.pipe(res);
}
