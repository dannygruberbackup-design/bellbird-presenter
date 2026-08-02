type Level = 'info' | 'warn' | 'error';

const entries: { level: Level; text: string }[] = [];

let panel: HTMLElement | null = null;
let list: HTMLElement | null = null;
let forced = false;

let dismissed = false;

export function initDiagnostics(force: boolean): void {
  forced = force;

  panel = document.createElement('aside');
  panel.id = 'diag-panel';
  panel.hidden = !force;
  panel.innerHTML =
    '<header><span class="label">Diagnostics</span>' +
    '<button type="button" id="diag-copy">Copy</button>' +
    '<button type="button" id="diag-close">Hide</button></header>' +
    '<ol id="diag-list"></ol>';
  document.body.appendChild(panel);

  list = panel.querySelector('#diag-list');

  panel.querySelector('#diag-close')!.addEventListener('click', () => {
    dismissed = true;
    panel!.hidden = true;
  });

  panel.querySelector('#diag-copy')!.addEventListener('click', () => {
    const text = entries.map((e) => `[${e.level}] ${e.text}`).join('\n');
    navigator.clipboard?.writeText(text).catch(() => {

    });
  });

  for (const entry of entries) paint(entry);
}

function paint(entry: { level: Level; text: string }) {
  if (!list) return;
  const li = document.createElement('li');
  li.className = `diag-${entry.level}`;
  li.textContent = entry.text;
  list.appendChild(li);
}

function record(level: Level, text: string) {
  const entry = { level, text };
  entries.push(entry);
  paint(entry);

  if (panel && !dismissed && (forced || level !== 'info')) panel.hidden = false;
  if (panel && dismissed && level === 'error') panel.hidden = false;

  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  console[method](`[presenter] ${text}`);
}

export const diag = {
  info: (text: string) => record('info', text),
  warn: (text: string) => record('warn', text),
  error: (text: string) => record('error', text),
};

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const frame = error.stack?.split('\n')[1]?.trim() ?? '';
    return `${error.name}: ${error.message}${frame ? ` (${frame})` : ''}`;
  }
  return String(error);
}
