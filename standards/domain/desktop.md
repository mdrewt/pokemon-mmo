# Desktop (Electron)
- Security: `contextIsolation: true`, `nodeIntegration: false`, strict CSP, validated IPC.
- Signed, auto-updatable builds; least-privilege file/network access.
- Separate main/renderer concerns; no Node APIs in the renderer.
- Test core logic headless; e2e via Playwright-for-Electron.
