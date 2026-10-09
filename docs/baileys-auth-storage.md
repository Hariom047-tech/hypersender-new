# Baileys Auth Storage (PostgreSQL, encrypted)

`useMultiFileAuthState()` is **not** used. Production source of truth is PostgreSQL:

| Baileys concept | Table | Row |
|---|---|---|
| `AuthenticationCreds` | `whatsapp_auth_credentials` | one per instance: `encrypted_credentials`, `wrapped_data_key`, `key_reference`, `encryption_version` |
| `SignalKeyStore` (`pre-key`, `session`, `sender-key`, `sender-key-memory`, `app-state-sync-key`, `app-state-sync-version`, `lid-mapping`, `device-list`, `tctoken`, `identity-key`) | `whatsapp_signal_keys` | one per `(instance_id, key_type, key_id)` |

Implementation: `src/whatsapp/postgres-auth-state.ts` (provider-neutral) bound to Baileys types in
`src/whatsapp/providers/baileys/baileys-auth-store.ts` (`initAuthCreds`, Baileys `BufferJSON`, `proto` revival of
`app-state-sync-key`). Wrapped by Baileys' `makeCacheableSignalKeyStore` (in-memory read cache) and Baileys'
internal transaction layer, which commits a logical change set through one `set()` call → one DB transaction.

## Write path
```
Baileys creds/keys object
  → JSON.stringify(value, Baileys BufferJSON.replacer)
  → AES-256-GCM(data key, AAD)                      nonce(12) ‖ ciphertext ‖ tag(16)
  → INSERT/UPDATE inside a transaction that first runs app.assert_instance_lease(instance, worker, token)
```
* Data key: 256-bit, one per instance, from `KeyProvider.generateDataKey({organization_id, purpose:'whatsapp_auth', resource_id})`
  (AWS KMS in production; `LocalKeyProvider` refuses `NODE_ENV=production`). Only the KMS-wrapped form is stored.
* AAD: creds `wa-creds|v1|<org>|<instance>`; keys `wa-key|v1|<org>|<instance>|<type>|<id>` - a blob copied to another
  row/instance/tenant fails authentication.
* Signal keys are written **individually** (batched upsert/delete of only the changed ids via `unnest`); the full auth
  state is never rewritten. `creds.update` events are serialised per session and flushed before any reconnect.
* `clear()` deletes all keys of the instance (fenced).

## Read / restore path
```
SELECT row (tenant context = instance organization) → KMS decrypt wrapped data key → AES-GCM decrypt (AAD)
  → JSON.parse(Baileys BufferJSON.reviver) → AuthenticationCreds / key values → makeWASocket({ auth })
```
Restore uses `requireExisting: true`: if no credentials exist the session is marked `DISCONNECTED (AUTH_MISSING)` instead
of silently creating new credentials (which would demand a QR).

## Fencing (never two writers)
The lease token is incremented on every ownership change. A worker whose lease moved gets `SQLSTATE 55P03 / HINT
HS_LEASE_LOST` on the next write → `LeaseLostError` → the socket is closed locally; nothing is persisted. Tested:
stale worker's `creds.update` after takeover leaves the ciphertext byte-identical.

## Destruction
Logout / 401 / invalid auth / instance delete / organization purge → `app.destroy_whatsapp_auth()` deletes the credential
row; FK `ON DELETE CASCADE` removes every signal key; lease cleared; `CREDENTIALS_DESTROYED` + `LOGGED_OUT` events.
Old tuples remain in WAL/backups as ciphertext under a KMS-wrapped key until they age out (see architecture risks).

## Never logged
Creds, keys, data keys, ciphertext, QR, pairing codes. pino redaction is a backstop; the automated log-hygiene test scans
every log line of a full connect/message/logout flow.

## Schema compatibility with Baileys 7.0.0-rc14
No auth-schema change was needed. Findings (details in `whatsapp-gateway.md`): Baileys' BufferJSON must be used;
new key families fit the existing `key_type` CHECK; the fencing/claim function for re-link after logout was added in
migration 0013.
