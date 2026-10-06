import { RequestHandler } from 'express';
import { z } from 'zod';
import { id, quality } from '../../shared/validation';
import { streamFile } from '../../infrastructure/media';
import { recordEvent, stream, streamingFile } from './service';
export const postStreamingSongId: RequestHandler = async (req, res) => {
  const input = z
    .object({ quality: quality.default('64') })
    .strict()
    .parse(req.body);
  res
    .set('Cache-Control', 'no-store')
    .json(await stream(req.auth.userId, id.parse(req.params.songId), input.quality));
};
export const postStreamingSessionsIdEvents: RequestHandler = async (req, res) => {
  const input = z
    .object({
      sequence: z.number().int().positive(),
      type: z.enum(['play', 'pause', 'skip', 'completion', 'heartbeat']),
      seconds: z.number().min(0).max(60),
    })
    .strict()
    .parse(req.body);
  res.status(201).json(await recordEvent(req.auth.userId, id.parse(req.params.id), input));
};
export const getStreamingSessionsIdAudio: RequestHandler = async (req, res) => {
  const media = await streamingFile(req.auth.userId, id.parse(req.params.id));
  streamFile(media.fileId, media.mime, res);
};
