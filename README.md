# music-platform backend

Node.js + TypeScript REST API for Android/iOS clients and a React admin panel. The existing `music-platform/` is the project root; all backend files live here in `backend/`.

## Requirements and quick start

- Node.js 22 LTS or newer; npm.
- MongoDB replica set (transactions and GridFS media storage are required), Redis 7+.
- FFmpeg and ffprobe installed on the worker host. Docker image includes both.

```bash
cd backend
cp .env.example .env
# Replace JWT_SECRET with: openssl rand -hex 32
npm ci
docker compose up -d
npm run db:indexes
npm run seed
npm run dev
# Another terminal:
npm run dev:worker
```

If `npm run dev` reports `MONGO_URI`, `REDIS_URL`, or `JWT_SECRET` as missing, the `.env` file has not been created in this `backend/` folder. Run `cp .env.example .env`, set `JWT_SECRET`, then start MongoDB and Redis with `docker compose up -d` before running the API. The included default CORS settings permit the React dashboard on Vite port 5173.

Compose provides **local development infrastructure**, with loopback-only ports and persistent volumes. It initializes a single-node MongoDB replica set. Wait for `mongo-init` to finish. Host-based API development uses `directConnection=true` because the replica set advertises its Docker hostname. Install FFmpeg on the host (`sudo apt-get install ffmpeg` on Debian/Ubuntu).

For a physical phone, use a reachable API hostname instead of `localhost`. Audio and covers are served by authenticated API routes from MongoDB GridFS.

Create or reset the local administrator explicitly, without committing credentials:

```bash
read -r -p 'Admin email: ' ADMIN_EMAIL
read -r -s -p 'Admin password: ' ADMIN_PASSWORD
export ADMIN_EMAIL ADMIN_PASSWORD
npm run seed
unset ADMIN_EMAIL ADMIN_PASSWORD
```

When `ADMIN_EMAIL` and `ADMIN_PASSWORD` are present, the seed command creates or updates that account as an enabled administrator. The password must be 8–72 bytes. It also creates an example Premium plan and editable categories: Bhakti → Hanuman/Krishna/Shiv/Ram, Bollywood, Classical, Meditation, Kids, Instrumental, Regional. Categories are database records, never a hard-coded authorization policy.

## Commands

| Command                | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run dev`          | Watch API on port 4000                                              |
| `npm run dev:worker`   | Watch audio/notification workers                                    |
| `npm run check`        | Strict TypeScript check                                             |
| `npm run build`        | Compile to `dist/`                                                  |
| `npm start`            | Run compiled API                                                    |
| `npm run worker`       | Run compiled workers                                                |
| `npm run db:indexes`   | Create declared indexes without dropping existing indexes           |
| `npm run seed`         | Insert initial categories, plan, optional administrator             |
| `npm test`             | Integration tests with isolated local MongoDB/Redis and real FFmpeg |
| `npm run format:check` | Formatting check                                                    |

Tests require `mongod`, `redis-server`, `ffmpeg`, and `ffprobe` on PATH and unused loopback ports 27919/16399. They create an isolated MongoDB replica set and Redis instance, never using your `.env` services. Tests cover GridFS upload/processing/streaming, refresh-token replay, admin authorization, FFmpeg qualities, publication gating, playback event deduplication, simultaneous quota requests, ownership checks, device revocation, territorial denial, and account disabling.

## Architecture and complete source layout

```text
backend/
├── src/
│   ├── app.ts                     # Express composition, health and rate limiting
│   ├── standalone.ts              # Local/Docker listener and graceful shutdown
│   ├── config/env.ts              # Validated environment
│   ├── shared/{errors,validation}.ts
│   ├── middleware/{auth,errors}.ts
│   ├── infrastructure/
│   │   ├── connections.ts         # MongoDB, Redis, structured logger
│   │   ├── queues.ts              # BullMQ queues, retries and retention
│   │   ├── media.ts               # MongoDB GridFS media persistence and delivery
│   │   └── ffmpeg.ts              # Bounded subprocesses; no shell interpolation
│   ├── modules/
│   │   ├── auth/                  # Users, sessions, JWT and refresh rotation
│   │   ├── catalog/               # Artists, albums, songs, category tree, tags, search, rights
│   │   ├── library/               # Playlists, favorites, devices, downloads, notifications
│   │   ├── playback/              # Streaming, listening events/history, analytics source
│   │   ├── billing/               # Plans, subscriptions and quota policies
│   │   └── admin/                 # Management, uploads, publishing, licensing, analytics
│   └── workers/{main,audio}.ts
├── scripts/{seed,indexes}.ts
├── tests/platform.test.ts
├── docs/{API,SECURITY,DEPLOYMENT}.md
├── docs/openapi.json
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── package.json
├── package-lock.json
└── tsconfig.json
```

Modules group closely related domains rather than creating 19 disconnected microservices. HTTP validation sits at each module boundary; services handle token rotation, licensing, policy enforcement, quota transactions, storage and processing. Mongoose schemas define indexes and relationships. API and workers run as separate processes and can be deployed independently.

MongoDB stores metadata plus GridFS audio and cover files. The API authorizes each media request against the user, song, license and plan. FFmpeg work remains asynchronous in the worker.

See [API reference](docs/API.md), [OpenAPI](docs/openapi.json), [security and offline design](docs/SECURITY.md), and [deployment guide](docs/DEPLOYMENT.md).

## Vercel API and admin dashboard

Deploy the API from this `backend/` directory. Its Vercel entry point is `src/app.ts`, which exports the Express app without binding a TCP port. The local and Docker entry point is `src/standalone.ts`. Add the variables in `.env.vercel.example` in Vercel Project Settings; do not upload an `.env` file.

```bash
npx vercel link
npx vercel env pull .env.local
npx vercel --prod
```

The administrator UI is a separate React/Vite Vercel project in `../admin-dashboard/`:

```bash
cd ../admin-dashboard
cp .env.example .env.local
# Set VITE_API_BASE_URL in .env.local to https://YOUR-API.vercel.app/api/v1
npm install
npx vercel --prod
```

After it deploys, add the dashboard URL to the API's production `CORS_ORIGINS`, for example `https://admin.example.com`. Redeploy the API after changing that variable. The dashboard keeps an access token only in the current browser session; signing out or closing the tab clears it.

Vercel runs the API, not the persistent FFmpeg/BullMQ worker. Run `docker compose -f docker-compose.worker.yml up -d --build` on a worker host with the same production `MONGO_URI`, `REDIS_URL`, and `QUEUE_PREFIX` values. See [Vercel deployment](docs/DEPLOYMENT.md#vercel-api-and-worker-deployment).

## Production scope

This implementation includes the backend workflows and infrastructure configuration. Deployment still requires real credentials, TLS, managed database/Redis configuration, operational monitoring and a real-storage smoke test. Subscription changes are admin-managed; there is no payment processor or self-service paid activation. Notifications are a durable in-app inbox; push/email adapters are separate integrations. Region-restricted licenses fail closed until trusted geolocation is integrated. Offline audio protection requires mobile secure storage and local expiry enforcement; this server does not claim to implement Widevine/FairPlay DRM or prevent capture on compromised devices.
# music-backend
