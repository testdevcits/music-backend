import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError, ensure } from '../../shared/errors';
import { RefreshSession, User } from './models';

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
export async function register(input: { email: string; password: string; name: string; role?: 'user' | 'admin' }) {
  const user: any = await User.create({
    email: input.email,
    name: input.name,
    role: input.role ?? 'user',
    passwordHash: await bcrypt.hash(input.password, 12),
  });
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
