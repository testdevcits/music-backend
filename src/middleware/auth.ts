import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from '../infrastructure/connections';
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
  if (!token) {
    logger.warn(
      {
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        authHeader: req.headers.authorization ? 'present' : 'missing',
      },
      'AUTH_REQUIRED: missing bearer token',
    );
    ensure(token, 401, 'AUTH_REQUIRED');
  }
  let payload: jwt.JwtPayload;
  try {
    const parsed = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (typeof parsed === 'string' || !parsed.sub) throw Error();
    payload = parsed;
  } catch (error) {
    logger.warn(
      {
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        authHeader: req.headers.authorization ? 'present' : 'missing',
        err: error,
      },
      'INVALID_ACCESS_TOKEN',
    );
    throw new ApiError(401, 'INVALID_ACCESS_TOKEN');
  }
  const user: any = await User.findById(payload.sub);
  if (!user || user.disabled) {
    logger.warn(
      {
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userId: payload.sub,
        userExists: !!user,
        disabled: user?.disabled ?? false,
      },
      'ACCOUNT_UNAVAILABLE',
    );
  }
  ensure(user && !user.disabled, 401, 'ACCOUNT_UNAVAILABLE');
  req.auth = { userId: String(user?._id ?? payload.sub), role: String(user?.role ?? 'user') };
  next();
};
export const admin: RequestHandler = (req, _res, next) => {
  if (req.auth.role !== 'admin') {
    logger.warn(
      {
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userId: req.auth?.userId,
        role: req.auth?.role,
      },
      'ADMIN_REQUIRED',
    );
  }
  ensure(req.auth.role === 'admin', 403, 'ADMIN_REQUIRED');
  next();
};
