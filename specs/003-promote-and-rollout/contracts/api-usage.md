# Contract: what these screens use, and the two gaps to close first

`api/openapi.yaml` is the contract, and `tests/openapi.test.js` asserts it against the route
table in both directions.

| Operation | Scope | Used for |
|---|---|---|
| `GET /admin/api/catalog` | `catalog:read` | systems, channels and stray channels in one request |
| `GET /admin/api/systems` | `catalog:read` | the system list on its own |
| `POST /admin/api/systems` | `system:write` | create |
| `DELETE /admin/api/systems/{name}` | `system:write` | remove |
| `PUT /admin/api/systems/{system}/channels/{name}` | `channel:write` | **promote — the only action that reaches an aircraft** |
| `GET /admin/api/reports` | `catalog:read` | outcome roll-up and recent reports |
| `GET /admin/api/auth/me` | `self` | which of the above to offer |

## Gap 1 — `Finding` does not declare `from` and `to`

The rollback refusal carries them and the screen cannot state the move without them.

**Fix**: add both as optional fields on `Finding`, then regenerate. Optional because bundle
inspection findings do not carry them.

## Gap 2 — `stray_channels` declares two fields of four

The server sends `nodes` and `last_seen` as well. Without them the banner degrades into a list
of names, which is the difference between "an incident is happening now" and "a channel exists
somewhere".

**Fix**: describe all four in `Catalog.stray_channels`, then regenerate.

Both gaps are closed in this feature, not after it: a screen rendering fields the contract does
not declare is hand-writing shapes under another name (Constitution VI).

## Relied-upon behaviour beyond the shapes

1. **The server owns the rollback comparison.** The client must not decide client-side whether
   a move is backwards — it sends, and reacts to the refusal. Version comparison is numeric and
   lives in the server's domain layer; a second implementation in the browser would be a second
   opinion.
2. **`allow_rollback: true` is the override, sent only after a person confirms.**
3. **`released` reports what was cleared.** A release lives on one channel at a time.
4. **Promotion takes a version and nothing else.** There is no request shape that lets this
   screen do anything but point one channel at one release.
