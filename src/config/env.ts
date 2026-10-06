import 'dotenv/config';
import { z } from 'zod';

const optionalRedisUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => /^rediss?:\/\//.test(value), 'Use redis:// or rediss://')
    .optional(),
);

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGO_URI: z.string().min(1),
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('music-platform'),
  REDIS_URL: optionalRedisUrl,
  BACKGROUND_JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('music-platform'),
  JWT_AUDIENCE: z.string().default('music-platform-app'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(209715200),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  MUSIC_IMPORT_PROVIDER_BASE_URL: optionalText,
  MUSIC_IMPORT_PROVIDER_TOKEN: optionalText,
  MUSIC_IMPORT_PERMITTED_FIELDS: z.string().default('title,artist,album,genre,year,duration,language,artwork,url,category,lyrics'),
  MUSIC_IMPORT_ALLOW_AUDIO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MUSIC_IMPORT_ALLOW_IMAGES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  CLOUDINARY_CLOUD_NAME: optionalText,
  CLOUDINARY_API_KEY: optionalText,
  CLOUDINARY_API_SECRET: optionalText,
});
const parseEnvironment = () =>
  schema.superRefine((value, context) => {
    if (value.BACKGROUND_JOBS_ENABLED && !value.REDIS_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when BACKGROUND_JOBS_ENABLED=true',
      });
    }
    if (
      [value.CLOUDINARY_CLOUD_NAME, value.CLOUDINARY_API_KEY, value.CLOUDINARY_API_SECRET].some(
        Boolean,
      ) &&
      !(
        value.CLOUDINARY_CLOUD_NAME &&
        value.CLOUDINARY_API_KEY &&
        value.CLOUDINARY_API_SECRET
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CLOUDINARY_CLOUD_NAME'],
        message:
          'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must all be set together',
      });
    }
    if (value.NODE_ENV === 'production' && value.JWT_SECRET.startsWith('replace-with-')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'Replace the example signing secret before deployment',
      });
    }
  }).parse(process.env);

export const env = new Proxy({} as Record<string, unknown>, {
  get: (_target, property) => {
    const value = parseEnvironment();
    return value[property as keyof typeof value];
  },
  has: (_target, property) => {
    const value = parseEnvironment();
    return property in value;
  },
  ownKeys: () => Object.keys(parseEnvironment()),
  getOwnPropertyDescriptor: (_target, property) => {
    const value = parseEnvironment();
    if (!(property in value)) return undefined;
    return {
      enumerable: true,
      configurable: true,
      value: value[property as keyof typeof value],
    };
  },
});
