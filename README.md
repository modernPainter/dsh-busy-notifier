# @huaqiu/dsh-busy-notifier

DSH 客户端插件：自研大模型服务繁忙/体验降级时，在会话输入框上方显示轻量常驻提示横幅。

## 功能特性

1. **常驻轻提示**：挂载在输入框正上方的 `conversation.input.dock` 插槽，不遮挡聊天内容与输入框。
2. **多源参数识别**：预留多路后端识别逻辑，支持布尔值（如 `is_busy: true`）、字符串状态（如 `server_status: "busy"`）、嵌套字段以及流式文本标记。
3. **关闭冷却机制**：用户点击 `×` 关闭后，30 分钟内同一自研模型不再重复弹出打扰。
4. **切换模型重置**：检测右下角模型选择器，一旦切换到 DeepSeek、Kimi 等公用模型，立即自动隐藏横幅并清除关闭记录；切回自研模型时若仍繁忙可重新提醒。
5. **服务恢复自愈**：当自研模型新一轮回复不再携带繁忙参数时，自动撤销横幅并重置关闭记录。

## 安装

```bash
# npm
npm install @huaqiu/dsh-busy-notifier

# pnpm
pnpm add @huaqiu/dsh-busy-notifier
```

## 在 DSH Profile 中配置

在 `cordis.patch.yml` 中添加配置项（可选，默认已内置常用参数）：

```yaml
- insert:
    - id: ui-busy-notifier
      name: '@huaqiu/dsh-busy-notifier'
      config:
        cooldownMinutes: 30
        busyFields:
          - is_busy
          - isBusy
          - busy
          - degraded
          - is_degraded
          - server_busy
        publicProviders:
          - deepseek
          - kimi
          - moonshot
          - openai
          - claude
          - anthropic
          - qwen
```
