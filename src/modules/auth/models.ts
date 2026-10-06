import { Schema, model } from 'mongoose';
export const User = model(
  'User',
  new Schema(
    {
      email: { type: String, required: true, unique: true, lowercase: true },
      name: { type: String, required: true },
      passwordHash: { type: String, required: true, select: false },
      role: { type: String, enum: ['user', 'admin'], default: 'user' },
      disabled: { type: Boolean, default: false },
      quotaVersion: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
);
const sessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
  },
  { timestamps: true },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RefreshSession = model('RefreshSession', sessionSchema);
