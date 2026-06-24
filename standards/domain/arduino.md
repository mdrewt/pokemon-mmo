# Arduino / robotics
- Keep logic in pure, host-testable modules; thin hardware adapter layer.
- Native unit tests run in CI (off-hardware); hardware-in-the-loop runs locally only.
- PlatformIO project layout; pinned toolchain.
- Document wiring/pinout in-repo; treat timing/interrupts as contracts.
