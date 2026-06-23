// Simple HTML-overlay name-entry screen shown before joining the game. Returns the chosen
// name via a promise; the caller then calls joinGame(name) and starts the game.

export function showNameEntry(): Promise<string> {
  return new Promise<string>((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'name-entry';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      background: 'rgba(10, 12, 20, 0.92)',
      color: '#e8ecf5',
      fontFamily: 'system-ui, sans-serif',
      zIndex: '1000',
    } satisfies Partial<CSSStyleDeclaration>);

    const title = document.createElement('h1');
    title.textContent = 'Monster Tamer MMO';
    title.style.fontSize = '28px';
    title.style.fontWeight = '600';

    const form = document.createElement('form');
    Object.assign(form.style, {
      display: 'flex',
      gap: '8px',
    } satisfies Partial<CSSStyleDeclaration>);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Enter a display name';
    input.maxLength = 20;
    input.autocomplete = 'off';
    Object.assign(input.style, {
      padding: '10px 12px',
      fontSize: '16px',
      borderRadius: '6px',
      border: '1px solid #3a4760',
      background: '#1a2030',
      color: '#e8ecf5',
      minWidth: '240px',
    } satisfies Partial<CSSStyleDeclaration>);

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Join';
    Object.assign(button.style, {
      padding: '10px 18px',
      fontSize: '16px',
      borderRadius: '6px',
      border: 'none',
      background: '#4f74c8',
      color: '#fff',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);

    form.append(input, button);
    overlay.append(title, form);
    document.body.appendChild(overlay);
    input.focus();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name.length === 0) {
        input.focus();
        return;
      }
      overlay.remove();
      resolve(name);
    });
  });
}
