import { z } from 'zod';
import { id, name } from '../../shared/validation';
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
export const artistInput = z.object({ name, bio: z.string().max(10000).optional() }).strict();
export const albumInput = z
  .object({ title: name, artist: id, releaseDate: z.coerce.date().optional() })
  .strict();
export const categoryInput = z.object({ name, slug, parent: id.nullable().default(null) }).strict();
export const tagInput = z.object({ name, slug }).strict();
export const songInput = z
  .object({
    title: name,
    artist: id,
    album: id.optional(),
    language: z.string().min(2).max(50),
    lyrics: z.string().max(50000).optional(),
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
    territories: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(250)
      .default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.endsAt > v.startsAt, 'endsAt must be after startsAt');
