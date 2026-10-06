# Security and client contract

## Authentication

Registration accepts name/email/password only. Passwords are bcrypt-hashed (cost 12); input is limited to 72 UTF-8 bytes to prevent silent truncation. Access tokens are HS256 JWTs with a 15-minute lifetime, issuer and audience checks. Refresh tokens are cryptographically random, with only SHA-256 hashes stored in MongoDB. Refresh rotates atomically in a transaction. Sequential reuse revokes the entire refresh family, including the replacement. Clients must serialize refresh requests. A concurrent loser receives 401 and must log in again; access JWTs already issued remain valid until expiry unless the account is disabled. Logout revokes the refresh family, not the current access JWT.

Each authenticated request reloads the user, so disabling an account or changing its role takes effect on the next request. Client-supplied roles and raw MongoDB filters are never accepted. Administrator creation uses an explicit seed step; users cannot promote themselves through the API.

Mobile clients store refresh tokens in Android Keystore/iOS Keychain-backed storage. Avoid storing admin tokens in browser localStorage; use an application BFF with secure HttpOnly cookies if browser threat requirements demand it. CORS is an allowlist, not authentication. This API uses Authorization headers and does not use ambient cookie credentials.

## Storage and streaming

- MongoDB GridFS stores incoming, processed, and cover media. Database backups must include `media.files` and `media.chunks`; restrict database access to the service identity.
- Audio and cover bytes are served only through authenticated API routes. Account, license, device, or subscription revocation prevents subsequent media requests, though bytes already received by a client cannot be recalled.
- Audio is served as MP3 through the API. These are progressive streams, not HLS/DASH adaptive bitrate manifests.
- Uploads use constrained content types and body-size limits. The worker bounds received bytes, probes content, strips metadata, and re-encodes media before creating the delivery variants.
- Execute FFmpeg in an isolated, unprivileged worker container with CPU/memory/disk limits. Input protocols/formats are allowlisted and subprocesses have time limits. Do not mount API secrets or broad host paths into the worker.
- Incoming GridFS files and old processed variants need a retention/cleanup task; never remove a variant still used by a published song or an active entitlement.

Licenses must permit streaming, be enabled, and fall within their time window. Offline requires a separate permission. Non-empty `territories` deny access until a trusted geolocation service is implemented. Do not trust a mobile-provided country header for rights enforcement.

## Offline design

A download entitlement is tied to user + song + registered device, quality and expiry. It is a permission record, never an audio blob. Expiry is the earliest of the plan's offline duration, subscription expiry and license expiry. Authenticated API media paths recheck current permissions. Registering a device and granting a download take a per-user write lock inside a MongoDB transaction, so simultaneous requests cannot exceed the quota.

The quota counts active **song/device pairs** across the account. The same song on two devices occupies two slots. Expired or revoked grants do not count; refreshing an existing active grant does not consume another slot. Device identifiers are app-generated UUIDs; they identify installations, not hardware attestation. A device revoke also revokes its grants. Admin subscription replacement/cancellation revokes downloads and devices; users then register permitted devices again. Active subscribed plans cannot change quota fields in place; create a new plan version and explicitly move subscriptions.

Recommended mobile playback flow:

1. Authenticate and register an installation UUID.
2. Request an entitlement with song, device ID and quality.
3. Request its download URL; stream downloaded bytes directly into an encrypted local file.
4. Generate per-file AES-GCM keys and wrap/store them using Android Keystore or iOS Keychain/Secure Enclave-backed facilities appropriate to the platform. Do not put plaintext keys alongside audio.
5. Persist entitlement expiry and contentVersion with the file. Use monotonic elapsed time plus last trusted server time to detect clock rollback.
6. Revalidate online when connectivity returns and before renewal. Erase files and keys after expiry, logout, device revoke or failed revalidation. Server-side revocation is not observable while fully offline; offlineDays is the maximum permitted revalidation window.

The backend cannot force an untrusted client to enforce local encryption or expiration. Commercial DRM, device attestation and encrypted packaging/license servers require additional integration if mandated by rights holders.

## Abuse and data handling

Redis-backed rate limits are shared across API replicas: 120 requests/min/IP globally and 10/min/IP for auth. Set exact trusted proxy hops behind an ingress; incorrect trust settings allow IP spoofing. Redis failure fails requests closed. Monitoring should distinguish dependency failure from abusive traffic.

Body size is bounded; IDs, pagination, fields, event sequence and quality are validated. Playlist writes check ownership; private playlists, entitlements and devices are scoped to the authenticated user. Listening duration is capped to server-observed elapsed time, at most 60 seconds per event; paused sessions accrue zero. Telemetry remains client-reported and is not a royalty settlement or fraud-proof accounting system.

Listening events expire after 90 days; playback sessions expire 30 days after their expiration timestamp. MongoDB TTL deletion is asynchronous, so authorization always compares expiry explicitly. Refresh token documents expire using TTL. Other account data needs an organization-specific retention/deletion policy. Logs redact authentication credentials and omit query strings and request bodies.

Reference: [MongoDB GridFS](https://www.mongodb.com/docs/manual/core/gridfs/), [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs).
