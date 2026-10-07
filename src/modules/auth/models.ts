import { Schema, model } from 'mongoose';
import { withSecureId } from '../../shared/ids';

const userSchema = withSecureId(
  new Schema(
    {
      email: { type: String, required: true, unique: true, lowercase: true },
      publicId: { type: String, unique: true, sparse: true, immutable: true },
      googleSub: { type: String, unique: true, sparse: true, select: false },
      name: { type: String, required: true },
      image: { type: Schema.Types.Mixed, default: null },
      passwordHash: { type: String, required: false, select: false },
      role: { type: String, enum: ['user', 'admin'], default: 'user' },
      disabled: { type: Boolean, default: false },
      quotaVersion: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
);
export const User = model('User', userSchema);

const sequenceSchema = new Schema({ _id: { type: String, required: true }, value: { type: Number, required: true, default: 1000 } });
export const Sequence = model('Sequence', sequenceSchema);

export async function allocateUserPublicId() {
  try {
    await Sequence.create({ _id: 'user-public-id', value: 1000 });
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }
  const sequence = await Sequence.findByIdAndUpdate('user-public-id', { $inc: { value: 1 } }, { new: true });
  if (!sequence) throw new Error('USER_ID_SEQUENCE_UNAVAILABLE');
  return `MU${String(sequence.value).padStart(4, '0')}`;
}

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
