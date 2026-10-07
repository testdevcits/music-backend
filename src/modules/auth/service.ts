import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError, ensure } from '../../shared/errors';
import { allocateUserPublicId, RefreshSession, User } from './models';

type AuthUserDoc = {
  _id?: mongoose.Types.ObjectId | string;
  passwordHash?: string | null;
  disabled?: boolean;
};

type RefreshSessionDoc = {
  _id?: mongoose.Types.ObjectId | string;
  user?: mongoose.Types.ObjectId | string;
  family?: string;
  tokenHash?: string;
  expiresAt?: Date | string;
  revokedAt?: Date | string | null;
};

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
function access(user: string) {
  return jwt.sign({}, env.JWT_SECRET, {
    subject: user,
    expiresIn: '15m',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithm: 'HS256',
  });
}
export async function issue(
  user: string,
  family: string = randomUUID(),
  session?: mongoose.ClientSession,
) {
  const refreshToken = randomBytes(48).toString('base64url');
  await RefreshSession.create(
    [
      {
        user,
        family,
        tokenHash: hash(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    ],
    { session },
  );
  return { accessToken: access(user), refreshToken, expiresIn: 900 };
}
export async function register(input: { email: string; password: string; name: string }) {
  let user: any;
  try {
    user = await User.create({
      email: input.email,
      publicId: await allocateUserPublicId(),
      name: input.name,
      role: 'user',
      passwordHash: await bcrypt.hash(input.password, 12),
    });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED');
    throw error;
  }
  return issue(String(user?._id ?? user?.id));
}
const dummyHash = bcrypt.hashSync('dummy password never usable', 12);
export async function login(input: { email: string; password: string }) {
  const user = (await User.findOne({ email: input.email }).select('+passwordHash')) as AuthUserDoc | null;
  const passwordHash = user?.passwordHash ?? dummyHash;
  const valid = await bcrypt.compare(input.password, passwordHash);
  ensure(user && valid && !user.disabled, 401, 'INVALID_CREDENTIALS');
  return issue(String(user._id));
}

type GoogleClaims = {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  exp?: number;
  iat?: number;
};
type GoogleJwk = JsonWebKey & { kid: string; alg?: string; use?: string };
let googleKeys: GoogleJwk[] = [];
let googleKeysExpireAt = 0;

async function googleSigningKey(kid: string) {
  if (Date.now() >= googleKeysExpireAt || !googleKeys.some((key) => key.kid === kid)) {
    let response: Response;
    try {
      response = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new ApiError(503, 'GOOGLE_KEYS_UNAVAILABLE');
    }
    ensure(response.ok, 503, 'GOOGLE_KEYS_UNAVAILABLE');
    const body = await response.json() as { keys?: GoogleJwk[] };
    ensure(Array.isArray(body.keys), 503, 'GOOGLE_KEYS_UNAVAILABLE');
    googleKeys = body.keys;
    const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300);
    googleKeysExpireAt = Date.now() + Math.min(Math.max(maxAge, 60), 3600) * 1000;
  }
  const key = googleKeys.find((candidate) => candidate.kid === kid && candidate.kty === 'RSA' && (!candidate.alg || candidate.alg === 'RS256'));
  ensure(key, 401, 'INVALID_GOOGLE_CREDENTIAL');
  return key;
}

async function verifyGoogleIdToken(idToken: string): Promise<GoogleClaims> {
  ensure(env.GOOGLE_CLIENT_ID, 503, 'GOOGLE_LOGIN_NOT_CONFIGURED');
  try {
    const parts = idToken.split('.');
    ensure(parts.length === 3, 401, 'INVALID_GOOGLE_CREDENTIAL');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as GoogleClaims;
    ensure(header.alg === 'RS256' && typeof header.kid === 'string', 401, 'INVALID_GOOGLE_CREDENTIAL');
    const key = await googleSigningKey(header.kid);
    const verified = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
    const audience = Array.isArray(claims.aud)
      ? claims.aud.includes(env.GOOGLE_CLIENT_ID) && (claims.aud.length === 1 || claims.azp === env.GOOGLE_CLIENT_ID)
      : claims.aud === env.GOOGLE_CLIENT_ID;
    const now = Math.floor(Date.now() / 1000);
    ensure(verified && ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss || ''), 401, 'INVALID_GOOGLE_CREDENTIAL');
    ensure(audience && typeof claims.exp === 'number' && claims.exp > now, 401, 'INVALID_GOOGLE_CREDENTIAL');
    ensure(typeof claims.iat === 'number' && claims.iat <= now + 300, 401, 'INVALID_GOOGLE_CREDENTIAL');
    ensure(typeof claims.sub === 'string' && claims.sub.length > 0, 401, 'INVALID_GOOGLE_CREDENTIAL');
    ensure(typeof claims.email === 'string' && claims.email_verified === true, 401, 'GOOGLE_EMAIL_NOT_VERIFIED');
    return claims;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, 'INVALID_GOOGLE_CREDENTIAL');
  }
}

export async function loginWithGoogle(idToken: string) {
  const claims = await verifyGoogleIdToken(idToken);
  const email = claims.email!.toLowerCase();
  let user: any = await User.findOne({ googleSub: claims.sub }).select('+googleSub');
  if (!user) {
    user = await User.findOne({ email }).select('+googleSub');
    if (user) {
      ensure(!user.googleSub || user.googleSub === claims.sub, 409, 'GOOGLE_ACCOUNT_CONFLICT');
      user.googleSub = claims.sub;
      if (claims.picture && !user.image) user.image = { url: claims.picture, alt: claims.name || user.name };
      if (claims.name && user.name === email) user.name = claims.name.slice(0, 100);
      await user.save();
    } else {
      try {
        user = await User.create({
          email,
          publicId: await allocateUserPublicId(),
          googleSub: claims.sub,
          name: (claims.name || email.split('@')[0]).slice(0, 100),
          image: claims.picture ? { url: claims.picture, alt: claims.name || 'Profile image' } : null,
          role: 'user',
        });
      } catch (error) {
        if ((error as { code?: number })?.code !== 11000) throw error;
        user = await User.findOne({ $or: [{ googleSub: claims.sub }, { email }] }).select('+googleSub');
        ensure(user && (!user.googleSub || user.googleSub === claims.sub), 409, 'GOOGLE_ACCOUNT_CONFLICT');
        if (!user.googleSub) {
          user.googleSub = claims.sub;
          await user.save();
        }
      }
    }
  }
  ensure(user && !user.disabled, 401, 'INVALID_CREDENTIALS');
  return issue(String(user._id));
}
export async function rotate(token: string) {
  const old = (await RefreshSession.findOne({ tokenHash: hash(token) })) as RefreshSessionDoc | null;
  const expiresAt = old?.expiresAt ? new Date(old.expiresAt) : null;
  ensure(old && expiresAt && expiresAt > new Date(), 401, 'INVALID_REFRESH_TOKEN');
  if (old?.revokedAt) {
    await RefreshSession.updateMany({ family: old.family }, { $set: { revokedAt: new Date() } });
    throw new ApiError(401, 'REFRESH_REUSE_DETECTED');
  }
  const user = (await User.findById(old.user)) as AuthUserDoc | null;
  ensure(user && !user.disabled, 401, 'INVALID_REFRESH_TOKEN');
  return mongoose.connection.transaction(async (session) => {
    const consumed = await RefreshSession.findOneAndUpdate(
      { _id: old._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session, new: true },
    );
    ensure(consumed, 401, 'INVALID_REFRESH_TOKEN');
    return issue(String(old.user), old.family ?? randomUUID(), session);
  });
}
export async function logout(token: string) {
  const old = (await RefreshSession.findOne({ tokenHash: hash(token) })) as RefreshSessionDoc | null;
  if (old)
    await RefreshSession.updateMany({ family: old.family }, { $set: { revokedAt: new Date() } });
}
