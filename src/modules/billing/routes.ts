import { Router } from 'express';
import * as controller from './controller';

export const billingRoutes = Router();
billingRoutes.get('/subscriptions/plans', controller.getSubscriptionsPlans);
billingRoutes.get('/subscriptions/me', controller.getSubscriptionsMe);
billingRoutes.post('/subscriptions/cancel', controller.postSubscriptionsCancel);
