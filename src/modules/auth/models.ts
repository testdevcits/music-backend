import { Schema, model } from 'mongoose';
import { withSecureId } from '../../shared/ids';

const userSchema = withSecureId(
  new Schema(
    {
      email: { type: String, required: true, unique: true, lowercase: true },
      name: { type: String, required: true },
      image: { type: Schema.Types.Mixed, default: null },
      passwordHash: { type: String, required: true, select: false },
      role: { type: String, enum: ['user', 'admin'], default: 'user' },
      disabled: { type: Boolean, default: false },
      quotaVersion: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
);
export const User = model('User', userSchema);

const sessionSchema = withSecureId(
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      tokenHash: { type: String, required: true, unique: true },
      family: { type: String, required: true, index: true },
      expiresAt: { type: Date, required: true },
      revokedAt: Date,
    },
    { timestamps: true },
  ),
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RefreshSession = model('RefreshSession', sessionSchema);
