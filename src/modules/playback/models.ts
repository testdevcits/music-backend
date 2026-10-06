import { Schema, model } from 'mongoose';
import { withSecureId } from '../../shared/ids';

const session = withSecureId(
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      song: { type: Schema.Types.ObjectId, ref: 'Song', required: true },
      quality: { type: String, enum: ['64', '128', '192'], required: true },
      expiresAt: { type: Date, required: true },
      lastSequence: { type: Number, default: 0 },
      listenedSeconds: { type: Number, default: 0 },
      lastEventAt: { type: Date, default: Date.now },
      state: { type: String, default: 'play' },
    },
    { timestamps: true },
  ),
);
session.index({ user: 1, createdAt: -1 });
session.index({ expiresAt: 1 }, { expireAfterSeconds: 2592000 });
export const PlaybackSession = model('PlaybackSession', session);

const event = withSecureId(
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, required: true },
      song: { type: Schema.Types.ObjectId, ref: 'Song', required: true },
      session: { type: Schema.Types.ObjectId, required: true },
      sequence: { type: Number, required: true },
      type: {
        type: String,
        enum: ['play', 'pause', 'skip', 'completion', 'heartbeat'],
        required: true,
      },
      seconds: { type: Number, required: true },
    },
    { timestamps: true },
  ),
);
event.index({ session: 1, sequence: 1 }, { unique: true });
event.index({ user: 1, createdAt: -1 });
event.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });
export const ListeningEvent = model('ListeningEvent', event);
