import { Schema, model } from 'mongoose';
import { withSecureId } from '../../shared/ids';

export const Plan = model(
  'Plan',
  withSecureId(
    new Schema(
      {
        name: { type: String, required: true },
        slug: { type: String, required: true, unique: true },
        priceMinor: { type: Number, min: 0, required: true },
        currency: { type: String, default: 'INR' },
        offlineLimit: { type: Number, min: 0, required: true },
        deviceLimit: { type: Number, min: 1, required: true },
        offlineDays: { type: Number, min: 1, default: 30 },
        qualities: { type: [String], default: ['64'] },
        active: { type: Boolean, default: true },
      },
      { timestamps: true },
    ),
  ),
);

export const Subscription = model(
  'Subscription',
  withSecureId(
    new Schema(
      {
        user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
        plan: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
        startsAt: { type: Date, required: true },
        endsAt: { type: Date, required: true },
        status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
        externalReference: String,
      },
      { timestamps: true },
    ),
  ),
);
