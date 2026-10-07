import type { Request } from 'express';

/**
 * Resolve a country only from a trusted source. Vercel overwrites its edge
 * country header; local development can opt in with X-Dev-Country.
 */
export function requestCountry(req: Request): string | undefined {
  const value = process.env.VERCEL === '1'
    ? req.get('x-vercel-ip-country')
    : process.env.NODE_ENV !== 'production'
      ? req.get('x-dev-country')
      : undefined;
  const country = value?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : undefined;
}
