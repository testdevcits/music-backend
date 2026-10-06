import { ClientSession } from 'mongoose';
import { ensure } from '../../shared/errors';
import { User } from '../auth/models';
import { Plan, Subscription } from './models';
export const freePolicy = {
  offlineLimit: 0,
  deviceLimit: 1,
  offlineDays: 1,
  qualities: ['64'],
  endsAt: new Date('9999-01-01'),
};
export async function policy(user: string, session?: ClientSession) {
  const sub = await Subscription.findOne({
    user,
    status: 'active',
    startsAt: { $lte: new Date() },
    endsAt: { $gt: new Date() },
  }).session(session ?? null);
  if (!sub) return freePolicy;
  const plan = await Plan.findById(sub.plan).session(session ?? null);
  if (!plan || !plan.active) return freePolicy;
  return {
    offlineLimit: plan.offlineLimit!,
    deviceLimit: plan.deviceLimit!,
    offlineDays: plan.offlineDays!,
    qualities: plan.qualities,
    endsAt: sub.endsAt!,
  };
}
// Every quota mutation writes this same document, serializing concurrent transactions per user.
export async function lockUser(user: string, session: ClientSession) {
  const result = await User.updateOne(
    { _id: user, disabled: false },
    { $inc: { quotaVersion: 1 } },
    { session },
  );
  ensure(result.matchedCount, 401, 'ACCOUNT_UNAVAILABLE');
}
