# P5-27 controlled fixture TLS certificate (TEST ONLY)

`cert.pem` and `key.pem` are a **self-signed, ephemeral, test-only** certificate pair
generated for the P5-27 email delivery entry gate controlled fixture
(`scripts/evidence/phase5-email-entry-fixture.ts`).

- CN/SAN: `localhost`, `127.0.0.1`; RSA-2048; expires 2036.
- Used ONLY by the local HTTPS fixture server to faithfully implement the Aliyun
  DirectMail RPC protocol over https for deterministic, replayable probe scenarios.
- The probe accepts this certificate ONLY in `--mode fixture` (`fixtureTls: true`);
  REAL-TARGET mode always uses the real `https://dm.aliyuncs.com/` endpoint with
  default TLS validation.
- This key material is NOT a provider credential and never appears in production.
  The Node scanner allowlists only the PEM private-key header line in
  `scripts/secret-scan-allowlist.json` (reason/owner/expiry). There is no
  tests/fixtures directory exemption.
- Do NOT reuse this certificate for any other purpose; regenerate per checkout if desired.
