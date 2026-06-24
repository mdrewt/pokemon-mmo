# Web application
- SSOT for types shared client/server (generate from one schema).
- Validate all input at the server boundary (zod/pydantic); never trust the client.
- AuthN/AuthZ checks on every protected route; CSRF/CORS configured explicitly.
- Observability: request IDs, structured logs, RED metrics.
