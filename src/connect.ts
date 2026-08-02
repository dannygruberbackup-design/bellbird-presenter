import { diag, describeError } from './diagnostics';

const CONNECT_TIMEOUT_MS = 45_000;

export async function connectSdk(viewer: any): Promise<any> {
  if (!viewer) throw new Error('No <matterport-viewer> element found on the page.');

  const strategies: { name: string; run: () => Promise<any> }[] = [
    {
      name: 'playingPromise',
      run: () => viewer.playingPromise,
    },
    {
      name: 'sdkPromise',
      run: () => viewer.sdkPromise,
    },
    {
      name: 'connect()',
      run: () => viewer.connect?.(),
    },
    {
      name: 'mp-sdk-connected event',
      run: () =>
        new Promise((resolve) => {
          viewer.addEventListener(
            'mp-sdk-connected',
            (evt: any) => resolve(evt?.detail ?? viewer.mpSdk),
            { once: true },
          );
        }),
    },
  ];

  const available = strategies.filter((s) => {
    try {
      return s.name === 'mp-sdk-connected event' || viewer[s.name.replace('()', '')] !== undefined;
    } catch {
      return false;
    }
  });

  diag.info(
    `Viewer handshakes available: ${available.map((s) => s.name).join(', ') || 'none'}`,
  );

  for (const strategy of strategies) {
    let result: any;
    try {
      result = await withTimeout(strategy.run(), CONNECT_TIMEOUT_MS, strategy.name);
    } catch (error) {
      diag.warn(`Handshake ${strategy.name} failed: ${describeError(error)}`);
      continue;
    }

    if (isUsableSdk(result)) {
      diag.info(`Connected via ${strategy.name}.`);
      return result;
    }

    diag.warn(
      `Handshake ${strategy.name} resolved to ${describeValue(result)} — not an SDK.`,
    );
  }

  if (isUsableSdk(viewer.mpSdk)) {
    diag.info('Connected via viewer.mpSdk property.');
    return viewer.mpSdk;
  }

  throw new Error(
    'Could not obtain the Matterport SDK from the viewer. The space itself may ' +
      'have rendered, but no handshake returned a usable SDK object.',
  );
}

function isUsableSdk(value: any): boolean {
  return Boolean(value && typeof value === 'object' && value.Scene && value.Camera);
}

function describeValue(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') return `${typeof value} (${String(value)})`;
  const keys = Object.keys(value).slice(0, 8).join(', ');
  return `object with keys [${keys}]`;
}

function withTimeout<T>(promise: T, ms: number, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle within ${ms / 1000}s`)), ms),
    ),
  ]);
}
