// Ephemeral notifications — the single place a rejected action (or any transient message) becomes
// visible. Reducer calls are routed through net's error seam (connection.ts) into `toast`, so a
// failed action ("you have no bait", "this monster can't evolve into that yet", …) is shown instead
// of silently doing nothing. Plain DOM, like the other overlays; no Pixi, no state ownership.

const STACK_ID = 'toast-stack';
const VISIBLE_MS = 3200;

function stack(): HTMLDivElement {
  let el = document.getElementById(STACK_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = STACK_ID;
    el.style.cssText =
      'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);display:flex;flex-direction:column;' +
      'gap:6px;align-items:center;z-index:1000;pointer-events:none;';
    document.body.appendChild(el);
  }
  return el;
}

/** Show a transient message. `kind` only tints it; the default `error` suits rejected actions. */
export function toast(message: string, kind: 'error' | 'info' = 'error'): void {
  const el = document.createElement('div');
  el.textContent = message;
  el.dataset.toast = kind; // test hook for the e2e
  const bg = kind === 'error' ? 'rgba(120,32,40,0.95)' : 'rgba(28,40,60,0.95)';
  el.style.cssText =
    `max-width:80vw;padding:9px 14px;border-radius:8px;background:${bg};color:#f3f4f6;` +
    'font:13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.4);opacity:0;transition:opacity 0.15s;';
  stack().appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
  });
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, VISIBLE_MS);
}
