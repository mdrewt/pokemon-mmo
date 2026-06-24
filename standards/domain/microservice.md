# Microservice
- Explicit API contract (OpenAPI) as SSOT; contract tests both sides (Postman/Pact).
- Idempotent handlers; retries with backoff; timeouts on all IO.
- Schema-versioned messages for Kafka; consumer/producer contract tests.
- Health/readiness endpoints; graceful shutdown; OTel tracing across hops.
