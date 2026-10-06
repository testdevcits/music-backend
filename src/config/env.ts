import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGO_URI: z.string().min(1),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('music-platform'),
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => /^rediss?:\/\//.test(value), 'Use redis:// or rediss://'),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('music-platform'),
  JWT_AUDIENCE: z.string().default('music-platform-app'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(209715200),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
});
export const env = schema
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && value.JWT_SECRET.startsWith('replace-with-')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'Replace the example signing secret before deployment',
      });
    }
  })
  .parse(process.env);
