-- Self-service registration attempts, kept purely as a rate-limit ledger.
--
-- A row lands BEFORE the Keycloak call, not after: the call takes up to ten seconds, and a
-- burst of concurrent requests would otherwise all pass the ceiling check while none of them
-- had been counted yet. Whether the account was actually created is the audit log's job.
CREATE TABLE registration_attempt (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip       TEXT,
  username TEXT
);

CREATE INDEX registration_attempt_ip_idx ON registration_attempt (ip, at DESC);
