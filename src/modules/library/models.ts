import { Schema, model } from 'mongoose';
const oid = Schema.Types.ObjectId;
export const Playlist = model(
  'Playlist',
  new Schema(
    {
      owner: { type: oid, ref: 'User', required: true, index: true },
      name: { type: String, required: true },
      public: { type: Boolean, default: false },
      songs: [{ type: oid, ref: 'Song' }],
    },
    { timestamps: true },
  ),
);
const favorite = new Schema(
  {
    user: { type: oid, ref: 'User', required: true },
    song: { type: oid, ref: 'Song', required: true },
  },
  { timestamps: true },
);
favorite.index({ user: 1, song: 1 }, { unique: true });
export const Favorite = model('Favorite', favorite);
const device = new Schema(
  {
    user: { type: oid, ref: 'User', required: true },
    installationId: { type: String, required: true },
    name: String,
    platform: { type: String, enum: ['android', 'ios', 'web'] },
    revokedAt: Date,
    lastSeenAt: Date,
  },
  { timestamps: true },
);
device.index({ user: 1, installationId: 1 }, { unique: true });
export const Device = model('Device', device);
const download = new Schema(
  {
    user: { type: oid, ref: 'User', required: true },
    song: { type: oid, ref: 'Song', required: true },
    device: { type: oid, ref: 'Device', required: true },
    quality: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
  },
  { timestamps: true },
);
download.index({ user: 1, song: 1, device: 1 }, { unique: true });
download.index({ user: 1, expiresAt: 1 });
export const Download = model('Download', download);
const notification = new Schema(
  {
    user: { type: oid, ref: 'User', required: true, index: true },
    title: String,
    body: String,
    dedupeKey: { type: String, unique: true },
    readAt: Date,
  },
  { timestamps: true },
);
export const Notification = model('Notification', notification);
