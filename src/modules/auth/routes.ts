import { Router } from 'express';
import * as controller from './controller';
export const authRoutes = Router();
authRoutes.post('/register', controller.register);
authRoutes.post('/login', controller.login);
authRoutes.post('/google', controller.google);
authRoutes.post('/refresh', controller.refresh);
authRoutes.post('/logout', controller.logout);
