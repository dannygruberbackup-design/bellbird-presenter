// Commits a file to the repository on the author's behalf.
//
// The obvious version of this puts a GitHub token in the browser and calls the
// API directly. That token is then readable by anyone who opens the site, and a
// token with write access to the repository is not a thing to hand out with the
// page. So the token stays here, in a Vercel environment variable, and the
// browser talks to this endpoint instead.
//
// Access is a shared key, checked below. It is not sophisticated - one key, one
// author - but it is honest about what it protects, and it can be changed in
// the Vercel dashboard without touching the code.
//
// Environment variables required:
//   GITHUB_TOKEN    fine-grained token, Contents: read and write, this repo only
//   PUBLISH_KEY     whatever you like; the author enters the same string once
//   GITHUB_REPO     e.g. dannygruberbackup-design/bellbird-presenter

const API = 'https://api.github.com';

/** Reads the raw request body. Binary is sent as-is rather than base64 in JSON:
 *  base64 inflates by a third, and a serverless request body is capped at about
 *  4.5MB, so encoding it would cost a megabyte of headroom on every clip. */
async function readBody(req: any): Promise<Buffer> {
  if (req.body instanceof Buffer) return req.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const key = process.env.PUBLISH_KEY;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!key || !token || !repo) {
    res.status(500).json({ error: 'Publishing is not configured on the server.' });
    return;
  }

  if (req.headers['x-publish-key'] !== key) {
    res.status(401).json({ error: 'Wrong publish key.' });
    return;
  }

  const path = String(req.query?.path ?? '');
  // Traversal check before anything else: this endpoint writes to a repository,
  // and a path is the one thing here that comes entirely from the caller.
  if (!path || path.includes('..') || path.startsWith('/')) {
    res.status(400).json({ error: 'Bad path.' });
    return;
  }

  const message = String(req.query?.message ?? `Publish ${path}`);

  try {
    const body = await readBody(req);
    if (body.length === 0) {
      res.status(400).json({ error: 'Empty body.' });
      return;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };

    // An update needs the blob sha of what it replaces; a new file must not send
    // one at all. Asking first is a round trip, and cheaper than the confusing
    // 422 you get for guessing wrong.
    let sha: string | undefined;
    const existing = await fetch(`${API}/repos/${repo}/contents/${path}`, { headers });
    if (existing.ok) {
      sha = ((await existing.json()) as { sha?: string }).sha;
    }

    const put = await fetch(`${API}/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message,
        content: body.toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });

    if (!put.ok) {
      const detail = await put.text();
      res.status(put.status).json({ error: detail.slice(0, 400) });
      return;
    }

    const result = (await put.json()) as { commit?: { sha?: string } };
    res.status(200).json({
      ok: true,
      path,
      bytes: body.length,
      commit: result.commit?.sha?.slice(0, 7) ?? null,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
}
