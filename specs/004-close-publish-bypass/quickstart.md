# Quickstart: proving an upload cannot ship

Two levels of proof. The suite is the one that runs every time; the live probe is the one that
reproduces the original finding against the running platform, and is what SC-006 means by
"demonstrable".

## Prerequisites

- Postgres for the DB-backed suites: `docker compose -f docker-compose.test.yml up -d --wait`
- For the live probe: the `aerotunnel-platform` stack up (Keycloak on :8081) and this server
  running, with `engineer@rtrobotics.com` holding `aeroserver-publisher` and nothing more.

## Level 1 — the suite

```bash
npm test                    # everything, needs TEST_DATABASE_URL
npm run test:docker         # brings its own Postgres up and down
```

New coverage lands in `tests/upload-cannot-publish.test.js`, alongside the existing
`tests/upload-lands-on-beta.test.js` which already asserts the default landing and must keep
passing untouched.

What that file must establish, one test each:

| Proves | Request | Expect |
|---|---|---|
| FR-001 | publisher token, `?channel=stable` | 403; `stable` unmoved |
| FR-001, both routes | same, to `/releases/{v}/artifacts` | 403 |
| FR-002 | publisher token, no `?channel=` | 201, lands on `beta` |
| FR-002 | publisher token, `?channel=beta` | 201, lands on `beta` |
| edge case | publisher token, `?channel=` (empty) | 201, `promoted_to: null`, no channel moved |
| FR-003 | admin token, `?channel=stable` | 201, `stable` moved — unchanged behaviour |
| FR-004 | publisher token, two-step stage then commit | 201, lands on `beta`, no channel named |
| FR-005 | the 403 body | names `channel:write`, says the upload itself is allowed |
| FR-006 | after the 403 | an `audit` row: actor, `channel.denied`, the channel asked for |
| FR-007 | admin token, `?channel=` pointing beta backwards | 400 with a `channel_rollback` finding carrying `from`/`to` |
| FR-007 | same, plus `?allow_rollback=true` | 201, channel moves |
| edge case | publisher token, `?channel=stable`, invalid gzip body | 403 — the permission answer comes before the archive reader |

That last row is the regression test for the exact shape of the original finding: the refusal
must come from the permission check, not from the bundle reader.

Contract conformance is already enforced — `tests/openapi.test.js` fails if a route serves
something the spec does not describe, so the contract edits in `contracts/api-usage.md` are
verified by a test that already exists.

## Level 2 — the live probe

Reproduces the finding end to end against the real Keycloak, the real token and the real
server. The scratchpad already holds the probe that found it; running it after the fix must
produce a 403 where it previously produced a bundle-reader error.

```bash
# a token for an account holding artifact:write and nothing more
python3 scope_probe.py                       # confirms the scopes on the token
python3 upload_probe.py --channel stable     # expect: 403, naming channel:write
python3 upload_probe.py                      # expect: 201, landed on beta
```

Then confirm from the catalog that `stable` did not move:

```bash
curl -sk https://localhost:8443/admin/api/catalog -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -m json.tool | grep -A3 stable
```

## What a passing run means

An account that may fill the catalog can put a build in the catalog and on the test channel,
and cannot put one in front of an aircraft by any route the upload offers. That is the sentence
the constitution already claims; after this feature it is checked on every test run.
