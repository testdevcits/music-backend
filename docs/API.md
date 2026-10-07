# REST API v1

Base URL: `http://localhost:4000/api/v1`. JSON request/response bodies. Except authentication and `/health/*`, all endpoints require `Authorization: Bearer <accessToken>`. Admin endpoints additionally require a current admin role. Private responses use `Cache-Control: no-store`. See [APP_DEVELOPER_GUIDE.md](APP_DEVELOPER_GUIDE.md) for a listener app's end-to-end auth, wishlist, playlist, online-playback, and offline-download flows.

List endpoints generally accept `page=1&limit=20` (maximum 100) and return `{data:[...]}` with page metadata where implemented. Use the resource `id` returned by an endpoint; playlist, song, device, and download routes accept public UUID IDs and legacy MongoDB object IDs. Timestamps are ISO 8601 UTC. Unknown request-body fields are rejected.

Errors use `{ "error": { "code": "PLAN_RESTRICTED", "message": "PLAN_RESTRICTED" } }`; validation errors include `details`. Common statuses: 400 invalid input, 401 login/token failure, 403 permission/plan/license restriction, 404 missing or inaccessible resource, 409 conflict/limit/state issue, 410 upload expired, 413 oversized upload, 429 rate limit, 500 internal failure. Quota denials return 403.

## Authentication and users

| Method | Path             | Input / behavior                      |
| ------ | ---------------- | ------------------------------------- |
| POST   | `/auth/register` | `{name,email,password}` → 201 tokens  |
| POST   | `/auth/login`    | `{email,password}` → tokens           |
| POST   | `/auth/google`   | `{idToken}` verified Google ID token → tokens |
| POST   | `/auth/refresh`  | `{refreshToken}` → rotated token pair |
| POST   | `/auth/logout`   | `{refreshToken}` → 204, revoke family |
| GET    | `/users/me`      | Current profile                       |
| PATCH  | `/users/me`      | `{name}`                              |

Passwords must be at least 8 characters and at most 72 UTF-8 bytes. Public signup always creates a listener account, never an admin. Token response: `{accessToken,refreshToken,expiresIn:900}`. Store the replacement refresh token atomically and never use the previous token again. Google login requires `GOOGLE_CLIENT_ID` and verifies the ID token server-side; see [AUTH_API.md](AUTH_API.md) for client setup, request examples, and auth errors.

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Listener","email":"listener@example.com","password":"use-your-own-strong-password"}'
```

## Catalog and search

| Method | Path                             | Input / behavior                                            |
| ------ | -------------------------------- | ----------------------------------------------------------- |
| GET    | `/songs`                         | page, limit, metadata filters: q, category/categoryId, tag, artist/artistName, album, language, genre, year/fromYear/toYear/decade, sort (`popular` is all-time recorded play count) |
| GET    | `/songs/:id`                     | Published, processed song metadata and available qualities  |
| GET    | `/artists`, `/artists/:id`       | Artist metadata                                             |
| GET    | `/albums`, `/albums/:id`         | Album metadata                                              |
| GET    | `/categories`, `/categories/:id` | Dynamic category records with parent IDs                    |
| GET    | `/tags`, `/tags/:id`             | Tags                                                        |
| GET    | `/search?q=hanuman`              | Published song title/lyrics text search plus catalog filters |
| GET    | `/charts/trending?days=7&limit=20` | Published tracks and categories ranked by recorded plays/listening during the requested 1–90 day window |

Song responses omit audio keys, source keys and processing versions; `coverUrl` is temporary. IDs reference related artists/albums/categories/tags. Catalog visibility is distinct from playback permission: expired or territorial licenses can remain visible in discovery, but streaming/download checks deny access. Text search uses MongoDB's tokenizer without language stemming so song language codes do not become text-index overrides. Search accepts artist name, category slug/name, year range or decade, genre and language. Sort values are `recent`, `year-asc`, `year-desc`, `popular`, and `title`. `popular` sorts by the song's all-time `playCount`, incremented once for each accepted `play` event. `/charts/trending` aggregates events from the selected recent window and returns top tracks with play/completion/listening/listener counts plus top categories; only published, ready songs are returned. Results include `total` and `pages` where applicable.

Categories are catalog metadata managed by admins. Add a category in `/admin/categories`, then assign its ID to `categories` when creating/updating a song. Listener app category filters use `GET /songs?category=<category-slug>`; category options come from `GET /categories`. Trending categories are calculated from those assignments and recent listening events, not manually tagged as “trending.”

Example: `GET /songs?artistName=Rib%20hav&category=bhakti&decade=1990&sort=year-asc&page=1&limit=20`. `GET /search?q=chalisa&language=Hindi&category=hanuman-bhajans` combines text search and filters. Use `/categories` and `/artists` to populate filter options.

## Personal library

| Method      | Path                           | Input / behavior                                               |
| ----------- | ------------------------------ | -------------------------------------------------------------- |
| GET, POST   | `/playlists`                   | List owned playlists; create `{name?,public?}`; omitted name becomes `Playlist 1`, `Playlist 2`, etc. |
| GET         | `/playlists/:id`               | Authenticated owner or authenticated viewer of a public playlist; includes ordered playable `items` plus song IDs |
| PATCH       | `/playlists/:id`               | Owner changes `{name?,public?}`                                |
| DELETE      | `/playlists/:id`               | Owner deletes                                                  |
| PUT, DELETE | `/playlists/:id/songs/:songId` | Owner adds/removes song; maximum 1,000 entries                 |
| GET         | `/favorites`                   | Wishlist/favorite records with song IDs and pagination metadata (`page`, `limit`, `total`, `pages`) |
| PUT, DELETE | `/favorites/:songId`           | Idempotent favorite/unfavorite                                 |
| GET         | `/history`                     | Newest listening events first, including song ID/type/duration |
| DELETE      | `/history`                     | Delete the user's listening events                             |
| GET         | `/notifications?page=1&limit=20` | In-app inbox; also accepts `unreadOnly=true`; returns total and unread counts |
| GET         | `/notifications/unread-count`  | Current user's unread count                                    |
| PATCH       | `/notifications/:id/read`      | Mark an owned notification read; other users' IDs return 404   |
| PATCH       | `/notifications/read-all`      | Mark all of the current user's notifications read              |

All app notification routes require the user's Bearer access token. When the backend creates an inbox entry, it is persisted in MongoDB; the app can poll the unread-count endpoint or refresh the inbox. Example entry: `{ "id": "...", "title": "New release", "body": "A new song is available", "createdAt": "..." }`; `readAt` is included after the user reads it.

## Streaming and listening events

`POST /streaming/:songId` with `{ "quality": "64" }` (also `128`, `192`) returns a protected API media path. Use the song `id` returned by `GET /songs`; the endpoint also accepts a MongoDB song ID for existing clients. Request the returned audio path with the same Bearer token:

```json
{
  "url": "/api/v1/streaming/sessions/SESSION_ID/audio",
  "sessionId": "0123456789abcdef01234567",
  "quality": "64",
  "duration": 245.8
}
```

Audio is stored in MongoDB GridFS and is streamed only through this authenticated API. A stream grant starts a playback session in `play` state; session lifetime is at most four hours and no later than license expiry. Unsubscribed users can stream at 64 kbps.

`POST /streaming/sessions/:id/events`:

```json
{ "sequence": 1, "type": "heartbeat", "seconds": 15 }
```

Types: `play`, `pause`, `skip`, `completion`, `heartbeat`. Sequence starts at 1 and increments by exactly 1. `seconds` is elapsed listening since the previous event, between 0 and 60; send heartbeats every 15–30 seconds while audio is playing. Send `pause` when paused, `play` when resumed, and `completion` or `skip` when the track ends. Duplicate sequence returns the existing event; a gap returns 409. The server bounds duration using its own elapsed time and previous state. These events power admin user details: total listened time, weekday totals, most-listened songs/categories, plays, completions, and recent activity. Without client event calls, those listening metrics remain zero. This tracks engagement, not certified playback or royalty accounting.

`GET /streaming/sessions/:id/audio` streams the selected GridFS quality. It requires the same authenticated user and a still-valid playback session.

## Devices and offline downloads

| Method | Path                             | Input / behavior                                                      |
| ------ | -------------------------------- | --------------------------------------------------------------------- |
| POST   | `/devices`                       | `{installationId:UUID,name,platform:"android"                         | "ios" | "web"}` |
| GET    | `/devices`                       | Active owned devices                                                  |
| DELETE | `/devices/:id`                   | Revoke device and its downloads                                       |
| POST   | `/downloads`                     | `{song:ID,device:ID,quality:"128"}` → entitlement                     |
| GET    | `/downloads`                     | Active, unexpired entitlements                                        |
| POST   | `/downloads/:id/url`             | `{device:ID}` → authenticated API media path after permission recheck |
| GET    | `/downloads/:id/audio?device=ID` | Download GridFS audio after entitlement recheck                       |
| DELETE | `/downloads/:id`                 | Revoke entitlement                                                    |

The entitlement response contains `url`, `entitlementExpiresAt`, `quality`, `contentVersion`, and `protection.mode="client-encrypted-storage"`. The returned URL is an authenticated API path, not a permanent storage URL. The mobile application must encrypt locally and enforce entitlement expiry; see [security contract](SECURITY.md).

## Subscriptions

| Method | Path                    | Input / behavior                                  |
| ------ | ----------------------- | ------------------------------------------------- |
| GET    | `/subscriptions/plans`  | Active plans                                      |
| GET    | `/subscriptions/me`     | Current subscription plus effective policy        |
| POST   | `/subscriptions/cancel` | Immediate cancellation; revokes downloads/devices |

Plan fields: name, slug, priceMinor (integer currency units), currency, offlineLimit, deviceLimit, offlineDays, qualities, active. Free policy: no offline downloads, one registered device, 64 kbps. Expired/cancelled/inactive-plan subscriptions fall back to free. End users cannot grant themselves subscriptions; verified billing is an integration point. Offline grants require an available audio file ID; otherwise the request returns `409 OFFLINE_AUDIO_UNAVAILABLE` before consuming a quota slot.

## Administration

All paths below begin `/admin`.

| Method     | Path                                                                            | Behavior                                                      |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| GET, POST  | `/artists`, `/albums`, `/categories`, `/tags`, `/songs`, `/plans`, `/playlists` | Paginated list/create                                         |
| DELETE     | `/artists/:id`                                                               | Delete an artist that is not referenced by a song or album    |
| GET, PATCH | Same resources plus `/:id`                                                      | Read/update validated fields                                  |
| DELETE     | `/playlists/:id`                                                                | Delete playlist                                               |
| GET        | `/users`                                                                        | Paginated users                                               |
| PATCH      | `/users/:id`                                                                    | `{name?,disabled?}`; no public role promotion                 |
| PUT        | `/licenses/:songId`                                                             | Upsert music license                                          |
| GET        | `/licenses`                                                                     | Paginated licenses                                            |
| POST       | `/songs/:id/publish`                                                            | `{published:boolean}`; requires 3 qualities and valid license |
| POST       | `/songs/:id/uploads`                                                            | Send raw audio/cover bytes to GridFS and enqueue processing   |
| POST       | `/uploads/:id/complete`                                                         | Requeue an incomplete upload; 202                             |
| GET        | `/jobs/:id`                                                                     | Audio job state/progress/attempt count/failure flag           |
| POST       | `/jobs/:id/retry`                                                               | Retry a failed audio job; 202                                 |
| GET        | `/subscriptions`                                                                | Paginated subscriptions                                       |
| PUT        | `/subscriptions/:userId`                                                        | Assign/replace/cancel subscription                            |
| GET        | `/notifications`                                                                | Paginated list of all users' notifications and read state      |
| GET        | `/analytics?days=7`                                                             | Top 100 songs by observed listening duration; 1–90 days       |

Create/update bodies:

- Artist: `{name,bio?}`. Artist names are unique without regard to letter case.
- Album: `{title,artist,releaseDate?}`.
- Category: `{name,slug,parent?}`. Parent must already exist; parent changes are excluded from PATCH, so cycles cannot be introduced through the API. Rename by patching name/slug. Create replacement records to reorganize the tree.
- Tag: `{name,slug}`.
- Song: `{title,artist,album?,language,lyrics?,categories:ID[],tags:ID[]}`. Processing state, GridFS file references, and publication cannot be set through generic updates.
- Playlist: `{owner,name,public,songs:ID[]}`.
- Plan: `{name,slug,priceMinor,currency,offlineLimit,deviceLimit,offlineDays,qualities,active}`. Quota fields cannot change while active subscriptions use the plan; create a new plan version.
- License: `{holder,reference?,startsAt,endsAt,streaming,offline,territories:[],enabled,source,licenseName,evidenceUrl?,documentReference?,inAppStreaming,audioHosting,commercialUse,artworkUse,lyricsUse,verificationStatus,verificationNotes?}`. To set `verificationStatus:"verified"`, include evidence URL or document reference and explicitly enable streaming, in-app playback, audio hosting, and commercial use. Publishing and playback require verified rights evidence. Territory-scoped playback/downloads require the request country to match one of the license's ISO 3166-1 alpha-2 territory codes; Vercel deployments use Vercel's edge country header. In local non-production, send `X-Dev-Country: IN` to simulate India. Missing country denies territory-scoped access; an empty territory list means worldwide only when the actual agreement grants worldwide rights.
- Subscription: `{plan,startsAt,endsAt,status:"active"|"cancelled",externalReference?}`. Replacement revokes existing downloads and device registrations.

Albums/categories/tags/songs are edited in place rather than hard-deleted to preserve references and listening history. An unused artist can be deleted; artists referenced by a song or album return `ARTIST_IN_USE`. Unpublish songs, disable licenses, or deactivate plans to remove availability.

### Upload workflow

1. Create artist, optional album/categories/tags, then a song. Keep the source page/recording, rights holder, license name, evidence reference, territory, and actual permitted uses documented. Metadata or a downloaded file alone does not establish streaming rights.
2. POST raw audio bytes to `/admin/songs/:id/uploads` with `Content-Type: audio/wav` and `X-Upload-Kind: audio`. For cover bytes use `Content-Type: image/jpeg`, `image/png`, or `image/webp` with `X-Upload-Kind: cover`. Audio accepts MP3/WAV/FLAC/MP4; the configured maximum is 200 MiB, covers maximum 10 MiB.
3. The API writes the incoming file to MongoDB GridFS and immediately returns `{status:"queued",jobId}` with 202.
4. Poll `/admin/jobs/:jobId`. Worker validates media and generates 64/128/192 kbps MP3s or a normalized JPEG cover in GridFS. Failed jobs retry with exponential backoff. Reprocessing audio unpublishes the song and requires publishing again.
5. Add a license with evidence and the applicable in-app streaming/audio-hosting/commercial permissions. Only mark it verified after reviewing the actual agreement. Then POST `/admin/songs/:id/publish` with `{published:true}`. Publish errors distinguish a missing license (`LICENSE_REQUIRED`), inactive dates (`LICENSE_INACTIVE`), missing evidence (`LICENSE_EVIDENCE_REQUIRED`), incomplete permissions (`LICENSE_PERMISSIONS_INCOMPLETE`), and a pending/rejected review (`LICENSE_NOT_VERIFIED`).

For sample devotional categories/tags, run `DEVOTIONAL_CATALOG_SEED_CONFIRM=YES npm run seed:devotional-catalog`. It idempotently creates Bhakti subcategories and tags and attaches them to an existing Hanuman Chalisa record if found. It does not create a fake audio track, grant a license, or change audio/publication status.

For local playback testing from the supplied Pixabay search snapshot, run `PIXABAY_TEST_AUDIO_SEED_CONFIRM=YES npm run seed:pixabay-test-audio -- /path/to/pasted-snapshot.json`. This development-only seed imports the snapshot's first-page metadata and source links and attaches generated 12-second WAV tones with an internal test-only license. It never downloads or hosts the original Pixabay audio; the imported entries are test fixtures, not the Pixabay recordings. The script refuses to run with `NODE_ENV=production`.

Covers attach to songs in this upload flow. Artist and album image support is a future targeted GridFS workflow.
