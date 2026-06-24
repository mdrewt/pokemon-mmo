# Realtime chat
- Authoritative server; idempotent message handling; ordering/dedup guarantees stated.
- Backpressure + reconnection strategy; presence as derived state.
- Redis for pub/sub & ephemeral state; Postgres for durable history.
- Load/soak tests with simulated concurrent clients; deterministic clock in tests.
