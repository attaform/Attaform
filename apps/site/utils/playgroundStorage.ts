// On-device persistence for the interactive playground editors (#469).
//
// Every editable demo (the homepage hero, /demos/blank, /demos/shipment,
// and each /demos/<slug>) writes its edited files here, so a refresh or
// an accidental swipe-back no longer discards a reader's work. State
// lives in IndexedDB on the reader's own device: it never leaves the
// browser, it's scoped to this origin, and it's clearable per-demo (the
// Reset control in the editor) or all at once (the demos index page).
//
// IndexedDB over localStorage on purpose: writes land off the main
// thread, so saving on each keystroke never janks the editor, and the
// quota comfortably holds many multi-file demos. Every call is wrapped
// so a blocked store (private-mode Safari, disabled storage, a failed
// upgrade) degrades to a no-op instead of throwing into the editor,
// matching the best-effort contract the rest of the demo surface keeps.

const DB_NAME = 'attaform-playground'
const STORE_NAME = 'demos'
const DB_VERSION = 1

// One persisted demo buffer. `files` holds the user-editable files only:
// the hidden playground-globals.d.ts and tsconfig.json seed fresh on
// every mount, so they never round-trip through storage. `savedAt` is a
// millisecond timestamp kept for future housekeeping and display.
export interface StoredDemo {
  files: Record<string, string>
  savedAt: number
}

// The open request is shared across calls: the database opens once per
// page and every read/write reuses the resolved connection. Resolves to
// null (never rejects) when IndexedDB is unavailable or the open fails.
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

// Run one request inside a transaction, resolving to its result or to
// null on any failure. `mode` is 'readonly' for gets, 'readwrite' for
// puts/deletes/clears.
function runRequest<T>(
  mode: IDBTransactionMode,
  build: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const request = build(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
  )
}

// The saved user files for `key`, or null when nothing is stored (or
// storage is unavailable).
export function getDemoFiles(key: string): Promise<Record<string, string> | null> {
  return runRequest<StoredDemo | undefined>('readonly', (store) => store.get(key)).then((result) =>
    result && result.files ? result.files : null
  )
}

// Persist `files` under `key`, stamping the save time. Overwrites any
// existing entry for that key.
export function setDemoFiles(key: string, files: Record<string, string>): Promise<void> {
  const record: StoredDemo = { files, savedAt: Date.now() }
  return runRequest('readwrite', (store) => store.put(record, key)).then(() => undefined)
}

// Drop the entry for one demo. Used when a reader hits Reset or hand-
// reverts a demo back to its shipped source.
export function deleteDemoFiles(key: string): Promise<void> {
  return runRequest('readwrite', (store) => store.delete(key)).then(() => undefined)
}

// Every key that currently holds saved edits. Backs the count shown by
// the demos-index "clear all" control.
export function listDemoKeys(): Promise<string[]> {
  return runRequest<IDBValidKey[]>('readonly', (store) => store.getAllKeys()).then((keys) =>
    Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []
  )
}

// Wipe every saved demo across the whole playground.
export function clearAllDemoFiles(): Promise<void> {
  return runRequest('readwrite', (store) => store.clear()).then(() => undefined)
}
