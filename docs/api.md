# Bridge API

The WhatsApp bridge exposes a small JSON API over HTTP and a WebSocket stream.
Everything except `GET /healthz` requires:

```http
Authorization: Bearer <BRIDGE_TOKEN>
```

`GET /ws` accepts the same header. A `?token=` query parameter is also accepted
for tools that cannot set headers, but headers are preferred.

Base URL examples:

- Add-on: `http://local-whatsapp-web-bridge:3000`
- Docker: `http://192.168.1.20:3000`

Errors always use:

```json
{
  "error": {
    "code": "not_connected",
    "message": "The WhatsApp session is not connected"
  }
}
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid input |
| 401 | Missing or wrong token |
| 404 | Unknown endpoint or unknown recipient |
| 409 | Session is not connected |
| 413 | Body too large (1 MB limit) |
| 502 | WhatsApp rejected the operation |
| 504 | Pairing timed out |

---

## `GET /healthz`

Unauthenticated. Used by container health checks.

```json
{
  "ok": true,
  "status": "connected",
  "instance_id": "3f2c…",
  "version": "1.0.0"
}
```

---

## `GET /api/state`

Returns the complete bridge state.

```json
{
  "instance_id": "3f2c…",
  "status": "connected",
  "me": {
    "id": "15550000000@s.whatsapp.net",
    "name": "Alice",
    "phone": "15550000000",
    "lid": null
  },
  "pairing": null,
  "unread": { "total": 3 },
  "chats": [
    {
      "id": "15551234567@s.whatsapp.net",
      "name": "Bob",
      "is_group": false,
      "unread": 2,
      "timestamp": 1795000496,
      "last_message": {
        "id": "3EB0C767D097",
        "text": "Are you home?",
        "type": "text",
        "timestamp": 1795000496,
        "from_me": false,
        "sender_name": "Bob"
      }
    }
  ],
  "version": "1.0.0",
  "last_error": null,
  "connected_at": "2026-11-20T12:00:00.000Z"
}
```

`status` is one of `starting`, `disconnected`, `connecting`, `pairing`,
`connected`, `logged_out` or `error`.

---

## `POST /api/pair/start`

Starts (or resumes) a pairing attempt and waits up to 25 seconds for a QR code
or a phone pairing code.

### QR

```http
POST /api/pair/start
Content-Type: application/json

{ "method": "qr" }
```

```json
{
  "status": "pairing",
  "pairing": {
    "method": "qr",
    "qr": "data:image/png;base64,iVBORw0…",
    "qr_data": "2@AbCdEf…",
    "code": null,
    "phone": null,
    "error": null,
    "updated_at": "2026-11-20T12:00:00.000Z"
  }
}
```

- `qr_data` is the raw payload to render with any QR library (the Home
  Assistant integration uses the native QR selector).
- `qr` is a pre-rendered PNG data URL for other clients.
- QR codes rotate. Call the endpoint again (or read `/api/state`) to get the
  current one.

### Phone number

```http
POST /api/pair/start
Content-Type: application/json

{ "method": "phone", "phone": "+15551234567" }
```

```json
{
  "status": "pairing",
  "pairing": {
    "method": "phone",
    "qr": "data:image/png;base64,…",
    "qr_data": "2@AbCdEf…",
    "code": "ABCD-EFGH",
    "phone": "15551234567",
    "error": null,
    "updated_at": "2026-11-20T12:00:00.000Z"
  }
}
```

Enter the code on the phone under **Linked devices → Link with phone number
instead**.

If the account is already connected, the endpoint returns the normal state
without starting a new pairing.

---

## `POST /api/pair/cancel`

Stops the socket and clears the pending pairing state. Stored credentials are
kept.

```json
{ "ok": true }
```

---

## `POST /api/logout`

Tells WhatsApp to unlink the device and deletes the stored session on the
bridge. The next pairing requires QR or phone code again.

```json
{ "ok": true }
```

---

## `POST /api/send`

```http
POST /api/send
Content-Type: application/json

{ "to": "+15551234567", "message": "Hello from Home Assistant" }
```

`text` is accepted as an alias for `message`. `to` may be a phone number, a
contact JID or a group JID. Phone numbers are resolved with WhatsApp first.

```json
{
  "message_id": "3EB0C767D097",
  "chat_id": "15551234567@s.whatsapp.net",
  "timestamp": 1795000496
}
```

---

## `POST /api/read`

```http
POST /api/read
Content-Type: application/json

{ "chat": "15551234567@s.whatsapp.net" }
```

Optional `message_ids` array marks specific messages. Without it, the bridge
uses the message keys it tracked for that chat.

```json
{ "ok": true, "chat": "15551234567@s.whatsapp.net", "marked": 2 }
```

---

## `POST /api/typing`

```http
POST /api/typing
Content-Type: application/json

{ "chat": "15551234567@s.whatsapp.net", "state": "composing" }
```

`state` is `composing` (default) or `paused`.

```json
{ "ok": true, "chat": "15551234567@s.whatsapp.net", "state": "composing" }
```

---

## `GET /api/chats`

Returns up to 500 known chats, newest activity first.

```json
{ "chats": [ { "id": "…", "name": "…", "unread": 0, "last_message": { … } } ] }
```

---

## `GET /api/version`

```json
{ "version": "1.0.2", "instance_id": "3f2c…" }
```

---

## WebSocket `GET /ws`

On connect the server sends a `hello` frame with the current state:

```json
{ "type": "hello", "data": { …state… }, "at": "2026-11-20T12:00:00.000Z" }
```

Subsequent frames use the same envelope:

| `type` | `data` |
| --- | --- |
| `hello` | Full state (same shape as `GET /api/state`) |
| `connection` | `{ status, me, last_error, connected_at }` |
| `pairing` | `{ method, qr, qr_data, code, phone, error, updated_at }` or `{ method: "done", done: true }` |
| `unread` | `{ total, chats: [{ id, name, is_group, unread, timestamp }] }` |
| `message` | The message payload documented in the README |

Message frames include `chat_id`, `chat_id_alt`, `chat_name`, `group_name`,
`sender_id`, `sender_name` and `sender_username`. Display names come from push
names, contacts and group metadata. If a name or username is unavailable, the
field is the literal string `unknown`; phone numbers are never used as display
names. `group_name` is `null` for direct chats and `unknown` for a group whose
subject is not known yet. `chat_id_alt` is the alternate LID/PN identifier when
WhatsApp uses both for the same conversation.

Unread chats also report `name: "unknown"` rather than a phone number when no
display name is known.

Clients may send `{ "type": "ping" }` and receive `{ "type": "pong" }`. Protocol
pings are sent every 30 seconds; a client that misses one is disconnected.

Read state from the phone or another linked device is applied through WhatsApp
read receipts and app-state sync. LID and PN identifiers are aliased, so a read
under either identifier clears the same chat.

Reconnect with backoff and refetch `GET /api/state` after reconnecting. The
stream has no replay buffer; `hello` is the resync point.
