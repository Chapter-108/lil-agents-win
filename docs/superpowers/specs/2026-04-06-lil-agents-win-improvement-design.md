# lil-agents-win 改进与优化设计文档

> 基于原项目 [ryanstephen/lil-agents](https://github.com/ryanstephen/lil-agents) 的 Windows Electron 适配版本改进方案  
> 日期：2026-04-06  
> 状态：待审阅

---

## 背景

`lil-agents-win` 是将 macOS Swift 版桌面宠物项目移植到 Windows 的 Electron 实现。当前版本可运行，但存在以下问题：

- 与原版相比缺少若干功能（Gemini、斜杠命令、复制按钮、Markdown 渲染）
- 存在若干已确认 bug（provider 规范化逻辑、进程管理、窗口层级、边界定位）
- 缺少 Windows 平台原生体验增强（Toast 通知、JumpList、真正的自动更新）

---

## 一、已确认 Bug 及修复方案

### B1 — `normalizeProviderId` 硬编码导致新 provider fallback 到 claude

**文件：** `main.js:641`

**现状：**
```js
function normalizeProviderId(id) {
  return id === 'codex' || id === 'copilot' ? id : 'claude';
}
```
任何不是 `codex` / `copilot` 的值（包括将来的 `gemini`）都会被静默归到 `claude`。

**修复：** 改为动态从 `PROVIDERS` 对象的 key 中匹配：
```js
function normalizeProviderId(id) {
  return Object.keys(PROVIDERS).includes(id) ? id : 'claude';
}
```

---

### B2 — `sessionStore` 硬编码三个 key，扩展 provider 时访问 undefined

**文件：** `main.js:630-634`

**现状：**
```js
const sessionStore = {
  claude: {},
  codex: {},
  copilot: {}
};
```

**修复：** 改为按需创建，不预设 key：
```js
const sessionStore = {};

function getOrCreateSession(providerId, characterId) {
  const p = normalizeProviderId(providerId);
  const c = normalizeCharacterId(characterId);
  if (!sessionStore[p]) sessionStore[p] = {};
  if (sessionStore[p][c]) return sessionStore[p][c];
  const session = p === 'claude' ? new ClaudeSession(c) : new GenericExecSession(p, c);
  wireSessionBridge(session, p, c);
  sessionStore[p][c] = session;
  return session;
}
```

---

### B3 — `GenericExecSession.isRunning` 永久为 true，binary 路径不可刷新

**文件：** `main.js:435-446`

**现状：**  
`startIfNeeded()` 将 `isRunning = true` 后不再检查 binary。而 Codex / Copilot 是 **spawn-per-message**（非持久进程），`isRunning` 状态无意义。若用户中途安装/卸载 CLI，binary 路径永久缓存失效。

**修复：**  
- 移除 `GenericExecSession` 中的 `isRunning` 字段（它不维护持久连接）
- `binaryPath` 缓存在 `resolveBinary()` 中保留，但加一个 `refreshBinary()` 方法可强制清缓存
- `startIfNeeded()` 每次都重新调用 `resolveBinary()`，仅在找不到 binary 时报错返回 false

---

### B4 — Claude 一键登录逻辑混乱（同时开浏览器 + 发 /login 给 CLI）

**文件：** `renderer/terminal.js:106-131`

**现状：**  
点击"一键 /login"按钮时：
1. 打开 `https://claude.ai/login`（浏览器）
2. 同时向 Claude CLI 发送 `/login` 消息

两件事同时发生，用户体验混乱：浏览器弹出但 CLI 也在等待。

**修复：**  
- 移除打开浏览器的逻辑
- 仅向 CLI 发送 `/login` 命令（CLI 会自行处理 OAuth 流程，含打开浏览器）
- 或改为只打开终端（调用 `openClaudeLoginTerminal`），不向 CLI 发消息

---

### B5 — 聊天窗口定位不做屏幕边界 clamp

**文件：** `main.js:788-797`

**现状：**
```js
const x = Math.round(anchor.screenX - 210);
const y = Math.round(anchor.screenY - 290);
chatWin.setPosition(x, y);
```
宠物位于屏幕左边缘时 `x` 会为负数，窗口超出屏幕左侧不可见。

**修复：**
```js
const workArea = getSelectedDisplay().workArea;
const x = Math.max(workArea.x, Math.min(anchor.screenX - 210, workArea.x + workArea.width - 420));
const y = Math.max(workArea.y + 40, Math.min(anchor.screenY - 290, workArea.y + workArea.height - 310));
chatWin.setPosition(x, y);
```

---

### B6 — 聊天窗 alwaysOnTop 级别低于宠物窗，可能被遮挡

**文件：** `main.js:755-774`

**现状：**  
`petWin.setAlwaysOnTop(true, 'screen-saver')`，`chatWin` 仅 `alwaysOnTop: true`（默认级别 `normal`），聊天窗可能被宠物窗遮住。

**修复：**  
创建 `chatWin` 后同样设置：
```js
chatWin.setAlwaysOnTop(true, 'floating');
```
`floating` 高于普通窗口、低于宠物的 `screen-saver`，层级关系变为：宠物 > 聊天 > 普通窗口。

---

## 二、新功能设计

### F1 — Gemini 提供商

**涉及文件：** `config.js`、`main.js`、`renderer/terminal.html`、`renderer/terminal.js`、`preload.js`

**config.js** 新增：
```js
gemini: {
  id: 'gemini',
  displayName: 'Gemini',
  inputPlaceholder: 'Ask Gemini...',
  installMessage: 'Gemini CLI not found. Install with: npm i -g @google/gemini-cli'
}
```

**`GenericExecSession.buildArgs`** 新增 gemini 分支：
```js
if (this.providerId === 'gemini') {
  return ['-p', prompt];
}
```

**`GenericExecSession.parseProviderOutput`** 新增 gemini JSON 解析（Gemini CLI 输出格式为 `{ type: 'content', text: '...' }`）。

**`terminal.html`** select 增加：
```html
<option value="gemini">Gemini</option>
```

**`terminal.js`** `applyProvider` 与 `authLoginBtn` 增加 gemini 分支：
```js
} else if (currentProvider === 'gemini') {
  setAuthMessage('Gemini CLI 未登录，请先在终端中执行 gemini auth');
  authLoginBtn.textContent = '打开 Gemini 登录';
}
```

**`preload.js`** 新增：
```js
openGeminiLoginTerminal: () => ipcRenderer.invoke('open-gemini-login-terminal'),
```

**`main.js`** 新增 IPC handler：
```js
ipcMain.handle('open-gemini-login-terminal', () => {
  return openProviderLoginTerminal('gemini');
});
```
并在 `openProviderLoginTerminal` 内新增：
```js
if (providerId === 'gemini') cmd = 'gemini auth';
```

---

### F2 — 斜杠命令 `/clear` `/copy` `/help`

**涉及文件：** `main.js`（`chat-send-message` handler）、`renderer/terminal.js`

**拦截逻辑**（在 `ipcMain.handle('chat-send-message')` 内）：

```js
if (text.startsWith('/')) {
  const cmd = text.split(' ')[0].toLowerCase();

  if (cmd === '/clear') {
    // 清空当前 session 历史
    const session = currentSession();
    if (session) session.history = [];
    sendChat('history', { messages: [] });
    return true;
  }

  if (cmd === '/copy') {
    // 复制最后一条 assistant 消息到剪贴板
    const session = currentSession();
    const last = session?.history.slice().reverse().find(m => m.role === 'assistant');
    if (last) {
      const { clipboard } = require('electron');
      clipboard.writeText(last.text);
      sendChat('assistant-chunk', { text: '\n✓ 已复制到剪贴板' });
      sendChat('turn-complete', {});
    }
    return true;
  }

  if (cmd === '/help') {
    const helpText =
      '可用命令：\n' +
      '  /clear  — 清空当前对话\n' +
      '  /copy   — 复制最后一条回复\n' +
      '  /help   — 显示此帮助\n' +
      '  /login  — 触发 Claude 登录（仅 Claude）';
    sendChat('assistant-chunk', { text: helpText });
    sendChat('turn-complete', {});
    return true;
  }

  // 其他斜杠命令（如 /login）直接透传给 CLI
}
```

---

### F3 — 标题栏"复制最后回复"按钮

**涉及文件：** `renderer/terminal.html`、`renderer/terminal.js`、`preload.js`、`main.js`

**`terminal.html`** 标题栏 close 按钮左侧新增：
```html
<button id="copy-btn" class="copy-btn" title="复制最后回复">⎘</button>
```

**`terminal.js`** 新增：
```js
copyBtn.addEventListener('click', async () => {
  await window.lil.copyLastResponse();
});
```

**`preload.js`** 新增：
```js
copyLastResponse: () => ipcRenderer.invoke('copy-last-response'),
```

**`main.js`** 新增 handler：
```js
ipcMain.handle('copy-last-response', () => {
  const session = currentSession();
  const last = session?.history.slice().reverse().find(m => m.role === 'assistant');
  if (last) {
    const { clipboard } = require('electron');
    clipboard.writeText(last.text);
    return true;
  }
  return false;
});
```

---

### F4 — Markdown 基础渲染

**涉及文件：** `renderer/terminal.html`、`renderer/terminal.js`

**方案：** 使用 `marked`（纯 JS，无外部网络依赖）本地 vendor 到 `renderer/assets/marked.min.js`。

**CSP 调整：** `terminal.html` 已有严格 CSP，`script-src 'self'` 允许加载同源脚本，本地 vendor 文件符合要求，无需修改 CSP。

**渲染策略：**
- 流式 chunk 期间：继续纯文本追加（保持实时感）
- `endAssistantChunk()` 调用时：将累积文本用 `marked.parse()` 转为 HTML，替换元素的 `innerHTML`
- 仅对 `assistant` 消息渲染 Markdown，`tool`/`error`/`user` 消息保持纯文本

**安全：** 使用 `marked` 的 `sanitize` 选项（或配合内联白名单过滤），防止渲染恶意 HTML。

**支持的格式：**
- 代码块（` ``` `）、行内代码（`` ` ``）
- **加粗**、*斜体*
- 无序列表、有序列表
- 分割线

---

### F5 — 聊天窗口位置边界修复（含任务栏边缘感知）

已在 B5 中描述 anchor clamp 修复。

额外增加：`positionPetWindow` 函数使用 `workArea`，Electron 会自动从 `workArea` 中排除任务栏，因此任务栏在上/左/右时宠物会正确贴近可用区边缘。当前代码实际已经正确处理这一点（`winY = y + height - winH`），无需额外改动。

---

### F6 — Windows Toast 通知

**涉及文件：** `main.js`（`wireSessionBridge` 中 `turn-complete` 处）

**逻辑：** 当 AI 回复完成且聊天窗口不在前台时，发送系统通知：
```js
if (event === 'turn-complete') {
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    const isFocused = chatWin && !chatWin.isDestroyed() && chatWin.isFocused();
    if (!isFocused) {
      new Notification({
        title: 'lil agents',
        body: `${PROVIDERS[providerId].displayName} 回复完成`,
        silent: true   // 声音由宠物窗口播放，不重复
      }).show();
    }
  }
}
```

---

### F7 — 任务栏 JumpList

**涉及文件：** `main.js`

**在 `app.whenReady()` 后调用：**
```js
function updateJumpList() {
  const state = loadState();
  app.setUserTasks(
    Object.values(PROVIDERS).map((p) => ({
      program: process.execPath,
      arguments: `--switch-provider=${p.id}`,
      title: `切换到 ${p.displayName}`,
      description: `使用 ${p.displayName} 作为 AI 提供商`,
      iconPath: process.execPath,
      iconIndex: 0
    }))
  );
}
```

**命令行参数处理：** 在 `app.whenReady()` 内读取 `process.argv`，若含 `--switch-provider=<id>` 则自动切换 provider。

---

### F8 — 自动更新（electron-updater）

**涉及文件：** `package.json`、`main.js`

**依赖：**
```json
"dependencies": {
  "electron-updater": "^6.x"
}
```

**`package.json` build 配置补充：**
```json
"publish": {
  "provider": "github",
  "owner": "Chapter-108",
  "repo": "lil-agents-win"
}
```

**`main.js` 集成：**
```js
const { autoUpdater } = require('electron-updater');

// app.whenReady() 后
autoUpdater.checkForUpdatesAndNotify();

autoUpdater.on('update-available', () => {
  // 可通过托盘菜单提示用户
});

autoUpdater.on('update-downloaded', () => {
  // 托盘菜单显示"重启以应用更新"
  rebuildTrayMenu();
});
```

托盘菜单"Check for Updates…"改为：
```js
click: () => autoUpdater.checkForUpdates()
```

> **注意：** 自动更新需要发布已签名的安装包（非 portable）并配置 GitHub Releases。在 portable 模式下 `electron-updater` 无法自动安装，但仍可检测并通知用户前往下载。

---

## 三、实施顺序

| 顺序 | 内容 | 优先级 |
|------|------|--------|
| 1 | B1 + B2：`normalizeProviderId` + `sessionStore` 动态化 | 基础，其他改动依赖此修复 |
| 2 | B3：`GenericExecSession.isRunning` 逻辑修正 | 影响 Codex/Copilot 稳定性 |
| 3 | F1：Gemini 提供商 | 功能对等 |
| 4 | B4：Claude 登录逻辑修正 | 用户体验 |
| 5 | F2：斜杠命令 | 核心交互 |
| 6 | F3：复制最后回复按钮 | 核心交互 |
| 7 | B5 + B6：窗口定位 clamp + 层级修正 | 视觉稳定 |
| 8 | F4：Markdown 渲染 | 输出体验 |
| 9 | F6：Toast 通知 | Windows 原生体验 |
| 10 | F7：JumpList | Windows 原生体验 |
| 11 | F8：自动更新 | 发布基础设施 |

---

## 四、不在本次范围内的事项

- `main.js` 大规模模块化重构（保留为后续阶段）
- 新增角色/角色自定义
- 多语言（i18n）支持
- 宠物动画帧优化

---

*文档结束*
