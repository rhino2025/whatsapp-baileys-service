# HostStay WhatsApp Transport (Baileys)

Stateless-ish HTTP wrapper around [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys)
that HostStay's edge functions call to manage WhatsApp Business sessions.

HostStay owns: tenants, permissions, inbox, automations, audit.
This service owns: socket lifecycle, QR/pairing codes, message I/O, reconnects.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. Create a new Railway project → "Deploy from repo".
3. Add a **Volume** mounted at `/data` (or set `AUTH_DIR` to your preferred path) so credentials survive restarts.
4. Add env vars:
   - `RAILWAY_TOKEN` — long random string, MUST match Lovable Cloud secret `WHATSAPP_RAILWAY_TOKEN`.
   - `AUTH_DIR=/data/auth`
5. Deploy. Note the public URL (e.g. `https://hoststay-wa.up.railway.app`).

## Wire to HostStay

In Lovable Cloud secrets, set:

- `WHATSAPP_RAILWAY_URL` → the Railway URL above.
- `WHATSAPP_RAILWAY_TOKEN` → the same token as `RAILWAY_TOKEN`.

That's it. The HostStay UI will call `POST /sessions/start` and this service will
post QR + lifecycle events back to `/functions/v1/whatsapp-railway-callback`.

## HTTP contract

All requests require `Authorization: Bearer $RAILWAY_TOKEN`.

### `POST /sessions/start`
Body: `{ session_id, tenant_id, account_id, phone_number, callback_url, callback_token }`
→ Boots a Baileys socket. Streams QR/pairing/connected/disconnected events to `callback_url`.

### `POST /sessions/restart`
Same body. Closes any existing socket for `session_id`, wipes QR cache, restarts.

### `POST /sessions/disconnect`
Body: `{ session_id }` — logs out, clears credentials.

### `POST /sessions/send`
Body: `{ session_id, to, text }` — sends a text message.

### `GET /sessions/:id/status`
Returns `{ status, last_seen_at }`.

## Callback events posted to HostStay

`POST $callback_url` with `Authorization: Bearer $callback_token` and JSON:

```json
{ "account_id": "...", "session_id": "...", "event_type": "qr|pairing_code|qr_expired|scanned|connected|disconnected|reconnect_required|failed|rate_limited|logged_out", "qr": "...", "pairing_code": "...", "qr_expires_at": "...", "reason": "...", "display_name": "..." }
```
