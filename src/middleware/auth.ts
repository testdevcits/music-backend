import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { User } from '../modules/auth/models';
import { ApiError, ensure } from '../shared/errors';
declare global {
  namespace Express {
    interface Request {
      auth: { userId: string; role: string };
    }
  }
}
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  ensure(token, 401, 'AUTH_REQUIRED');
  let payload: jwt.JwtPayload;
  try {
    const parsed = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (typeof parsed === 'string' || !parsed.sub) throw Error();
    payload = parsed;
  } catch {
    throw new ApiError(401, 'INVALID_ACCESS_TOKEN');
  }
  const user = await User.findById(payload.sub);
  ensure(user && !user.disabled, 401, 'ACCOUNT_UNAVAILABLE');
  req.auth = { userId: String(user._id), role: user.role! };
  next();
};
export const admin: RequestHandler = (req, _res, next) => {
  ensure(req.auth.role === 'admin', 403, 'ADMIN_REQUIRED');
  next();
};
