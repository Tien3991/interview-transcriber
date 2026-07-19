/* Session persistence — IndexedDB-backed.
   Store 'sessions' holds the serialized transcript state (small, rewritten on every save);
   store 'audio' holds the original file blob (large, written once), so position/edit saves
   never rewrite megabytes. Playback position lives in localStorage (synchronous, survives
   pagehide reliably). */

'use strict';

const Sessions = (() => {
  const DB_NAME = 'soniox-transcriber';
  const MAX_SESSIONS = 12;
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
      });
    }
    return dbPromise;
  }

  function op(storeName, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const r = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    }));
  }

  async function list() {
    const all = (await op('sessions', 'readonly', (s) => s.getAll())) || [];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }

  function get(id) {
    return op('sessions', 'readonly', (s) => s.get(id));
  }

  async function save(session) {
    await op('sessions', 'readwrite', (s) => s.put(session));
    await prune();
  }

  function saveAudio(id, blob) {
    return op('audio', 'readwrite', (s) => s.put(blob, id));
  }

  function getAudio(id) {
    return op('audio', 'readonly', (s) => s.get(id));
  }

  // an attached video lives in the same store under a derived key — no schema change
  function saveVideo(id, blob) {
    return op('audio', 'readwrite', (s) => s.put(blob, id + ':video'));
  }

  function getVideo(id) {
    return op('audio', 'readonly', (s) => s.get(id + ':video'));
  }

  function removeVideo(id) {
    return op('audio', 'readwrite', (s) => s.delete(id + ':video'));
  }

  async function remove(id) {
    await op('sessions', 'readwrite', (s) => s.delete(id));
    await op('audio', 'readwrite', (s) => s.delete(id)).catch(() => {});
    await op('audio', 'readwrite', (s) => s.delete(id + ':video')).catch(() => {});
  }

  async function prune() {
    const all = await list();
    for (const s of all.slice(MAX_SESSIONS)) {
      await remove(s.id);
      try { localStorage.removeItem('soniox-transcriber:pos:' + s.id); } catch {}
    }
  }

  return { list, get, save, saveAudio, getAudio, saveVideo, getVideo, removeVideo, remove };
})();
