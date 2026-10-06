import { RequestHandler } from 'express';
import * as service from './service';
import { credentials, refreshInput, registration } from './validators';
export const register: RequestHandler = async (req, res) => {
  res.status(201).json(await service.register(registration.parse(req.body)));
};
export const login: RequestHandler = async (req, res) => {
  res.json(await service.login(credentials.parse(req.body)));
};
export const refresh: RequestHandler = async (req, res) => {
  res.json(await service.rotate(refreshInput.parse(req.body).refreshToken));
};
export const logout: RequestHandler = async (req, res) => {
  await service.logout(refreshInput.parse(req.body).refreshToken);
  res.sendStatus(204);
};
