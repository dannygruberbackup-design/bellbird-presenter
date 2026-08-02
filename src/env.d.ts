interface ImportMetaEnv {
  readonly VITE_MP_SDK_KEY: string;
  readonly VITE_MP_MODEL_SID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface HTMLElementTagNameMap {
    'matterport-viewer': HTMLElement & {

      sdkPromise: Promise<any>;

      playingPromise: Promise<any>;
    };
  }
}

export {};
