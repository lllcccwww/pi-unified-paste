/** Windows clipboard for the Pi terminal. Ctrl+V pastes text, file references, or a screenshot. */
import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readClipboard } from "./clipboard-win32.mjs";

const MAX_SCREENSHOTS = 2;

const localPath = /^[A-Za-z]:\\[^<>:"|?*\x00-\x1f\x7f-\x9f]*$/u;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu;

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
      const pasteIntoDraft = (text: string) => {
        ctx.ui.pasteToEditor(text);
        // Pi 1.5.0 renders the keypress before the async read finishes.
        ctx.ui.setStatus("pi-unified-paste", undefined);
      };
      try {
        const clip = await readClipboard(controller.signal);
        if (controller.signal.aborted) return;
        if (ctx.ui.getEditorText() !== draft) {
          ctx.ui.notify("输入已改变，请重新粘贴。", "info");
          return;
        }
        if (clip.kind === "text") {
          pasteIntoDraft(clip.text.replace(/\r\n?/g, "\n").replace(controls, ""));
          return;
        }
        if (clip.kind === "files") {
          const paths = clip.paths;
          const local = [...new Set(paths.filter((file) => localPath.test(file)))];
          if (paths.some((file) => !localPath.test(file))) ctx.ui.notify("已跳过 UNC 路径、设备路径或无效路径。", "warning");
          if (local.length) pasteIntoDraft(local.map((file) => /\s/u.test(file) ? `"${file}"` : file).join("\n"));
          return;
        }
        if (clip.kind !== "png") {
          ctx.ui.notify(errors[clip.kind], clip.kind === "empty" ? "info" : "warning");
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
        pasteIntoDraft(`${draft ? " " : ""}${marker} `);
        screenshots.set(marker, Buffer.from(clip.data).toString("base64"));
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
