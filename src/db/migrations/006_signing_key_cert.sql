-- Key certificates: a root-signed statement that a signing key is genuine.
--
-- Why this exists. Until now a node pinned the SIGNING key itself, so rotating meant reaching
-- every device — and a server that changed its key without doing so stranded the whole fleet
-- with `signature_invalid` and no way to recover remotely. A certificate moves the pin up one
-- level: the node pins a ROOT whose private half never leaves an offline store, and follows
-- the certificate to whatever signing key is current. The signing key then rotates with
-- nothing provisioned to any device, while a compromised server still cannot mint a key the
-- fleet would trust.
--
-- This server never holds the root's private key. It holds only the certificate it was
-- handed, plus the root's PUBLIC key in config, so it can refuse a certificate it cannot
-- verify — one no node could verify either.
--
-- Keyed by key_id, not "one current row": manifests signed by a retired key stay verifiable
-- as long as their certificate is still here, so a rotation needs no flag day.
CREATE TABLE signing_key_cert (
  key_id      TEXT PRIMARY KEY,
  -- Base64 of the raw 32 ed25519 bytes, stored as the TEXT the root signed over. Never
  -- re-encoded: the signed payload contains this exact string, and a different padding or
  -- alphabet would fail a perfectly good certificate.
  public_key  TEXT        NOT NULL,
  not_before  TIMESTAMPTZ NOT NULL,
  not_after   TIMESTAMPTZ NOT NULL,
  root_key_id TEXT        NOT NULL,
  -- Base64 of the root's 64-byte signature over
  --   key_id \n public_key \n not_before \n not_after
  cert_value  TEXT        NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by TEXT,
  CONSTRAINT signing_key_cert_window CHECK (not_after > not_before)
);
