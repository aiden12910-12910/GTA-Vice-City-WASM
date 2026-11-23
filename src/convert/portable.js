const OPFS_VERSION = "v5";
const READY_MARKER = "_game_ready";
const PACKAGE_DATA = "vcbr/vc-sky-en-v6.data";
const PACKAGE_INDEX = "vcbr/vc-sky-en-v6.json";
const SAVE_DB = "/vc-assets/local/userfiles";
const SAVE_DB_VERSION = 21;
const SKIN_DB = "vc-userdata";
const SKIN_DB_VERSION = 1;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function updateCrc(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function localHeader(name) {
  return concat([
    u32(0x04034b50), u16(20), u16(0x0808), u16(0), u16(0), u16(0),
    u32(0), u32(0), u32(0), u16(name.length), u16(0), name,
  ]);
}

function dataDescriptor(crc, size) {
  return concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
}

function centralHeader(entry) {
  return concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0), u16(0), u16(0),
    u32(entry.crc), u32(entry.size), u32(entry.size), u16(entry.name.length),
    u16(0), u16(0), u16(0), u16(0), u32(0), u32(entry.offset), entry.name,
  ]);
}

function endRecord(count, size, offset) {
  return concat([
    u32(0x06054b50), u16(0), u16(0), u16(count), u16(count),
    u32(size), u32(offset), u16(0),
  ]);
}

async function requestSaveFile() {
  if (typeof window.showSaveFilePicker !== "function") {
    throw new Error("Large streaming ZIP export requires Chrome or Edge on desktop. Open this site in a current desktop browser.");
  }
  return window.showSaveFilePicker({
    suggestedName: "GTA-VC-OPFS.zip",
    types: [{ description: "GTA Vice City portable OPFS backup", accept: { "application/zip": [".zip"] } }],
  });
}

function requestDatabase(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB: " + name));
    request.onblocked = () => reject(new Error("IndexedDB is blocked: " + name));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSaveRecords() {
  const db = await requestDatabase(SAVE_DB, SAVE_DB_VERSION, (database, tx) => {
    const store = database.objectStoreNames.contains("FILE_DATA")
      ? tx.objectStore("FILE_DATA")
      : database.createObjectStore("FILE_DATA");
    if (!store.indexNames.contains("timestamp")) store.createIndex("timestamp", "timestamp", { unique: false });
  });
  try {
    const tx = db.transaction("FILE_DATA", "readonly");
    const store = tx.objectStore("FILE_DATA");
    const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
    return values.map((value, index) => {
      const contents = value && value.contents ? new Uint8Array(value.contents) : new Uint8Array();
      return {
        key: String(keys[index]),
        timestamp: value && value.timestamp instanceof Date ? value.timestamp.getTime() : Date.now(),
        mode: value && Number.isFinite(value.mode) ? value.mode : 0o100666,
        contents,
      };
    }).filter((record) => record.contents.length > 0);
  } finally {
    db.close();
  }
}

async function readSkins() {
  const db = await requestDatabase(SKIN_DB, SKIN_DB_VERSION, (database) => {
    if (!database.objectStoreNames.contains("skins")) database.createObjectStore("skins", { keyPath: "name" });
  });
  try {
    const records = await requestResult(db.transaction("skins", "readonly").objectStore("skins").getAll());
    return records.filter((skin) => skin && skin.name && skin.contents).map((skin) => ({
      name: String(skin.name),
      sourceName: String(skin.sourceName || skin.name),
      converted: Boolean(skin.converted),
      addedAt: skin.addedAt instanceof Date ? skin.addedAt.getTime() : Date.now(),
      contents: new Uint8Array(skin.contents),
    }));
  } finally {
    db.close();
  }
}

async function collectOPFSFiles(root) {
  const files = [];
  const walk = async (directory, prefix) => {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix ? prefix + "/" + name : name;
      if (!prefix && (name === "_import_tmp" || name === "_portable_tmp" || name === "_import_journal" || name === READY_MARKER)) continue;
      if (handle.kind === "directory") {
        await walk(handle, path);
      } else {
        const file = await handle.getFile();
        files.push({ path, file, size: file.size });
      }
    }
  };
  await walk(root, "");
  return files;
}

async function verifyOPFSReady(root) {
  const marker = await (await root.getFileHandle(READY_MARKER)).getFile();
  if (await marker.text() !== OPFS_VERSION) throw new Error("The current OPFS game package is not ready or has an incompatible version.");
  const data = await (await root.getDirectoryHandle("vcbr")).getFileHandle("vc-sky-en-v6.data");
  const index = await (await root.getDirectoryHandle("vcbr")).getFileHandle("vc-sky-en-v6.json");
  if ((await data.getFile()).size < 100 * 1024 * 1024 || (await index.getFile()).size < 2) {
    throw new Error("The OPFS game package is incomplete. Import the original game files first.");
  }
}

export async function exportPortableOPFSBackup(onProgress = () => {}) {
  // Must be the first asynchronous operation so the browser accepts the user gesture.
  const fileHandle = await requestSaveFile();
  const writable = await fileHandle.createWritable();
  let closed = false;
  try {
    const root = await navigator.storage.getDirectory();
    await verifyOPFSReady(root);
    const opfsFiles = await collectOPFSFiles(root);
    if (!opfsFiles.some((entry) => entry.path === PACKAGE_DATA) ||
        !opfsFiles.some((entry) => entry.path === PACKAGE_INDEX)) {
      throw new Error("Required game package files are missing from OPFS.");
    }

    const saves = await readSaveRecords();
    const skins = await readSkins();
    const settings = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) settings[key] = localStorage.getItem(key);
    }

    const saveMeta = saves.map((record, index) => ({
      key: record.key,
      timestamp: record.timestamp,
      mode: record.mode,
      path: "userdata/saves/" + index + ".bin",
      size: record.contents.length,
    }));
    const skinMeta = skins.map((skin, index) => ({
      name: skin.name,
      sourceName: skin.sourceName,
      converted: skin.converted,
      addedAt: skin.addedAt,
      path: "userdata/skins/" + index + ".bmp",
      size: skin.contents.length,
    }));

    const manifest = {
      format: "gta-vice-city-opfs",
      formatVersion: 1,
      opfsVersion: OPFS_VERSION,
      createdAt: new Date().toISOString(),
      files: opfsFiles.map((entry) => ({ path: entry.path, size: entry.size })),
      saves: saveMeta,
      skins: skinMeta,
      settings,
    };
    const encoder = new TextEncoder();
    const manifestBlob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
    const entries = [
      { path: "manifest.json", blob: manifestBlob, size: manifestBlob.size },
      ...opfsFiles.map((entry) => ({ path: "opfs/" + entry.path, blob: entry.file, size: entry.size })),
      ...saves.map((record, index) => ({
        path: saveMeta[index].path,
        blob: new Blob([record.contents]),
        size: record.contents.length,
      })),
      ...skins.map((skin, index) => ({
        path: skinMeta[index].path,
        blob: new Blob([skin.contents]),
        size: skin.contents.length,
      })),
    ];

    if (entries.length > 65535) throw new Error("This portable package contains too many files for the ZIP format.");
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let completed = 0;
    let offset = 0;
    const central = [];

    const write = async (bytes) => {
      if (offset + bytes.length > 0xffffffff) throw new Error("Portable ZIP exceeds the classic ZIP 4 GB limit.");
      await writable.write(bytes);
      offset += bytes.length;
    };

    for (const entry of entries) {
      if (entry.size > 0xffffffff) throw new Error("A file is larger than the supported ZIP entry size.");
      const name = encoder.encode(entry.path);
      const localOffset = offset;
      await write(localHeader(name));
      let crc = 0xffffffff;
      let size = 0;
      const reader = entry.blob.stream().getReader();
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
        crc = updateCrc(crc, chunk);
        size += chunk.length;
        await write(chunk);
        completed += chunk.length;
        onProgress({ done: completed, total, file: entry.path });
      }
      if (size !== entry.size) throw new Error("File changed while exporting: " + entry.path);
      crc = (crc ^ 0xffffffff) >>> 0;
      await write(dataDescriptor(crc, size));
      central.push({ name, crc, size, offset: localOffset });
      onProgress({ done: completed, total, file: entry.path });
    }

    const centralOffset = offset;
    for (const entry of central) await write(centralHeader(entry));
    const centralSize = offset - centralOffset;
    await write(endRecord(central.length, centralSize, centralOffset));
    await writable.close();
    closed = true;
    onProgress({ done: total, total, file: "Complete" });
  } catch (error) {
    if (!closed) {
      try { await writable.abort(); } catch {}
    }
    throw error;
  }
}
