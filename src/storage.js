/**
 * Opt-in local-only album persistence backed by IndexedDB.
 * Disabled by default to preserve ephemeral privacy; never performs network I/O.
 */

const DB_NAME = 'memoria-local-vault-v1';
const DB_VERSION = 1;
const STORE_NAME = 'album_entries';
const PREF_KEY = 'memoria:remember-album';
const MAX_STORED_FILES = 3000;

export class AlbumVault {
  constructor({
    indexedDBImpl = globalThis.indexedDB,
    storage = globalThis.localStorage,
  } = {}) {
    this._idb = indexedDBImpl || null;
    this._storage = storage || null;
    this._dbPromise = null;
  }

  isSupported() {
    return Boolean(this._idb && typeof this._idb.open === 'function');
  }

  get enabled() {
    try {
      return this._storage?.getItem(PREF_KEY) === 'true';
    } catch {
      return false;
    }
  }

  async setEnabled(value) {
    const next = Boolean(value) && this.isSupported();
    try {
      if (next) this._storage?.setItem(PREF_KEY, 'true');
      else this._storage?.removeItem(PREF_KEY);
    } catch {}
    if (!next) {
      await this.clear().catch(() => {});
    }
    return next;
  }

  _open() {
    if (!this.isSupported()) {
      return Promise.reject(new Error('当前浏览器不支持 IndexedDB 本地存储。'));
    }
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = this._idb.open(DB_NAME, DB_VERSION);
      } catch (err) {
        this._dbPromise = null;
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'seq' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        this._dbPromise = null;
        reject(req.error || new Error('无法打开本地相册数据库。'));
      };
    });
    return this._dbPromise;
  }

  async saveFiles(files) {
    if (!this.enabled || !this.isSupported()) return { saved: 0, totalBytes: 0 };
    const list = Array.from(files || []).slice(0, MAX_STORED_FILES);
    if (!list.length) return { saved: 0, totalBytes: 0 };
    const db = await this._open();
    let totalBytes = 0;
    const records = list.map((file, seq) => {
      const size = Number(file.size) || 0;
      totalBytes += size;
      return {
        seq,
        name: file.name || `Photo ${seq + 1}`,
        type: file.type || 'image/jpeg',
        lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
        size,
        blob: file instanceof Blob ? file : new Blob([file], { type: file.type || 'application/octet-stream' }),
      };
    });

    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const rec of records) {
        store.put(rec);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('写入本地相册缓存失败（可能超出磁盘配额）。'));
      tx.onabort = () => reject(tx.error || new Error('本地相册写入已中止。'));
    }));

    return { saved: records.length, totalBytes };
  }

  async loadFiles() {
    if (!this.enabled || !this.isSupported()) return [];
    const db = await this._open();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('读取本地缓存相册失败。'));
    });
    records.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return records
      .filter(rec => rec?.blob && (rec.blob.size > 0 || rec.size > 0))
      .map(rec => {
        if (typeof File === 'function') {
          return new File([rec.blob], rec.name || 'photo.jpg', {
            type: rec.type || rec.blob.type || 'image/jpeg',
            lastModified: Number.isFinite(rec.lastModified) ? rec.lastModified : Date.now(),
          });
        }
        return rec.blob;
      });
  }

  async getStats() {
    if (!this.isSupported()) return { count: 0, totalBytes: 0 };
    try {
      const db = await this._open();
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      let totalBytes = 0;
      for (const rec of records) totalBytes += Number(rec?.size ?? rec?.blob?.size) || 0;
      return { count: records.length, totalBytes };
    } catch {
      return { count: 0, totalBytes: 0 };
    }
  }

  async clear() {
    if (!this.isSupported()) return;
    const db = await this._open();
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  dispose() {
    if (!this._dbPromise) return;
    this._dbPromise.then(db => { try { db.close(); } catch {} }).catch(() => {});
    this._dbPromise = null;
  }
}
