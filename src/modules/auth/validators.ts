import { z } from 'zod';
export const credentials = z
  .object({
    email: z
      .string()
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z
      .string()
      .min(8)
      .max(72)
      .refine((v) => Buffer.byteLength(v) <= 72, 'Password exceeds 72 bytes'),
  })
  .strict();
export const registration = credentials.extend({ name: z.string().trim().min(1).max(100) });
export const refreshInput = z.object({ refreshToken: z.string().min(40).max(200) }).strict();
