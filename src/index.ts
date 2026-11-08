/** Windows clipboard for the Pi terminal. Ctrl+V pastes text, file references, or a screenshot. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { win32 as path } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOTS = 2;
const run = promisify(execFile);

// This program is constant. Clipboard values cross the process boundary as data only.
// Use Win32 formats directly, without deserializing custom clipboard objects.
const helper = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
public static class PiClipboard {
    const uint BitmapFormat = 2, UnicodeText = 13, FileDrop = 15;
    const int MaxPng = ${MAX_PNG_BYTES}, MaxText = 1024 * 1024, MaxFiles = 32;
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern uint DragQueryFile(IntPtr drop, uint index, StringBuilder name, uint capacity);
    [DllImport("gdi32.dll", EntryPoint = "GetObjectW")]
    static extern int GetBitmapInfo(IntPtr handle, int size, out BitmapInfo info);

    [StructLayout(LayoutKind.Sequential)]
    struct BitmapInfo {
        public int Type, Width, Height, RowBytes;
        public ushort Planes, BitsPerPixel;
        public IntPtr Bits;
    }

    static string Pack(string kind, byte[] bytes) { return kind + ":" + Convert.ToBase64String(bytes); }
    static string PackText(string kind, string value) { return Pack(kind, Encoding.UTF8.GetBytes(value)); }

    static byte[] ReadBytes(uint format, int maxBytes) {
        IntPtr handle = GetClipboardData(format);
        if (handle == IntPtr.Zero) return null;
        ulong size = GlobalSize(handle).ToUInt64();
        if (size > (ulong)maxBytes) throw new InvalidDataException("size");
        if (size == 0) return null;
        IntPtr ptr = GlobalLock(handle);
        if (ptr == IntPtr.Zero) return null;
        try {
            byte[] bytes = new byte[(int)size];
            Marshal.Copy(ptr, bytes, 0, bytes.Length);
            return bytes;
        } finally { GlobalUnlock(handle); }
    }

    static bool SafeDimensions(long width, long height) {
        return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 20000000;
    }

    static uint Big32(byte[] b, int i) {
        return ((uint)b[i] << 24) | ((uint)b[i+1] << 16) | ((uint)b[i+2] << 8) | b[i+3];
    }

    static string ReadPng(uint format) {
        byte[] b = ReadBytes(format, MaxPng);
        if (b == null || b.Length < 45 || Big32(b, 0) != 0x89504e47 || Big32(b, 4) != 0x0d0a1a0a ||
            Big32(b, 8) != 13 || Big32(b, 12) != 0x49484452) return null;
        if (!SafeDimensions(Big32(b, 16), Big32(b, 20))) throw new InvalidDataException("size");
        for (int offset = 8; offset <= b.Length - 12;) {
            uint length = Big32(b, offset);
            if (length > (uint)(b.Length - offset - 12)) return null;
            int next = offset + (int)length + 12;
            if (length == 0 && Big32(b, offset + 4) == 0x49454e44) {
                // Ignore allocation padding or bytes after the PNG end marker.
                return "png:" + Convert.ToBase64String(b, 0, next);
            }
            offset = next;
        }
        return null;
    }

    static string ReadBitmap() {
        IntPtr bitmap = GetClipboardData(BitmapFormat);
        BitmapInfo info;
        if (bitmap == IntPtr.Zero || GetBitmapInfo(bitmap, Marshal.SizeOf(typeof(BitmapInfo)), out info) == 0) return null;
        if (!SafeDimensions(info.Width, info.Height)) throw new InvalidDataException("size");
        using (Image image = Image.FromHbitmap(bitmap))
        using (MemoryStream png = new MemoryStream()) {
            image.Save(png, ImageFormat.Png);
            if (png.Length > MaxPng) throw new InvalidDataException("size");
            return "png:" + Convert.ToBase64String(png.GetBuffer(), 0, (int)png.Length);
        }
    }

    static string ReadFiles() {
        IntPtr drop = GetClipboardData(FileDrop);
        if (drop == IntPtr.Zero) return "empty:";
        uint count = DragQueryFile(drop, uint.MaxValue, null, 0);
        if (count > MaxFiles) throw new InvalidDataException("size");
        StringBuilder files = new StringBuilder();
        for (uint i = 0; i < count; ++i) {
            uint length = DragQueryFile(drop, i, null, 0);
            if (length == 0 || length > 4096) throw new InvalidDataException("size");
            StringBuilder name = new StringBuilder((int)length + 1);
            if (DragQueryFile(drop, i, name, length + 1) != length) return "error:";
            if (i != 0) files.Append('\0');
            files.Append(name);
        }
        return PackText("files", files.ToString());
    }

    public static string Read() {
        for (int attempt = 0; attempt < 3; ++attempt) {
            if (!OpenClipboard(IntPtr.Zero)) { Thread.Sleep(40); continue; }
            try {
                if (IsClipboardFormatAvailable(FileDrop)) return ReadFiles();
                uint png = RegisterClipboardFormat("PNG");
                bool hasPng = png != 0 && IsClipboardFormatAvailable(png);
                bool hasBitmap = IsClipboardFormatAvailable(BitmapFormat);
                if (hasPng || hasBitmap) {
                    try { if (hasPng) { string image = ReadPng(png); if (image != null) return image; } }
                    catch (InvalidDataException) { if (!hasBitmap) throw; }
                    return (hasBitmap ? ReadBitmap() : null) ?? "error:";
                }
                if (!IsClipboardFormatAvailable(UnicodeText)) return "empty:";
                byte[] text = ReadBytes(UnicodeText, MaxText);
                if (text == null) return "empty:";
                string value = Encoding.Unicode.GetString(text);
                int end = value.IndexOf('\0');
                return end < 0 ? "error:" : PackText("text", value.Substring(0, end));
            } catch (InvalidDataException) { return "large:"; }
            finally { CloseClipboard(); }
        }
        return "busy:";
    }
}
'@
  [Console]::Write([PiClipboard]::Read())
} catch {
  [Console]::Write('error:')
}
`;

const encodedHelper = Buffer.from(helper, "utf16le").toString("base64");
const localPath = /^[A-Za-z]:\\[^<>:"|?*\x00-\x1f\x7f-\x9f]*$/u;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu;

type Clipboard = { kind: "text" | "files" | "png"; data: Buffer } | { kind: "busy" | "empty" | "large" | "error" };

async function readClipboard(signal: AbortSignal): Promise<Clipboard> {
  const root = process.env.SystemRoot;
  if (!root || !localPath.test(root) || path.normalize(root) !== root) return { kind: "error" };
  const system32 = path.join(root, "System32");
  const psDir = path.join(system32, "WindowsPowerShell", "v1.0");
  const { stdout } = await run(path.join(psDir, "powershell.exe"), [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-STA", "-EncodedCommand", encodedHelper,
  ], {
    cwd: system32,
    env: {
      SystemRoot: root, WINDIR: root, PATH: `${system32};${psDir}`,
      PSModulePath: path.join(psDir, "Modules"), TEMP: tmpdir(), TMP: tmpdir(),
    },
    windowsHide: true, timeout: 6000, maxBuffer: 12 * 1024 * 1024, encoding: "utf8", signal,
  });
  if (stdout === "empty:") return { kind: "empty" };
  if (stdout === "busy:") return { kind: "busy" };
  if (stdout === "large:") return { kind: "large" };
  const match = /^(text|files|png):([A-Za-z0-9+/]*={0,2})$/.exec(stdout);
  if (!match) return { kind: "error" };
  const kind = match[1] as "text" | "files" | "png";
  const data = Buffer.from(match[2], "base64");
  if (kind === "png" && (data.length < 45 || data.length > MAX_PNG_BYTES)) return { kind: "error" };
  return { kind, data };
}

const errors = {
  busy: "剪贴板正被占用，请重试。",
  empty: "剪贴板没有可粘贴的文字、文件或截图。",
  large: "剪贴板内容太大。请缩小截图或减少复制的文件。",
  error: "无法读取 Windows 剪贴板。",
};

export default function unifiedPaste(pi: ExtensionAPI): void {
  if (process.platform !== "win32") return;
  const screenshots = new Map<string, string>();
  let request: AbortController | undefined;
  let nextScreenshot = 0;

  function stopRead() {
    request?.abort();
    request = undefined;
  }

  pi.on("session_shutdown", () => {
    stopRead();
    screenshots.clear();
  });

  pi.registerShortcut("ctrl+v", {
    description: "Paste Windows clipboard text, files, or screenshots",
    handler: async (ctx) => {
      if (ctx.mode !== "tui" || request) return;
      const draft = ctx.ui.getEditorText();
      const controller = new AbortController();
      request = controller;
      try {
        const clip = await readClipboard(controller.signal);
        if (controller.signal.aborted) return;
        if (ctx.ui.getEditorText() !== draft) {
          ctx.ui.notify("输入已改变，请重新粘贴。", "info");
          return;
        }
        if (!("data" in clip)) {
          ctx.ui.notify(errors[clip.kind], clip.kind === "empty" ? "info" : "warning");
          return;
        }
        if (clip.kind === "text") {
          ctx.ui.pasteToEditor(clip.data.toString("utf8").replace(/\r\n?/g, "\n").replace(controls, ""));
          return;
        }
        if (clip.kind === "files") {
          const paths = clip.data.toString("utf8").split("\0").filter(Boolean);
          const local = [...new Set(paths.filter((file) => localPath.test(file)))];
          if (paths.some((file) => !localPath.test(file))) ctx.ui.notify("已跳过 UNC 路径、设备路径或无效路径。", "warning");
          if (local.length) ctx.ui.pasteToEditor(local.map((file) => /\s/u.test(file) ? `"${file}"` : file).join("\n"));
          return;
        }
        if (!ctx.model?.input.includes("image")) {
          ctx.ui.notify("请选择支持图片的模型，再粘贴截图。", "warning");
          return;
        }
        for (const marker of screenshots.keys()) if (!draft.includes(marker)) screenshots.delete(marker);
        if (screenshots.size >= MAX_SCREENSHOTS) {
          ctx.ui.notify(`每条消息最多粘贴 ${MAX_SCREENSHOTS} 张截图。`, "warning");
          return;
        }
        const marker = `[截图 ${++nextScreenshot}·${randomBytes(4).toString("hex")}]`;
        ctx.ui.pasteToEditor(`${draft ? " " : ""}${marker} `);
        screenshots.set(marker, clip.data.toString("base64"));
      } catch {
        if (!controller.signal.aborted) ctx.ui.notify(errors.error, "warning");
      } finally {
        if (request === controller) request = undefined;
      }
    },
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive") return;
    stopRead();
    const picked = [...screenshots.entries()]
      .map(([marker, data]) => ({ marker, data, offset: event.text.indexOf(marker) }))
      .filter(({ offset }) => offset >= 0)
      .sort((a, b) => a.offset - b.offset);
    if (picked.length === 0) {
      screenshots.clear();
      return;
    }
    if (!ctx.model?.input.includes("image")) {
      if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
      ctx.ui.notify("当前模型无法接收图片。请切换模型，或删掉截图标记后再发送。", "warning");
      return { action: "handled" };
    }
    let text = event.text;
    for (const { marker } of picked) text = text.replaceAll(marker, "");
    screenshots.clear();
    return {
      action: "transform",
      text: text.trim(),
      images: [...(event.images ?? []), ...picked.map(({ data }) => ({ type: "image" as const, mimeType: "image/png", data }))],
    };
  });
}
