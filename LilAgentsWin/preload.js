const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lil', {
  onPetCommand: (fn) => {
    ipcRenderer.on('pet-command', (_, cmd, payload) => fn(cmd, payload));
  },
  setMousePassthrough: (ignore) => ipcRenderer.send('set-mouse-passthrough', ignore),
  getState: () => ipcRenderer.invoke('pet-state-get'),
  saveState: (s) => ipcRenderer.invoke('pet-state-save', s),
  openChat: (payload) => ipcRenderer.invoke('open-chat', payload),
  closeChat: () => ipcRenderer.invoke('close-chat'),
  onChatEvent: (fn) => {
    ipcRenderer.on('chat-event', (_, event, payload) => fn(event, payload));
  },
  setSelectedProvider: (providerId) => ipcRenderer.invoke('set-selected-provider', { providerId }),
  sendChatMessage: (payload) => ipcRenderer.invoke('chat-send-message', payload),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', url),
  openClaudeLoginTerminal: () => ipcRenderer.invoke('open-claude-login-terminal'),
  openCodexLoginTerminal: () => ipcRenderer.invoke('open-codex-login-terminal'),
  openCopilotLoginTerminal: () => ipcRenderer.invoke('open-copilot-login-terminal'),
  openGeminiLoginTerminal: () => ipcRenderer.invoke('open-gemini-login-terminal'),
  copyLastResponse: () => ipcRenderer.invoke('copy-last-response'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  // 返回仓库内资源的绝对 file:// URL，供 renderer 加载本地视频/音频。
  getAssetPath: (relPath) => ipcRenderer.invoke('asset-path', relPath)
});
