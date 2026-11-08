import { createRequire } from "node:module";
import { win32 as path } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { crc32, deflateSync } from "node:zlib";

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const CF_BITMAP = 2;
const CF_UNICODETEXT = 13;
const CF_HDROP = 15;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WORKER_TASK = "read-pi-windows-clipboard";
const require = createRequire(import.meta.url);

class ClipboardTooLarge extends Error {}

export function loadWin32(root) {
  if (!/^[A-Za-z]:\\[^<>:"|?*\x00-\x1f]*$/u.test(root ?? "") || path.normalize(root) !== root) {
    throw new Error("Invalid Windows system directory");
  }
  const koffi = require("koffi");
  const system32 = path.join(root, "System32");
  const load = (name) => koffi.load(path.join(system32, name));
  const user = load("user32.dll");
  const kernel = load("kernel32.dll");
  const shell = load("shell32.dll");
  const gdi = load("gdi32.dll");
  const registerFormat = user.func("uint32_t __stdcall RegisterClipboardFormatW(str16 name)");
  return {
    open: user.func("int __stdcall OpenClipboard(void *owner)"),
    close: user.func("int __stdcall CloseClipboard()"),
    available: user.func("int __stdcall IsClipboardFormatAvailable(uint32_t format)"),
    get: user.func("void * __stdcall GetClipboardData(uint32_t format)"),
    size: kernel.func("size_t __stdcall GlobalSize(void *handle)"),
    lock: kernel.func("void * __stdcall GlobalLock(void *handle)"),
    unlock: kernel.func("int __stdcall GlobalUnlock(void *handle)"),
    dragQuery: shell.func("uint32_t __stdcall DragQueryFileW(void *drop, uint32_t i, void *name, uint32_t capacity)"),
    getObject: gdi.func("int __stdcall GetObjectW(void *object, int size, void *info)"),
    createDC: gdi.func("void * __stdcall CreateCompatibleDC(void *dc)"),
    deleteDC: gdi.func("int __stdcall DeleteDC(void *dc)"),
    dibits: gdi.func("int __stdcall GetDIBits(void *dc, void *bitmap, uint32_t start, uint32_t lines, void *pixels, void *info, uint32_t usage)"),
    pngFormat: registerFormat("PNG"),
    view: koffi.view,
  };
}

function readBytes(api, format, limit) {
  const handle = api.get(format);
  if (!handle) return null;
  const size = Number(api.size(handle));
  if (size > limit) throw new ClipboardTooLarge();
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const ptr = api.lock(handle);
  if (!ptr) return null;
  try {
    // Copy before releasing the clipboard-owned memory.
    return Buffer.from(new Uint8Array(api.view(ptr, size)));
  } finally {
    api.unlock(handle);
  }
}

function checkDimensions(width, height) {
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 20_000_000) {
    throw new ClipboardTooLarge();
  }
}

function readPng(api) {
  const bytes = readBytes(api, api.pngFormat, MAX_PNG_BYTES);
  if (!bytes || bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  checkDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  for (let offset = 8; offset <= bytes.length - 12;) {
    const length = bytes.readUInt32BE(offset);
    const next = offset + length + 12;
    if (next > bytes.length) return null;
    if (length === 0 && bytes.toString("ascii", offset + 4, offset + 8) === "IEND") {
      // Ignore allocation padding or bytes after the PNG end marker.
      return bytes.subarray(0, next);
    }
    offset = next;
  }
  return null;
}

function readBitmap(api) {
  const handle = api.get(CF_BITMAP);
  if (!handle) return null;
  const bitmap = Buffer.alloc(32); // BITMAP, large enough on both 32- and 64-bit Windows.
  if (api.getObject(handle, bitmap.length, bitmap) < 12) return null;
  const width = bitmap.readInt32LE(4);
  const height = Math.abs(bitmap.readInt32LE(8));
  checkDimensions(width, height);

  const dc = api.createDC(null);
  if (!dc) return null;
  try {
    // Request a top-down, 32-bit BI_RGB DIB from GDI. Only the B, G and R bytes are defined.
    const info = Buffer.alloc(44); // BITMAPINFOHEADER and one RGBQUAD.
    info.writeUInt32LE(40, 0);
    info.writeInt32LE(width, 4);
    info.writeInt32LE(-height, 8);
    info.writeUInt16LE(1, 12);
    info.writeUInt16LE(32, 14);
    const pixels = Buffer.alloc(width * height * 4);
    if (api.dibits(dc, handle, 0, height, pixels, info, 0) !== height) return null;
    return { kind: "bitmap", width, height, pixels };
  } finally {
    api.deleteDC(dc);
  }
}

function readFiles(api) {
  const handle = api.get(CF_HDROP);
  if (!handle) return { kind: "error" };
  if (Number(api.size(handle)) > 512 * 1024) throw new ClipboardTooLarge();
  const count = api.dragQuery(handle, 0xffffffff, null, 0);
  if (count > MAX_FILES) throw new ClipboardTooLarge();
  if (count === 0) return { kind: "empty" };
  const paths = [];
  for (let i = 0; i < count; i++) {
    const length = api.dragQuery(handle, i, null, 0);
    if (length === 0) return { kind: "error" };
    if (length > 4096) throw new ClipboardTooLarge();
    const name = Buffer.alloc((length + 1) * 2);
    if (api.dragQuery(handle, i, name, length + 1) !== length) return { kind: "error" };
    paths.push(name.toString("utf16le", 0, length * 2));
  }
  return { kind: "files", paths };
}

function readSnapshot(api) {
  if (api.available(CF_HDROP)) return readFiles(api);
  const hasPng = api.pngFormat !== 0 && api.available(api.pngFormat);
  const hasBitmap = api.available(CF_BITMAP);
  if (hasPng || hasBitmap) {
    if (hasPng) {
      try {
        const data = readPng(api);
        if (data) return { kind: "png", data };
      } catch (error) {
        if (!(error instanceof ClipboardTooLarge) || !hasBitmap) throw error;
      }
    }
    return (hasBitmap ? readBitmap(api) : null) ?? { kind: "error" };
  }
  if (!api.available(CF_UNICODETEXT)) return { kind: "empty" };
  const data = readBytes(api, CF_UNICODETEXT, MAX_TEXT_BYTES);
  if (!data) return { kind: "empty" };
  const value = data.toString("utf16le");
  const end = value.indexOf("\0");
  return end < 0 ? { kind: "error" } : { kind: "text", text: value.slice(0, end) };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function encodeBitmap({ width, height, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // RGB, no alpha.

  const rows = Buffer.alloc((width * 3 + 1) * height);
  const stride = width * 3 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    rows[row] = 1; // PNG Sub filter. Subtract the previous pixel of each channel.
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const index = source + 2 - channel;
        rows[row + 1 + x * 3 + channel] = pixels[index] - (x === 0 ? 0 : pixels[index - 4]);
      }
    }
  }
  let compressed;
  try {
    compressed = deflateSync(rows, { maxOutputLength: MAX_PNG_BYTES });
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE") throw new ClipboardTooLarge();
    throw error;
  }
  const data = Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
  if (data.length > MAX_PNG_BYTES) throw new ClipboardTooLarge();
  return { kind: "png", data };
}

export async function readWindowsClipboard(api) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!api.open(null)) {
      if (attempt < 2) await delay(40);
      continue;
    }
    try {
      let snapshot;
      try {
        snapshot = readSnapshot(api);
      } finally {
        api.close();
      }
      return snapshot.kind === "bitmap" ? encodeBitmap(snapshot) : snapshot;
    } catch (error) {
      if (error instanceof ClipboardTooLarge) return { kind: "large" };
      throw error;
    }
  }
  return { kind: "busy" };
}

let activeWorker;

export function readClipboard(signal) {
  if (signal.aborted) return Promise.resolve({ kind: "error" });
  if (activeWorker) return Promise.resolve({ kind: "busy" });
  // Keep the native calls on one worker thread without blocking Pi's editor.
  const worker = new Worker(new URL(import.meta.url), {
    env: { SystemRoot: process.env.SystemRoot ?? "" },
    execArgv: [],
    workerData: WORKER_TASK,
  });
  activeWorker = worker;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    // Drop the result on cancellation. Let the worker close its clipboard handle
    // and exit before starting another native read.
    const abort = () => finish({ kind: "error" });
    const timeout = setTimeout(abort, 6000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (result) => finish(result));
    worker.once("error", () => finish({ kind: "error" }));
    worker.once("exit", () => {
      activeWorker = undefined;
      finish({ kind: "error" });
    });
    worker.unref();
  });
}

if (!isMainThread && parentPort && workerData === WORKER_TASK) {
  // The worker is short-lived, reads one clipboard snapshot, then exits.
  void (async () => {
    try {
      parentPort.postMessage(await readWindowsClipboard(loadWin32(process.env.SystemRoot)));
    } catch {
      parentPort.postMessage({ kind: "error" });
    }
  })();
}
