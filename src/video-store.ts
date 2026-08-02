const DB_NAME = 'presenter-media';
const STORE = 'videos';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export type StoredVideo = { bytes: ArrayBuffer; type: string; name: string; savedAt: number };

export async function saveVideo(id: string, file: File): Promise<void> {
  const bytes = await file.arrayBuffer();
  await tx('readwrite', (s) =>
    s.put(
      {
        bytes,
        type: file.type || 'video/mp4',
        name: file.name,
        savedAt: Date.now(),
      } as StoredVideo,
      id,
    ),
  );
}

export type RestoredVideo = { blob: Blob; name: string; sizeMb: number };

export async function loadVideo(id: string): Promise<RestoredVideo | null> {
  try {
    const found = await tx<StoredVideo | undefined>('readonly', (s) => s.get(id));
    if (!found?.bytes || found.bytes.byteLength === 0) return null;
    return {
      blob: new Blob([found.bytes], { type: found.type || 'video/mp4' }),
      name: found.name,
      sizeMb: found.bytes.byteLength / 1024 / 1024,
    };
  } catch {

    return null;
  }
}

export async function clearVideo(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {

  }
}
