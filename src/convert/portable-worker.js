import {
  GAME_ENTRIES,
  OPFS_VERSION,
  PACKAGE_DATA,
  PACKAGE_INDEX,
  READY_MARKER,
} from "./layout.js";
import { removeEntry, syncAccess } from "./opfs.js";
import { zipSource, ZipError } from "./sources.js";

const CHUNK_SIZE = 16 * 1024 * 1024;
// Slicing-by-8 CRC32: validate large audio/data files with fewer JS loop iterations.
const crcTables = (() => {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tables[0][n] = c >>> 0;
  }
  for (let table = 1; table < 8; table++) {
    for (let n = 0; n < 256; n++) {
      const c = tables[table - 1][n];
      tables[table][n] = (tables[0][c & 255] ^ (c >>> 8)) >>> 0;
    }
  }
  return tables;
})();
function updateCrc(crc, bytes) {
  const t = crcTables;
  let i = 0;
  const limit = bytes.length - 7;
  while (i < limit) {
    crc = (crc ^ (
      bytes[i] |
      (bytes[i + 1] << 8) |
      (bytes[i + 2] << 16) |
      (bytes[i + 3] << 24)
    )) >>> 0;
    crc = (
      t[7][crc & 255] ^
      t[6][(crc >>> 8) & 255] ^
      t[5][(crc >>> 16) & 255] ^
      t[4][crc >>> 24] ^
      t[3][bytes[i + 4]] ^
      t[2][bytes[i + 5]] ^
      t[1][bytes[i + 6]] ^
      t[0][bytes[i + 7]]
    ) >>> 0;
    i += 8;
  }
  while (i < bytes.length) {
    crc = t[0][(crc ^ bytes[i++]) & 255] ^ (crc >>> 8);
  }
  return crc >>> 0;
}
function safePath(path) {
  return typeof path === "string" && path.length > 0 &&
    !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":"));
}
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}
function openDatabase(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB: " + name));
    request.onblocked = () => reject(new Error("IndexedDB is blocked: " + name));
  });
}
async function restoreSaveRecords(manifest, source) {
  const records = [];
  for (const item of manifest.saves || []) {
    if (!safePath(item.path) || !source.paths.includes(item.path) || source.method(item.path) !== 0) {
      throw new Error("Invalid or compressed save entry in portable ZIP.");
    }
    const bytes = await source.read(item.path);
    if (bytes.length !== item.size) throw new Error("Save entry size mismatch: " + item.path);
    const crc = (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
    if (crc !== source.crc(item.path)) throw new Error("Save entry checksum mismatch: " + item.path);
    records.push({
      key: String(item.key),
      value: { timestamp: new Date(Number(item.timestamp) || Date.now()), mode: Number(item.mode) || 0o100666, contents: bytes },
    });
  }
  const db = await openDatabase("/vc-assets/local/userfiles", 21, (database, tx) => {
    const store = database.objectStoreNames.contains("FILE_DATA")
      ? tx.objectStore("FILE_DATA")
      : database.createObjectStore("FILE_DATA");
    if (!store.indexNames.contains("timestamp")) store.createIndex("timestamp", "timestamp", { unique: false });
  });
  try {
    const tx = db.transaction("FILE_DATA", "readwrite");
    const store = tx.objectStore("FILE_DATA");
    store.clear();
    for (const record of records) store.put(record.value, record.key);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}
async function restoreSkins(manifest, source) {
  const records = [];
  for (const item of manifest.skins || []) {
    if (!safePath(item.path) || !source.paths.includes(item.path) || source.method(item.path) !== 0) {
      throw new Error("Invalid or compressed skin entry in portable ZIP.");
    }
    const bytes = await source.read(item.path);
    if (bytes.length !== item.size) throw new Error("Skin entry size mismatch: " + item.path);
    const crc = (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
    if (crc !== source.crc(item.path)) throw new Error("Skin entry checksum mismatch: " + item.path);
    records.push({
      name: String(item.name),
      sourceName: String(item.sourceName || item.name),
      converted: Boolean(item.converted),
      addedAt: new Date(Number(item.addedAt) || Date.now()),
      contents: bytes,
    });
  }
  const db = await openDatabase("vc-userdata", 1, (database) => {
    if (!database.objectStoreNames.contains("skins")) database.createObjectStore("skins", { keyPath: "name" });
  });
  try {
    const tx = db.transaction("skins", "readwrite");
    const store = tx.objectStore("skins");
    store.clear();
    for (const record of records) store.put(record);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}
async function writeOPFSFile(root, path, source, zipPath, expectedSize, expectedCrc, report) {
  const parts = path.split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const handle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
  const access = await syncAccess(handle);
  let offset = 0;
  let crc = 0xffffffff;
  try {
    access.truncate(0);
    while (offset < expectedSize) {
      const length = Math.min(CHUNK_SIZE, expectedSize - offset);
      const bytes = await source.readRange(zipPath, offset, length);
      if (!bytes.length) throw new Error("Unexpected end of ZIP entry: " + zipPath);
      access.write(bytes, { at: offset });
      crc = updateCrc(crc, bytes);
      offset += bytes.length;
      report(offset);
    }
    access.flush();
  } finally {
    access.close();
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  if (offset !== expectedSize || crc !== expectedCrc) throw new Error("File checksum mismatch: " + path);
}
async function writeMarker(root) {
  const handle = await root.getFileHandle(READY_MARKER, { create: true });
  const access = await syncAccess(handle);
  try {
    const bytes = new TextEncoder().encode(OPFS_VERSION);
    access.truncate(0);
    access.write(bytes, { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}
async function run(file) {
  const root = await navigator.storage.getDirectory();
  await removeEntry(root, "_portable_tmp");
  const temp = await root.getDirectoryHandle("_portable_tmp", { create: true });
  const source = await zipSource(file, temp);
  if (!source.paths.includes("manifest.json") || source.method("manifest.json") !== 0) {
    throw new Error("This is not a supported GTA VC portable OPFS ZIP.");
  }
  const manifestBytes = await source.read("manifest.json");
  const manifestCrc = (updateCrc(0xffffffff, manifestBytes) ^ 0xffffffff) >>> 0;
  if (manifestCrc !== source.crc("manifest.json")) throw new Error("Portable ZIP manifest checksum mismatch.");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.format !== "gta-vice-city-opfs" || manifest.formatVersion !== 1) {
    throw new Error("Unsupported portable OPFS package format.");
  }
  if (manifest.opfsVersion !== OPFS_VERSION) {
    throw new Error("Portable package version " + manifest.opfsVersion + " is not compatible with this site (" + OPFS_VERSION + ").");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Portable ZIP has no OPFS game files.");

  const files = manifest.files;
  const total = files.reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (!files.some((item) => item.path === PACKAGE_DATA && item.size >= 100 * 1024 * 1024) ||
      !files.some((item) => item.path === PACKAGE_INDEX && item.size > 1)) {
    throw new Error("Portable ZIP is missing required game package files.");
  }
  for (const item of files) {
    if (!safePath(item.path) || !["vcbr", "vcsky"].includes(item.path.split("/")[0])) {
      throw new Error("Unsafe or unsupported OPFS path in portable ZIP: " + item.path);
    }
    const zipPath = "opfs/" + item.path;
    if (!source.paths.includes(zipPath) || source.method(zipPath) !== 0 || source.size(zipPath) !== item.size) {
      throw new Error("Missing, compressed or incorrectly sized portable file: " + item.path);
    }
  }

  for (const name of GAME_ENTRIES) await removeEntry(root, name);
  let completed = 0;
  for (const item of files) {
    const zipPath = "opfs/" + item.path;
    const fileBase = completed;
    await writeOPFSFile(root, item.path, source, zipPath, item.size, source.crc(zipPath), (fileDone) => {
      self.postMessage({ type: "progress", done: fileBase + fileDone, total, file: item.path });
    });
    completed += item.size;
  }

  await restoreSaveRecords(manifest, source);
  await restoreSkins(manifest, source);
  await writeMarker(root);
  await removeEntry(root, "_portable_tmp");
  self.postMessage({ type: "done", settings: manifest.settings || {} });
}

self.onmessage = async (event) => {
  try {
    await run(event.data.file);
  } catch (error) {
    console.error("[portable OPFS]", error);
    try { await removeEntry(await navigator.storage.getDirectory(), "_portable_tmp"); } catch {}
    self.postMessage({ type: "error", message: error && error.message ? error.message : String(error) });
  }
};
