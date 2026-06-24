# Observability

Make running systems explainable. Scales with project type (a CLI needs little;
a multiplayer server or finance service needs a lot).

## Logging
- **Structured** (JSON) logs with levels; one event = one line.
- Correlation/request IDs threaded through async boundaries.
- Never log secrets or PII.

## Tracing & metrics
- OpenTelemetry traces for services and realtime/multiplayer backends.
- RED metrics (Rate, Errors, Duration) for services; domain metrics as needed.
- Datadog is available (engineering plugin) for dashboards/alerts.

## Errors
- Capture with context; fail loud. No silent catch-and-ignore.
- Health/readiness endpoints for services.
