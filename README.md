# Bellbird virtual presenter

A chroma-keyed video presenter composited into a Matterport scan of the Bellbird
showroom. She stands in the room, turns to face you, and speaks — or waits
behind a marker until someone comes close.

Live: https://bellbird-prototype-dannygruberbackup-designs-projects.vercel.app

## Running it

    npm install
    npm run dev

`npm install` also runs `matterport-assets public`, which unpacks the viewer's
runtime assets. The build will not work without them.

## Authoring

Open the site with `?dev=1` for the placement panel. Everything you change there
saves to this browser, per presenter: position, height, framing, marker, sign,
video. It is a convenience for authoring, not publishing — to make a change
permanent for visitors, copy the numbers into `src/presenters.config.ts`.

`?diag=1` shows the on-screen log without the panel.

## Two Matterport bugs worked around here

**`window.THREE` gets a null-prototype namespace.** `@matterport/webcomponent`
does `window.THREE = window.THREE || o`, where `o` is a bundler module namespace
with `__proto__: null`. Matterport's own proxy factory then calls
`hasOwnProperty` on it, which does not exist, and *every* scene component throws
— built-in or custom. `index.html` intercepts the assignment and repairs it.
This is deliberately done with a property setter rather than by assigning
`window.THREE` first: assignment-first works only while the fix lives in its own
module, and breaks again the moment anything is bundled, because ES imports
hoist above every statement.

**`outputs.objectRoot` is reserved.** The bundle installs `objectRoot` and
`collider` itself and throws if either is already present, so the `outputs`
initialiser in `presenter-component.ts` must stay empty. Do not add keys to it.

## Where the numbers came from

The chroma key values in `src/presenters.config.ts` were measured from the
supplied footage, not guessed. The key colour is a soft sage (`#50895b`), not
broadcast green, and sits only 0.11 from neutral grey in chroma space — an
assumed green would have keyed nothing. Details are in the comments there and in
`src/chroma-key-material.ts`.

Wordmark colours for the marker were sampled from the logo bitmap on
bellbird.com.au, letter block by letter block.

## Deploying

Vercel builds from `main` on every push. There is no manual deploy step.

## Publishing from the author panel

Everything authored in the browser - zones, captured views, uploaded clips -
lives in that browser. That is right while drawing and useless afterwards: a
visitor has none of it. The Publish section in the author panel is the bridge.

**Publish zone map** rewrites `src/areas.published.ts` and commits it. It is a
TypeScript module rather than JSON so it compiles into the bundle: a visitor has
the zones before the first frame, with no fetch to wait for and nothing to fail.

**Publish clip for this zone** commits the uploaded video to
`public/clips/<zone-id>.mp4`, which is served at `/clips/<zone-id>.mp4`.

Either one triggers a Vercel rebuild, so changes are live in a minute or so.

### Setting it up (once)

The GitHub token stays on the server. A token in the browser is a token anyone
who opens the site can read, and this one can write to the repository.

In the Vercel project, Settings -> Environment Variables:

| Name | Value |
| --- | --- |
| `GITHUB_TOKEN` | fine-grained token, Contents: read and write, this repo only |
| `GITHUB_REPO` | `dannygruberbackup-design/bellbird-presenter` |
| `PUBLISH_KEY` | any string you choose |

Then enter the same `PUBLISH_KEY` once in the author panel. It is kept in your
browser, not in the build.

### The size limit is real

A serverless request body is capped at roughly 4.5MB, so clips must be under
about 4MB. Binary is sent raw rather than base64 for this reason - encoding
would spend a third of the budget on nothing. Longer clips need either
compression or a proper video host, and the host is the better answer once
there are nineteen of them.
