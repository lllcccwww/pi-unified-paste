# Pi Workflow Tools

给 Pi 终端加上两项功能：用 `/default-model` 设置新会话的默认模型，以及用同一个 `Ctrl+V` 粘贴文字、文件和截图。

## 安装

需要 Node.js 22.19 或更新版本和 Pi 终端模式。已在 Pi 1.5.0 上验证。剪贴板功能目前支持原生 Windows。

```text
pi install https://github.com/lllcccwww/pi-workflow-tools.git
```

安装后重开 Pi。后续可用 `pi update https://github.com/lllcccwww/pi-workflow-tools.git` 更新。

## 设置默认模型

输入 `/default-model`，搜索提供商、模型名或 ID，用方向键选择，按回车保存。也可以用 `/default-model deepseek` 带上搜索词。

保存的是新会话的全局默认模型。项目单独设置的默认模型仍优先。

## 统一粘贴

在输入框按 `Ctrl+V`，扩展按剪贴板内容选择粘贴方式：

- 文字直接进入草稿，正文里的路径仍按文字处理。
- 资源管理器复制的文件以可见路径加入草稿。扩展跳过 UNC 和设备路径，也不打开这些文件。
- 截图先显示为可删除的标记。提交时 Pi 才会把图片发送给当前模型，因此需要支持图片输入的模型。每条消息最多两张截图，每张 PNG 最多 8 MiB。

如果文字能粘贴但文件和截图没反应，控制台可能先执行了文本粘贴。传统 Windows 控制台可在标题栏右键 → **属性 → 选项** 里关闭 **启用 Ctrl 键快捷方式**。此设置也会影响该控制台的其他内置 Ctrl 快捷键。Windows Terminal 可在 **设置 → 操作** 中解除 `Ctrl+V` 的终端粘贴绑定。

扩展只在处理粘贴按键时读取剪贴板。它通过 Node.js 工作线程和固定版本的 Koffi 调用 Windows 系统库。提交前的截图保存在内存中。发送后，图片由 Pi 按正常消息流程处理，包括模型请求和会话记录。

## 本地试用

在仓库目录启动一个只加载此包的测试会话：

```text
npm ci --ignore-scripts
pi -ne --no-session -e .
```
