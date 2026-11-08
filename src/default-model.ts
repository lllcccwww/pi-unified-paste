import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Text } from "@earendil-works/pi-tui";

const display = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");

export default function defaultModelExtension(pi: ExtensionAPI) {
  pi.registerCommand("default-model", {
    description: "搜索并设置新会话的全局默认模型",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const models = ctx.modelRegistry.getAvailable().sort((a, b) =>
        `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
      );
      if (models.length === 0) {
        ctx.ui.notify("没有可用的模型。请先用 /login 登录提供商。", "warning");
        return;
      }

      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
      if (settings.drainErrors().some((error) => error.scope === "global")) {
        ctx.ui.notify("无法读取 Pi 的全局设置，请检查 settings.json。", "error");
        return;
      }
      const defaults = settings.getGlobalSettings();
      const entries = models.map((model, index) => ({
        value: String(index),
        label: display(`${model.provider}/${model.id}`),
        description: model.name !== model.id ? display(model.name) : undefined,
      }));
      const current = models.findIndex((model) => model.provider === defaults.defaultProvider && model.id === defaults.defaultModel);
      const previous = defaults.defaultProvider && defaults.defaultModel
        ? display(`${defaults.defaultProvider}/${defaults.defaultModel}`)
        : "自动选择";

      const chosen = await ctx.ui.custom<(typeof models)[number] | undefined>((_tui, theme, keys, done) => {
        const view = new Container();
        view.addChild(new Text(theme.fg("accent", "设置全局默认模型"), 1, 0));
        view.addChild(new Text(theme.fg("muted", `当前默认 ${previous} · ↑↓ 选择 · 回车保存 · Esc 取消`), 1, 0));
        const search = new Input({ prompt: "搜索 > ", placeholder: "提供商、模型名或 ID" });
        search.setValue(args.trim());
        view.addChild(search);

        const listTheme = {
          selectedPrefix: (value: string) => theme.fg("accent", value),
          selectedText: (value: string) => theme.fg("accent", value),
          description: (value: string) => theme.fg("muted", value),
          scrollInfo: (value: string) => theme.fg("muted", value),
          noMatch: () => theme.fg("muted", "没有匹配的模型"),
        };
        const buildList = () => {
          const query = search.getValue().trim();
          const items = query ? fuzzyFilter(entries, query, (item) => `${item.label} ${item.description ?? ""}`) : entries;
          const list = new SelectList(items, 8, listTheme);
          if (!query && current >= 0) list.setSelectedIndex(current);
          list.onSelect = (item) => done(models[Number(item.value)]);
          list.onCancel = () => done(undefined);
          return list;
        };
        let list = buildList();
        view.addChild(list);
        return {
          get focused() { return search.focused; },
          set focused(value: boolean) { search.focused = value; },
          render: (width) => view.render(width),
          invalidate: () => view.invalidate(),
          handleInput(data) {
            if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm") ||
                keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
              list.handleInput(data);
              return;
            }
            const before = search.getValue();
            search.handleInput(data);
            if (before !== search.getValue()) {
              view.removeChild(list);
              list = buildList();
              view.addChild(list);
            }
          },
        };
      });

      if (!chosen) return;
      if (!ctx.modelRegistry.hasConfiguredAuth(chosen)) {
        ctx.ui.notify("这个模型的提供商未登录，默认模型未更改。", "warning");
        return;
      }
      settings.setDefaultModelAndProvider(chosen.provider, chosen.id);
      await settings.flush();
      if (settings.drainErrors().some((error) => error.scope === "global")) {
        ctx.ui.notify("写入 Pi 的全局设置失败，请检查 settings.json 的权限和格式。", "error");
        return;
      }
      const label = display(`${chosen.provider}/${chosen.id}`);
      if (settings.getDefaultProvider() !== chosen.provider || settings.getDefaultModel() !== chosen.id) {
        ctx.ui.notify(`已保存全局默认模型 ${label}。当前项目有自己的默认模型设置。`, "warning");
      } else {
        ctx.ui.notify(`已保存新会话的默认模型 ${label}`, "info");
      }
    },
  });
}
