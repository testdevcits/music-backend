import { RequestHandler } from 'express';
import mongoose from 'mongoose';
import { Device, Download } from '../library/models';
import { Plan, Subscription } from './models';
import { lockUser, policy } from './service';
export const getSubscriptionsPlans: RequestHandler = async (_req, res) =>
  res.json({ data: await Plan.find({ active: true }).limit(100) });
export const getSubscriptionsMe: RequestHandler = async (req, res) =>
  res.json({
    subscription: await Subscription.findOne({ user: req.auth.userId }),
    policy: await policy(req.auth.userId),
  });
export const postSubscriptionsCancel: RequestHandler = async (req, res) => {
  await mongoose.connection.transaction(async (session) => {
    await lockUser(req.auth.userId, session);
    await Subscription.updateOne(
      { user: req.auth.userId },
      { $set: { status: 'cancelled' } },
      { session },
    );
    await Download.updateMany(
      { user: req.auth.userId },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await Device.updateMany(
      { user: req.auth.userId },
      { $set: { revokedAt: new Date() } },
      { session },
    );
  });
  res.sendStatus(204);
};
