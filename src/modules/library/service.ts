import mongoose from 'mongoose';
import { ensure } from '../../shared/errors';
import { lockUser, policy } from '../billing/service';
import { availableSong } from '../catalog/service';
import { Song } from '../catalog/models';
import { Device, Download } from './models';
export async function registerDevice(
  user: string,
  input: { installationId: string; name: string; platform: string },
) {
  return mongoose.connection.transaction(async (session) => {
    await lockUser(user, session);
    const p: any = await policy(user, session);
    const existing: any = await Device.findOne({
      user,
      installationId: input.installationId,
      revokedAt: null,
    }).session(session);
    if (existing) return existing;
    const count = await Device.countDocuments({ user, revokedAt: null }).session(session);
    ensure(count < p.deviceLimit, 403, 'DEVICE_LIMIT');
    return Device.findOneAndUpdate(
      { user, installationId: input.installationId },
      { $set: { ...input, revokedAt: null, lastSeenAt: new Date() } },
      { upsert: true, new: true, session },
    );
  });
}
export async function revokeDevice(user: string, device: string) {
  await mongoose.connection.transaction(async (session) => {
    await lockUser(user, session);
    await Device.updateOne({ _id: device, user }, { $set: { revokedAt: new Date() } }, { session });
    await Download.updateMany({ user, device }, { $set: { revokedAt: new Date() } }, { session });
  });
}
export async function grantDownload(
  user: string,
  input: { song: string; device: string; quality: string },
  country?: string,
) {
  const { song, license }: any = await availableSong(input.song, true, country);
  ensure(
    (song.audio ?? []).some((a: any) => a.quality === input.quality),
    409,
    'QUALITY_UNAVAILABLE',
  );
  return mongoose.connection.transaction(async (session) => {
    await lockUser(user, session);
    const p: any = await policy(user, session);
    ensure((p.offlineLimit ?? 0) > 0 && (p.qualities ?? []).includes(input.quality), 403, 'PLAN_RESTRICTED');
    const device: any = await Device.findOne({ _id: input.device, user, revokedAt: null }).session(
      session,
    );
    ensure(device, 403, 'DEVICE_UNAVAILABLE');
    const existing = await Download.findOne({
      user,
      song: input.song,
      device: input.device,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).session(session);
    const count = await Download.countDocuments({
      user,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).session(session);
    ensure(existing || count < p.offlineLimit, 403, 'DOWNLOAD_LIMIT');
    const expiresAt = new Date(
      Math.min(
        Date.now() + p.offlineDays * 86400000,
        p.endsAt.getTime(),
        license.endsAt!.getTime(),
      ),
    );
    return Download.findOneAndUpdate(
      { user, song: input.song, device: input.device },
      { $set: { quality: input.quality, expiresAt, revokedAt: null } },
      { upsert: true, new: true, session },
    );
  });
}
export async function downloadUrl(user: string, downloadId: string, deviceId: string, country?: string) {
  const grant: any = await Download.findOne({
    _id: downloadId,
    user,
    device: deviceId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  ensure(grant, 403, 'ENTITLEMENT_EXPIRED');
  const device: any = await Device.findOne({ _id: deviceId, user, revokedAt: null });
  ensure(device, 403, 'DEVICE_UNAVAILABLE');
  const p: any = await policy(user);
  ensure((p.offlineLimit ?? 0) > 0 && (p.qualities ?? []).includes(grant.quality!), 403, 'PLAN_RESTRICTED');
  const { song }: any = await availableSong(String(grant.song), true, country);
  const audio = (song.audio ?? []).find((a: any) => a.quality === grant.quality);
  ensure(audio?.fileId, 409, 'QUALITY_UNAVAILABLE');
  return {
    url: `/api/v1/downloads/${grant._id}/audio?device=${deviceId}`,
    entitlementExpiresAt: grant.expiresAt,
    quality: grant.quality,
    contentVersion: song.audioVersion,
    protection: { mode: 'client-encrypted-storage', requiresSecureKeystore: true },
  };
}
export async function downloadFile(user: string, downloadId: string, deviceId: string, country?: string) {
  await downloadUrl(user, downloadId, deviceId, country);
  const grant: any = await Download.findById(downloadId);
  const song: any = await Song.findById(grant!.song);
  const audio = (song.audio ?? []).find((item: any) => item.quality === grant!.quality);
  ensure(audio?.fileId, 409, 'QUALITY_UNAVAILABLE');
  return { fileId: audio.fileId, mime: audio.mime || 'audio/mpeg' };
}
