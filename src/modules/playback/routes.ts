import { Router } from 'express';
import * as controller from './controller';

export const playbackRoutes = Router();
playbackRoutes.post('/streaming/:songId', controller.postStreamingSongId);
playbackRoutes.get('/streaming/sessions/:id/audio', controller.getStreamingSessionsIdAudio);
playbackRoutes.post('/streaming/sessions/:id/events', controller.postStreamingSessionsIdEvents);
