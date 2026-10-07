import { z } from 'zod';
import { id, name } from '../../shared/validation';
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
const mediaUrl = z.string().url().max(2000);

export const artistInput = z.object({
  name,
  bio: z.string().max(10000).optional(),
  imageUrl: mediaUrl.optional(),
  imagePublicId: z.string().max(500).optional(),
}).strict();

export const albumInput = z.object({
  title: name,
  artist: id,
  releaseDate: z.coerce.date().optional(),
  coverUrl: mediaUrl.optional(),
  coverPublicId: z.string().max(500).optional(),
}).strict();

export const categoryInput = z.object({
  name,
  slug,
  parent: id.nullable().default(null),
  imageUrl: mediaUrl.optional(),
  imagePublicId: z.string().max(500).optional(),
}).strict();

export const tagInput = z.object({ name, slug }).strict();
const nullableTimestamp = z
  .union([z.number().int().min(0), z.string().datetime(), z.coerce.date()])
  .nullable()
  .optional();
export const songInput = z
  .object({
    title: name,
    artist: id,
    album: id.optional(),
    language: z.string().min(2).max(50),
    lyrics: z.string().max(50000).optional(),
    duration: z.number().int().min(0).max(86400).optional(),
    genre: z.string().max(100).optional(),
    year: z.number().int().min(1900).max(2100).optional(),
    trackNumber: z.number().int().min(1).max(500).optional(),
    discNumber: z.number().int().min(1).max(20).optional(),
    format: z.string().max(20).optional(),
    bitrate: z.number().int().min(1).max(2000).optional(),
    artwork: mediaUrl.optional(),
    url: mediaUrl.optional(),
    sourceUrl: mediaUrl.optional(),
    sourceLicense: z.string().max(500).optional(),
    rightsHolder: z.string().max(200).optional(),
    coverUrl: mediaUrl.optional(),
    coverPublicId: z.string().max(500).optional(),
    isFavorite: z.boolean().optional(),
    playCount: z.number().int().min(0).max(10000000).optional(),
    lastPlayedAt: nullableTimestamp,
    dateAdded: nullableTimestamp,
    categories: z.array(id).max(30).default([]),
    tags: z.array(id).max(50).default([]),
  })
  .strict();
export const planInput = z
  .object({
    name,
    slug,
    priceMinor: z.number().int().min(0),
    currency: z.string().length(3),
    offlineLimit: z.number().int().min(0).max(10000),
    deviceLimit: z.number().int().min(1).max(100),
    offlineDays: z.number().int().min(1).max(90),
    qualities: z.array(z.enum(['64', '128', '192'])).min(1),
    active: z.boolean().default(true),
  })
  .strict();
export const licenseInput = z
  .object({
    song: id,
    holder: name,
    reference: z.string().max(500).optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    streaming: z.boolean(),
    offline: z.boolean(),
    source: z.enum(['artist', 'label', 'provider', 'public-domain', 'creative-commons', 'other']).default('other'),
    licenseName: z.string().trim().max(200).optional(),
    evidenceUrl: mediaUrl.optional(),
    documentReference: z.string().trim().max(500).optional(),
    inAppStreaming: z.boolean().default(false),
    audioHosting: z.boolean().default(false),
    commercialUse: z.boolean().default(false),
    artworkUse: z.boolean().default(false),
    lyricsUse: z.boolean().default(false),
    verificationStatus: z.enum(['pending', 'verified', 'rejected']).default('pending'),
    verificationNotes: z.string().trim().max(2000).optional(),
    territories: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(250)
      .default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.endsAt > v.startsAt, 'endsAt must be after startsAt')
  .refine(
    (v) => v.verificationStatus !== 'verified' || Boolean(v.evidenceUrl || v.documentReference),
    'Verified licenses must include an evidence URL or document reference',
  )
  .refine(
    (v) => v.verificationStatus !== 'verified' || (v.streaming && v.inAppStreaming && v.audioHosting && v.commercialUse),
    'Verified streaming licenses must explicitly allow streaming, in-app playback, audio hosting, and commercial use',
  );
