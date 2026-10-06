# REST API v1

Base URL: `http://localhost:4000/api/v1`. JSON request/response bodies. Except authentication and `/health/*`, all endpoints require `Authorization: Bearer <accessToken>`. Admin endpoints additionally require a current admin role. Private responses use `Cache-Control: no-store`.

List endpoints generally accept `page=1&limit=20` (maximum 100) and return `{data:[...]}` with page metadata where implemented. IDs are 24-character MongoDB object IDs. Timestamps are ISO 8601 UTC. Unknown request-body fields are rejected.

Errors use `{ "error": { "code": "PLAN_RESTRICTED", "message": "PLAN_RESTRICTED" } }`; validation errors include `details`. Common statuses: 400 invalid input, 401 login/token failure, 403 permission/plan/license restriction, 404 missing or inaccessible resource, 409 conflict/limit/state issue, 410 upload expired, 413 oversized upload, 429 rate limit, 500 internal failure. Quota denials return 403.

## Authentication and users

| Method | Path             | Input / behavior                      |
| ------ | ---------------- | ------------------------------------- |
| POST   | `/auth/register` | `{name,email,password}` → 201 tokens  |
| POST   | `/auth/login`    | `{email,password}` → tokens           |
| POST   | `/auth/refresh`  | `{refreshToken}` → rotated token pair |
| POST   | `/auth/logout`   | `{refreshToken}` → 204, revoke family |
| GET    | `/users/me`      | Current profile                       |
| PATCH  | `/users/me`      | `{name}`                              |

Passwords must be at least 12 characters and at most 72 UTF-8 bytes. Token response: `{accessToken,refreshToken,expiresIn:900}`. Store the replacement refresh token atomically and never use the previous token again.

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Listener","email":"listener@example.com","password":"use-your-own-strong-password"}'
```

## Catalog and search

| Method | Path                             | Input / behavior                                            |
| ------ | -------------------------------- | ----------------------------------------------------------- |
| GET    | `/songs`                         | page, limit, category, tag, artist, album, language filters |
| GET    | `/songs/:id`                     | Published, processed song metadata and available qualities  |
| GET    | `/artists`, `/artists/:id`       | Artist metadata                                             |
| GET    | `/albums`, `/albums/:id`         | Album metadata                                              |
| GET    | `/categories`, `/categories/:id` | Dynamic category records with parent IDs                    |
| GET    | `/tags`, `/tags/:id`             | Tags                                                        |
| GET    | `/search?q=hanuman`              | Published song title/lyrics text search; page/limit         |

Song responses omit audio keys, source keys and processing versions; `coverUrl` is temporary. IDs reference related artists/albums/categories/tags. Catalog visibility is distinct from playback permission: expired or territorial licenses can remain visible in discovery, but streaming/download checks deny access. Text search uses MongoDB's tokenizer without language stemming so song language codes do not become text-index overrides. Advanced transliteration, fuzzy matching and artist search can be added with Atlas Search or a dedicated search engine.

## Personal library

| Method      | Path                           | Input / behavior                                               |
| ----------- | ------------------------------ | -------------------------------------------------------------- |
| GET, POST   | `/playlists`                   | List owned playlists; create `{name,public?}`                  |
| GET         | `/playlists/:id`               | Owner or public playlist                                       |
| PATCH       | `/playlists/:id`               | Owner changes `{name?,public?}`                                |
| DELETE      | `/playlists/:id`               | Owner deletes                                                  |
| PUT, DELETE | `/playlists/:id/songs/:songId` | Owner adds/removes song; maximum 1,000 entries                 |
| GET         | `/favorites`                   | Favorite records with song IDs                                 |
| PUT, DELETE | `/favorites/:songId`           | Idempotent favorite/unfavorite                                 |
| GET         | `/history`                     | Newest listening events first, including song ID/type/duration |
| DELETE      | `/history`                     | Delete the user's listening events                             |
| GET         | `/notifications`               | In-app inbox                                                   |
| PATCH       | `/notifications/:id/read`      | Mark owned notification read                                   |

## Streaming and listening events

`POST /streaming/:songId` with `{ "quality": "64" }` (also `128`, `192`) returns a protected API media path. Request it with the same Bearer token:

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

Types: `play`, `pause`, `skip`, `completion`, `heartbeat`. Sequence starts at 1 and increments by exactly 1. `seconds` is elapsed listening since the previous event, between 0 and 60; send heartbeats every 15–30 seconds. Duplicate sequence returns the existing event; a gap returns 409. The server bounds duration using its own elapsed time and previous state. Resume with `play`; skip/completion are terminal and require a new streaming session for another play. This tracks engagement, not certified playback or royalty accounting.

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

Plan fields: name, slug, priceMinor (integer currency units), currency, offlineLimit, deviceLimit, offlineDays, qualities, active. Free policy: no offline downloads, one registered device, 64 kbps. Expired/cancelled/inactive-plan subscriptions fall back to free. End users cannot grant themselves subscriptions; verified billing is an integration point.

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
| POST       | `/notifications`                                                                | Queue durable in-app notification; 202                        |
| GET        | `/analytics?days=7`                                                             | Top 100 songs by observed listening duration; 1–90 days       |

Create/update bodies:

- Artist: `{name,bio?}`. Artist names are unique without regard to letter case.
- Album: `{title,artist,releaseDate?}`.
- Category: `{name,slug,parent?}`. Parent must already exist; parent changes are excluded from PATCH, so cycles cannot be introduced through the API. Rename by patching name/slug. Create replacement records to reorganize the tree.
- Tag: `{name,slug}`.
- Song: `{title,artist,album?,language,lyrics?,categories:ID[],tags:ID[]}`. Processing state, GridFS file references, and publication cannot be set through generic updates.
- Playlist: `{owner,name,public,songs:ID[]}`.
- Plan: `{name,slug,priceMinor,currency,offlineLimit,deviceLimit,offlineDays,qualities,active}`. Quota fields cannot change while active subscriptions use the plan; create a new plan version.
- License: `{holder,reference?,startsAt,endsAt,streaming,offline,territories:[],enabled}`. Empty territories means globally licensed. Restricted territories currently deny media access pending a trusted location integration.
- Subscription: `{plan,startsAt,endsAt,status:"active"|"cancelled",externalReference?}`. Replacement revokes existing downloads and device registrations.
- Notification: `{user,title,body,dedupeKey:UUID}`. Same dedupe key is idempotent.

Albums/categories/tags/songs are edited in place rather than hard-deleted to preserve references and listening history. An unused artist can be deleted; artists referenced by a song or album return `ARTIST_IN_USE`. Unpublish songs, disable licenses, or deactivate plans to remove availability.

### Upload workflow

1. Create artist, optional album/categories/tags, then a song.
2. POST raw audio bytes to `/admin/songs/:id/uploads` with `Content-Type: audio/wav` and `X-Upload-Kind: audio`. For cover bytes use `Content-Type: image/jpeg`, `image/png`, or `image/webp` with `X-Upload-Kind: cover`. Audio accepts MP3/WAV/FLAC/MP4; the configured maximum is 200 MiB, covers maximum 10 MiB.
3. The API writes the incoming file to MongoDB GridFS and immediately returns `{status:"queued",jobId}` with 202.
4. Poll `/admin/jobs/:jobId`. Worker validates media and generates 64/128/192 kbps MP3s or a normalized JPEG cover in GridFS. Failed jobs retry with exponential backoff. Reprocessing audio unpublishes the song and requires publishing again.
5. Add a license, then POST `/admin/songs/:id/publish` with `{published:true}`.

Covers attach to songs in this upload flow. Artist and album image support is a future targeted GridFS workflow.
