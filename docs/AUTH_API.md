# User authentication API

Base URL: `https://YOUR_API_HOST/api/v1` (local default: `http://localhost:4000/api/v1`). All request and response bodies are JSON. The auth router is rate-limited. Passwords, refresh tokens, and Google ID tokens must only be sent over HTTPS outside local development.

## Email signup

`POST /auth/register`

Creates a listener account. Public signup always assigns the `user` role; role changes sent by clients are rejected.

```json
{
  "name": "Listener Name",
  "email": "listener@example.com",
  "password": "a-strong-password"
}
```

Password requirements: 8 or more characters, no more than 72 UTF-8 bytes. Email is normalized to lowercase. Success returns HTTP 201 and the token pair described below. An existing email returns HTTP 409 with `EMAIL_ALREADY_REGISTERED`.

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Listener Name","email":"listener@example.com","password":"a-strong-password"}'
```

## Email login

`POST /auth/login`

```json
{ "email": "listener@example.com", "password": "a-strong-password" }
```

Returns HTTP 200 and a token pair. Invalid credentials and disabled accounts return HTTP 401 `INVALID_CREDENTIALS`.

## Google login

`POST /auth/google`

The web or mobile client obtains an **ID token** from Google Identity Services using its OAuth 2.0 Web client ID, then sends that ID token to this endpoint. Do not send an authorization code or an access token here.

```json
{ "idToken": "GOOGLE_ID_TOKEN_FROM_GOOGLE_IDENTITY_SERVICES" }
```

Example:

```bash
curl -X POST http://localhost:4000/api/v1/auth/google \
  -H 'Content-Type: application/json' \
  -d '{"idToken":"GOOGLE_ID_TOKEN_FROM_GOOGLE_IDENTITY_SERVICES"}'
```

The API verifies the token signature against Google's published signing keys and checks issuer, expiration, configured audience, subject, and verified email. If that verified email already has a password account, Google is linked to the same account. Otherwise, a listener account is created. Google login never grants admin access. Disabled accounts cannot log in.

Setup:

1. Create an OAuth 2.0 **Web application** client in Google Cloud Console and configure the authorized origins/redirects for the client app.
2. Set the resulting client ID as `GOOGLE_CLIENT_ID` in the backend environment. Do not put a Google client secret in the browser or send it to this API.
3. Configure the same client ID in Google Identity Services on the client. Send the returned credential (the ID token) as `idToken`.
4. Restart or redeploy the backend after setting the environment variable.

If Google login is not configured, the endpoint returns HTTP 503 `GOOGLE_LOGIN_NOT_CONFIGURED`. Invalid tokens return HTTP 401 `INVALID_GOOGLE_CREDENTIAL`; an unverified email returns HTTP 401 `GOOGLE_EMAIL_NOT_VERIFIED`. A Google key service outage returns HTTP 503 `GOOGLE_KEYS_UNAVAILABLE`.

## Token response and authenticated calls

Signup, email login, and Google login return the same shape:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 900
}
```

Use the access token on protected API requests:

```http
Authorization: Bearer <accessToken>
```

The access token expires after 15 minutes. Store refresh tokens securely; do not put them in URLs or logs. The app profile can be fetched with `GET /users/me`.

## Refresh session

`POST /auth/refresh` rotates the refresh token. The old refresh token is revoked and must not be reused.

```json
{ "refreshToken": "CURRENT_REFRESH_TOKEN" }
```

Returns the replacement `accessToken`, `refreshToken`, and `expiresIn`. Refresh tokens expire after 30 days. Invalid, expired, or reused tokens return HTTP 401.

## Logout

`POST /auth/logout`

```json
{ "refreshToken": "CURRENT_REFRESH_TOKEN" }
```

Revokes the refresh-token family and returns HTTP 204. Call this when the user signs out, then clear both tokens on the client.

## Auth endpoint summary

| Method | Path | Auth required | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/register` | No | Create listener account with email/password |
| POST | `/auth/login` | No | Sign in with email/password |
| POST | `/auth/google` | No | Sign in or register with verified Google ID token |
| POST | `/auth/refresh` | No | Rotate refresh token |
| POST | `/auth/logout` | No | Revoke refresh-token family |
| GET | `/users/me` | Bearer access token | Read signed-in user profile |
| PATCH | `/users/me` | Bearer access token | Update supported profile fields |

Errors use `{ "error": { "code": "ERROR_CODE", "message": "ERROR_CODE" } }`; validation errors may include `details`. See [API.md](API.md) for catalog, library, playback, and administration endpoints.
