# Games (PixiJS / multiplayer)
- Deterministic simulation: fixed timestep, seedable RNG, no wall-clock in sim.
- Separate simulation from rendering; sim is unit-testable headless.
- Multiplayer: authoritative server; clients predict + reconcile; never trust client.
- Netcode tests with simulated latency/loss; snapshot/replay determinism tests.
