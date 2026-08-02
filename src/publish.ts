// Sending authored work to the repository.
//
// The author's key is kept in this browser rather than in the build: it is a
// credential, and a credential that ships with the page is a credential that
// has been given away.

import { diag } from './diagnostics';

const KEY_STORE = 'presenter.publishKey';

export function publishKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}

export function setPublishKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORE, key);
  } catch {
    /* private browsing; publishing still works for this session */
  }
}

export type PublishResult = { ok: true; commit: string | null } | { ok: false; error: string };

/** Commits `body` to `path`. Binary is sent raw, not base64 wrapped in JSON. */
export async function publish(
  path: string,
  body: BodyInit,
  message: string,
): Promise<PublishResult> {
  const key = publishKey();
  if (!key) return { ok: false, error: 'No publish key set.' };

  try {
    const response = await fetch(
      `/api/publish?path=${encodeURIComponent(path)}&message=${encodeURIComponent(message)}`,
      {
        method: 'POST',
        headers: { 'x-publish-key': key, 'Content-Type': 'application/octet-stream' },
        body,
      },
    );

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      commit?: string | null;
    };

    if (!response.ok) {
      return { ok: false, error: payload.error ?? `HTTP ${response.status}` };
    }

    diag.info(`Published ${path}${payload.commit ? ` (${payload.commit})` : ''}.`);
    return { ok: true, commit: payload.commit ?? null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
