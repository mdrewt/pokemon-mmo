# Finance / investment apps (HEIGHTENED)
- **Money type:** integer minor units or Decimal — never floats. Currency-aware.
- **Hard stop:** never execute trades/orders/transfers autonomously (see security.md).
- Idempotent, auditable transactions; append-only ledger; every state change logged.
- Property tests for accounting invariants (sums balance, no negative where illegal).
- Extra review: `/redteam` before shipping anything touching balances or orders.
