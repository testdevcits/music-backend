# Listener app API and playback guide

Base URL: `https://<your-api-host>/api/v1` (local default: `http://localhost:4000/api/v1`). Send JSON as UTF-8 and use the resource `id` returned by the API. Public UUIDs and legacy MongoDB IDs are accepted for playlist, song, device, and download identifiers where applicable.

## Authentication contract

Every listener, catalog, playlist, favorites, streaming, device, download, notification, and subscription API under `/api/v1` requires:

```http
Authorization: Bearer <accessToken>
```

The backend checks the token and current account status on every request. A missing token returns `401 AUTH_REQUIRED`; an invalid/expired token returns `401 INVALID_ACCESS_TOKEN`; disabled accounts return `401 ACCOUNT_UNAVAILABLE`. Never put tokens in URLs or logs. Refresh access tokens through `/auth/refresh` and atomically replace the stored token pair.

Only account bootstrap/session endpoints (`POST /auth/register`, `/auth/login`, `/auth/google`, `/auth/refresh`, `/auth/logout`) and operational health checks (`/health/live`, `/health/ready`) are intentionally callable without a bearer access token. The app has no anonymous catalog, playlist, audio, or download access. Even a playlist marked `public` is readable only by an authenticated account.

## Account setup

1. Register with `POST /auth/register` using `{ "name", "email", "password" }`, or use `/auth/login` / `/auth/google`.
2. Securely store the returned `accessToken` and `refreshToken` using platform secure storage (Android Keystore-backed storage / iOS Keychain).
3. Add the access token to every `/api/v1` request listed in this guide.
4. On `401`, serialize calls to `POST /auth/refresh` with `{ "refreshToken": "..." }`, replace both tokens, and retry the request once. If refresh fails, clear credentials and ask the listener to sign in again.

## Wishlist (favorites)

The existing favorites resource is the listener's wishlist. Adding is idempotent; removing a song the user did not favorite is safe. Use the song `id` from `GET /songs` or `GET /songs/:id`; secure UUIDs and Mongo IDs are accepted.

```http
GET    /favorites?page=1&limit=20
PUT    /favorites/{songId}
DELETE /favorites/{songId}
```

`GET` returns `{ "data": [...], "page": 1, "limit": 20, "total": 1, "pages": 1 }`. Each favorite has its own `id`, a `song` reference, and timestamps. Only published, ready songs can be added; unavailable songs return `404 SONG_UNAVAILABLE`. Favorites are private to the authenticated account.

Example add:

```http
PUT /favorites/8d14...             # use the actual song id, not this shortened example
Authorization: Bearer <accessToken>
```

To render full song details, use the referenced song ID with `GET /songs/{songId}`. If the song is no longer available, remove the stale favorite with `DELETE`.

## Listener-created playlists

```http
GET    /playlists?page=1&limit=20
POST   /playlists
GET    /playlists/{playlistId}
PATCH  /playlists/{playlistId}
DELETE /playlists/{playlistId}
PUT    /playlists/{playlistId}/songs/{songId}
DELETE /playlists/{playlistId}/songs/{songId}
```

Create a private playlist by default:

```json
{ "name": "Morning bhajans", "public": false }
```

`name` is optional (the server generates `Playlist 1`, `Playlist 2`, etc.); `public` is optional and defaults to `false`. The owner can rename it or change `public` with `PATCH`, and only the owner can edit, add/remove songs, or delete it. `GET /playlists/{id}` returns the playlist plus ordered playable `items`; unavailable/unpublished songs are omitted from `items`. Song membership is idempotent and capped at 1,000 songs. Playlist/song IDs from API responses work directly.

## Categories, popular songs, and trending

Admins create categories such as “Bhakti”, “Bhajan”, or “Meditation” in Catalog, then assign category IDs to songs. The app loads filter options from `GET /categories` and filters the published song catalog with `GET /songs?category=bhakti`. Categories are editorial labels; they don’t automatically change based on plays.

Use these app endpoints for popularity:

```http
GET /songs?sort=popular&page=1&limit=20
GET /charts/trending?days=7&limit=20
```

`sort=popular` orders songs by their all-time `playCount`. The counter increments once when the backend accepts a distinct `play` event for a streaming session. `/charts/trending` ranks published, ready songs over a recent 1–90 day window and also returns top categories. It includes play count, completions, listened seconds, and listener count. The default window is 7 days. Categories receive the listening activity of songs assigned to them.

For those numbers to be meaningful, the player must create a server playback session and send sequenced session events (`play`, `heartbeat`, `pause`, `completion`, or `skip`) while online. A song that is newly published or has no play events won’t appear as trending yet; the app can show a “New releases” section using catalog creation dates instead.

### Admin dashboard

`GET /admin/dashboard` is admin-token protected. It returns the existing account/catalog/monthly summary plus `trending` (last 7 days, top 5 songs and categories) and `popularSongs` (top 5 all-time play counts). The Admin Dashboard displays both lists. The endpoint updates when listening event requests are recorded; offline plays aren’t synced to this ranking today.

## Online playback

1. Discover playable catalog entries with `GET /songs`, `GET /search`, and related artist/category routes. The catalog routes require a bearer token.
2. Start playback with `POST /streaming/{songId}` and body `{ "quality": "64" }` (`64`, `128`, or `192`). The server applies the current plan and rights rules and returns `{ "url", "sessionId", "quality", "duration" }`.
3. Fetch the returned relative `url` with the same Bearer token. Audio is streamed through the API, not from a permanent storage URL.
4. While playing, send `POST /streaming/sessions/{sessionId}/events` at 15–30 second intervals with increasing `sequence`, `type: "heartbeat"`, and elapsed `seconds` (0–60). Also send `play`, `pause`, `skip`, or `completion` state events as appropriate. Send events serially; duplicate sequence numbers are idempotent, gaps return `409 EVENT_SEQUENCE_MISMATCH`.
5. These events populate listening history and user analytics. Listening time is capped to server-observed elapsed time. It is engagement telemetry, not royalty settlement.

## Offline listening (native app)

Offline playback requires an active subscription/plan with an offline quota and permitted quality, plus a verified, current music license that explicitly permits offline use. Free accounts have no offline downloads. The app must not turn an online stream into a local download; request an entitlement first.

### 1. Register this app installation

Generate and persist one UUID per app installation. Do not use a mutable device name as the ID.

```http
POST /devices
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "installationId": "9ad72d10-c7cc-4a29-a690-a905f3786500", "name": "My Android phone", "platform": "android" }
```

Save the returned device `id`. Use `GET /devices` to show active installations. `DELETE /devices/{deviceId}` revokes that device and its offline grants.

### 2. Ask for a song download entitlement

```http
POST /downloads
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "song": "<song-id-from-catalog>", "device": "<device-id-from-devices>", "quality": "128" }
```

The response is a grant record with an `id`, `song`, `device`, `quality`, `expiresAt`, and `revokedAt`. The backend checks plan quota, device ownership, requested quality, current territory, and license `offline` permission before creating it. Common denials: `403 PLAN_RESTRICTED`, `403 DEVICE_UNAVAILABLE`, `403 DOWNLOAD_LIMIT`, `403 LICENSE_UNAVAILABLE`, `403 LICENSE_NOT_AVAILABLE_IN_COUNTRY`, `403 TERRITORY_VERIFICATION_REQUIRED`, and `409 OFFLINE_AUDIO_UNAVAILABLE`.

### 3. Download into encrypted app storage

Request a short-lived media path:

```http
POST /downloads/{downloadId}/url
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{ "device": "<device-id-from-devices>" }
```

The response includes `url`, `entitlementExpiresAt`, `quality`, `contentVersion`, and `protection.mode: "client-encrypted-storage"`. Fetch that relative URL with the Bearer token. The response is the audio byte stream; it is **not** JSON and is not a public CDN URL. Stream it directly into an encrypted file. Generate a per-file key and wrap it with Android Keystore / iOS Keychain-backed secure key storage; never store plaintext audio or its key in ordinary app files.

### 4. Play offline and revalidate

Before every offline play, verify locally that the entitlement has not expired and the encrypted file's `contentVersion` matches the grant. When online, `GET /downloads` lists active grants and the app can revalidate with `POST /downloads/{id}/url`. On expiry, logout, device revocation, entitlement removal, or failed revalidation, delete the encrypted file and its wrapped key. The expiry is the earliest of plan duration, subscription expiry, and license expiry. Fully offline clients cannot learn about a server-side revocation until they reconnect, so enforce the stored expiry and the plan's `offlineDays` maximum.

Offline playback events are not currently accepted by the online playback-session event API. Queue local history only as explicitly unverified client data, or keep it on-device; do not report it as server-verified listening time. Online event telemetry resumes through the streaming-session endpoint when the user streams online.

### 5. Remove an offline copy

`DELETE /downloads/{downloadId}` revokes one grant. `DELETE /devices/{deviceId}` revokes all grants on an installation. Subscription cancellation or replacement also revokes registered devices and downloads. Always remove local ciphertext and its key when the app receives a revocation or entitlement error.

## Core app endpoint checklist

| Feature | Endpoints |
| --- | --- |
| Sign in/profile | `/auth/*`, `GET/PATCH /users/me` |
| Discover music | `GET /songs`, `/search`, `/artists`, `/categories`, `/tags` |
| Wishlist | `GET /favorites`, `PUT/DELETE /favorites/{songId}` |
| Playlists | `GET/POST /playlists`, `GET/PATCH/DELETE /playlists/{id}`, `PUT/DELETE /playlists/{id}/songs/{songId}` |
| Online player | `POST /streaming/{songId}`, `GET /streaming/sessions/{id}/audio`, `POST /streaming/sessions/{id}/events` |
| Offline player | `POST/GET /devices`, `DELETE /devices/{id}`, `POST/GET /downloads`, `POST /downloads/{id}/url`, `GET /downloads/{id}/audio`, `DELETE /downloads/{id}` |
| Inbox | `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/{id}/read`, `PATCH /notifications/read-all` |

See [API.md](API.md) for full response/error references and [SECURITY.md](SECURITY.md) for the offline security contract.
