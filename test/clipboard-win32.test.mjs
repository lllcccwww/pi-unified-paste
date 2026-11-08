import assert from "node:assert/strict";
import { win32 as path } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import koffi from "koffi";
import { loadWin32, readWindowsClipboard } from "../src/clipboard-win32.mjs";

const onWindows = { skip: process.platform !== "win32" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGMU1AlnYGBgYGBgYoABAApeAJhbwtG+AAAAAElFTkSuQmCC", "base64");

async function withMemory(bytes, run) {
  const root = process.env.SystemRoot;
  const api = loadWin32(root);
  const kernel = koffi.load(path.join(root, "System32", "kernel32.dll"));
  const allocate = kernel.func("void * __stdcall GlobalAlloc(uint32_t flags, size_t bytes)");
  const free = kernel.func("void * __stdcall GlobalFree(void *handle)");
  const handle = allocate(2, bytes.length); // GMEM_MOVEABLE, as used by the clipboard.
  assert(handle);
  try {
    const address = api.lock(handle);
    assert(address);
    try { new Uint8Array(api.view(address, bytes.length)).set(bytes); }
    finally { api.unlock(handle); }
    await run(api, handle);
  } finally {
    assert.equal(free(handle), null);
  }
}

async function snapshot(api, handle, format) {
  let closed = false;
  const result = await readWindowsClipboard({
    ...api,
    open: () => true,
    close: () => { closed = true; },
    available: (candidate) => candidate === format,
    get: (candidate) => { assert.equal(candidate, format); return handle; },
  });
  assert(closed);
  return result;
}

test("reads Unicode clipboard text and ignores bytes after the NUL", onWindows, async () => {
  const text = "带中文的文字\r\n\\\\example.invalid\\share\\image.png";
  await withMemory(Buffer.from(`${text}\0padding`, "utf16le"), async (api, handle) => {
    assert.deepEqual(await snapshot(api, handle, 13), { kind: "text", text });
  });
});

test("reads Explorer paths through the real DragQueryFileW API", onWindows, async () => {
  const paths = ["C:\\docs\\中文 文件.txt", "C:\\docs\\image.png"];
  const header = Buffer.alloc(20); // DROPFILES with a Unicode file list after the header.
  header.writeUInt32LE(20, 0);
  header.writeUInt32LE(1, 16);
  await withMemory(Buffer.concat([header, Buffer.from(`${paths.join("\0")}\0\0`, "utf16le")]), async (api, handle) => {
    assert.deepEqual(await snapshot(api, handle, 15), { kind: "files", paths });
  });
});

test("PNG reads discard allocation padding and reject huge dimensions", onWindows, async () => {
  await withMemory(Buffer.concat([png, Buffer.from("padding")]), async (api, handle) => {
    assert.deepEqual(await snapshot(api, handle, api.pngFormat), { kind: "png", data: png });
  });
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(9000, 16);
  await withMemory(oversized, async (api, handle) => {
    assert.deepEqual(await snapshot(api, handle, api.pngFormat), { kind: "large" });
  });
});

test("turns a GDI bitmap into an in-memory PNG with the original pixels", onWindows, async () => {
  const root = process.env.SystemRoot;
  const api = loadWin32(root);
  const gdi = koffi.load(path.join(root, "System32", "gdi32.dll"));
  const create = gdi.func("void * __stdcall CreateDIBSection(void *dc, void *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)");
  const destroy = gdi.func("int __stdcall DeleteObject(void *object)");
  const info = Buffer.alloc(44);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(2, 4);
  info.writeInt32LE(-1, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  const pixels = [null];
  const bitmap = create(null, info, 0, pixels, null, 0);
  assert(bitmap);
  try {
    assert(pixels[0]);
    new Uint8Array(api.view(pixels[0], 8)).set([0, 0, 255, 0, 255, 0, 0, 0]);
    const result = await snapshot(api, bitmap, 2);
    assert.equal(result.kind, "png");
    assert.equal(result.data.readUInt32BE(16), 2);
    assert.equal(result.data.readUInt32BE(20), 1);
    const idatSize = result.data.readUInt32BE(33);
    assert.equal(result.data.toString("ascii", 37, 41), "IDAT");
    assert.deepEqual([...inflateSync(result.data.subarray(41, 41 + idatSize))], [1, 255, 0, 0, 1, 0, 255]);
  } finally {
    assert(destroy(bitmap));
  }
});
