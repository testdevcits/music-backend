# Production deployment

## Vercel API and worker deployment

Deploy the `backend/` directory as the Vercel project root. `vercel.json` configures the Express API function and `src/app.ts` is its default export. The separate `src/standalone.ts` listens locally and in Docker; it is never used by Vercel.

1. Create MongoDB Atlas (or an equivalent TLS replica set) and a TCP Redis service. Media is stored in the MongoDB `media.files` and `media.chunks` GridFS collections. Set a production-specific `QUEUE_PREFIX`, such as `music-platform-production`; preview deployments must use their own prefix and preferably separate infrastructure.
2. In Vercel, add every key from `.env.vercel.example` to Production. Add a separate preview MongoDB database and Redis prefix before enabling Preview. Set Vercel's Node version to 22.x. The Vercel project must never contain worker credentials in client-side variables.
3. Import this folder in Vercel or run `npx vercel --prod` from it. After deployment, check `GET /health/live`, then `GET /health/ready`. The readiness endpoint confirms MongoDB and Redis access.
4. Deploy `../admin-dashboard/` as a second React/Vite Vercel project. Add `VITE_API_BASE_URL=https://api.example.com/api/v1` in that Vercel project's Production Environment Variables, then deploy. Add the dashboard origin to the API `CORS_ORIGINS` variable and redeploy the API.
5. On a persistent worker host, copy `.env.vercel.example` to a private `.env.worker`, set the same production values, and run `docker compose -f docker-compose.worker.yml up -d --build`. The worker must share `MONGO_URI`, `REDIS_URL`, `QUEUE_PREFIX`, and FFmpeg settings with the API. Do not run the worker as a Vercel Function: audio transcodes need a persistent process, FFmpeg binary, temporary disk, and retry-safe queue consumer.
6. Upload a short WAV through the dashboard, wait for all 64/128/192 kbps jobs, add a license through the API/admin workflow, publish it, and verify an authenticated stream. This confirms API → MongoDB GridFS → Redis → worker integration.

The API function is configured for 60 seconds; normal API calls should complete in a few seconds because FFmpeg work is asynchronous. Vercel Functions have request-size and duration limits. Because MongoDB-only uploads pass through the API into GridFS, use a separate container API endpoint for large music uploads if the Vercel request limit is lower than `MAX_UPLOAD_BYTES`; keep the same MongoDB and Redis configuration. Use the official [Express deployment guide](https://vercel.com/docs/frameworks/backend/express) and [function limits](https://vercel.com/docs/functions/limitations) when selecting a plan.

1. Provision MongoDB with a replica set, authentication, TLS, backups and restore drills. Standalone MongoDB cannot run the required quota/token transactions.
2. Provision private Redis with TLS/authentication and AOF persistence. BullMQ requires `maxmemory-policy noeviction`; do not use an eviction-prone shared cache. Configure queue persistence/HA according to your job-loss tolerance.
3. Give the application database identity read/write access only to its MongoDB database. Include GridFS `media.files` and `media.chunks` in backup and restore drills; this database contains the original, processed audio and covers.
4. Set secrets through your deployment secret manager. Use a random JWT signing key of at least 32 bytes.
5. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, and `npm run db:indexes` as a controlled release step. Index creation is disabled at startup in production. Plan index changes before large collection deployments; never blindly run `syncIndexes` against production.
6. Build `docker build -t music-platform-backend .`. Run the API image with `node dist/standalone.js` and separate workers with `node dist/workers/main.js`. Supply env vars via your orchestrator. Each worker instance processes one audio job concurrently; different songs can process across replicas. Per-song reservations prevent overlapping audio processing.
7. Place the API behind HTTPS ingress. Set CORS_ORIGINS and TRUST_PROXY_HOPS to the actual topology. Expose `/health/live` for liveness and `/health/ready` for readiness. Protect operational endpoints at the ingress if needed.
8. Apply CPU/memory limits (start with 1–2 CPU and 1–2 GiB per audio worker), an ephemeral writable `/tmp`, non-root filesystem permissions and adequate scratch space. Configure worker termination grace to allow current FFmpeg jobs to finish, up to the configured media timeouts. API shutdown drains up to 30 seconds.
9. Alert on 5xx, MongoDB/Redis errors, GridFS size growth, stalled/failed BullMQ jobs, queue age and scratch disk usage. Job failures are retained seven days, successful jobs one day with count caps. Use admin job status/retry endpoints for audio failures. Integrate queue metrics/alerts with your monitoring system.
10. Smoke-test a real upload, cover normalization, job retry, all three qualities, authenticated streaming, license denial, download expiry and mobile connectivity against the deployed GridFS-backed API.

The local Compose stack is not a production deployment: its MongoDB/Redis have no authentication. Production should use secured managed services or a separately hardened deployment.

Subscription purchase verification (Razorpay/Stripe/Play Billing/App Store), FCM/APNs/email delivery, trusted territorial geolocation and commercial DRM are explicit integration points. Paid activation is admin-only until a verified payment webhook is added. Webhooks must verify provider signatures and enforce unique provider event IDs before granting a subscription.

Failed media processing retains the GridFS source file. After fixing the cause, retry the failed queue job. A queue-add failure may leave a per-song reservation; retry the upload completion endpoint. Old GridFS originals and processed versions need a retention task informed by active playback/offline requirements; they are not deleted automatically.
