const output = document.getElementById('output');
const form = document.getElementById('chat-form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const closeBtn = document.getElementById('close-btn');
const authHint = document.getElementById('auth-hint');
const authLoginBtn = document.getElementById('auth-login-btn');
const authTerminalBtn = document.getElementById('auth-terminal-btn');
const authMsg = document.getElementById('auth-msg');
const titleLabel = document.getElementById('title-label');
const providerSelect = document.getElementById('provider-select');

let isBusy = false;
let assistantLineEl = null;
let hasWelcome = false;
let currentProvider = 'claude';

function scrollToBottom() {
  output.scrollTop = output.scrollHeight;
}

function clearOutput() {
  output.innerHTML = '';
  assistantLineEl = null;
}

function showAuthHint(show) {
  authHint.classList.toggle('show', !!show);
}

function applyProvider(meta) {
  currentProvider = meta?.id || 'claude';
  providerSelect.value = currentProvider;
  input.placeholder = meta?.inputPlaceholder || 'Ask...';
  if (meta?.displayName) {
    const lower = meta.displayName.toLowerCase();
    titleLabel.textContent = lower === 'claude' ? 'claude ~' : `${lower} ~`;
  }
  showAuthHint(false);
  if (currentProvider === 'claude') {
    setAuthMessage('Claude 尚未登录，请先执行 /login');
    authLoginBtn.textContent = '一键 /login';
  } else if (currentProvider === 'codex') {
    setAuthMessage('Codex CLI 未登录，请先在终端中执行 codex login --device-auth');
    authLoginBtn.textContent = '打开 Codex 登录';
  } else if (currentProvider === 'copilot') {
    setAuthMessage('Copilot CLI 未登录，请先在终端中执行 copilot login');
    authLoginBtn.textContent = '打开 Copilot 登录';
  }
}

function setAuthMessage(text) {
  authMsg.textContent = text;
}

function appendLine(text, cls) {
  const line = document.createElement('div');
  line.className = `line ${cls || ''}`;
  line.textContent = text;
  output.appendChild(line);
  scrollToBottom();
}

function appendAssistantChunk(text) {
  if (!assistantLineEl) {
    assistantLineEl = document.createElement('div');
    assistantLineEl.className = 'line assistant';
    assistantLineEl.textContent = '';
    output.appendChild(assistantLineEl);
  }
  assistantLineEl.textContent += text;
  scrollToBottom();
}

function endAssistantChunk() {
  assistantLineEl = null;
}

function setBusy(busy) {
  isBusy = !!busy;
  send.disabled = isBusy;
  input.disabled = false;
}

closeBtn.addEventListener('click', () => {
  window.lil.closeChat();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.lil.closeChat();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendLine(`> ${text}`, 'user');
  endAssistantChunk();
  setBusy(true);
  await window.lil.sendChatMessage({ message: text });
});

authLoginBtn.addEventListener('click', async () => {
  if (currentProvider === 'claude') {
    await window.lil.openExternal('https://claude.ai/login');
    appendLine('> /login', 'user');
    endAssistantChunk();
    setBusy(true);
    await window.lil.sendChatMessage({ message: '/login' });
  } else if (currentProvider === 'codex') {
    await window.lil.openExternal('https://auth.openai.com/codex/device');
    const ok = await window.lil.openCodexLoginTerminal();
    if (!ok) {
      appendLine('无法自动打开 Codex 终端，请手动运行 codex login --device-auth', 'error');
    } else {
      appendLine('已打开 Codex 终端，请按提示完成设备码登录。', 'assistant');
      showAuthHint(true);
    }
  } else if (currentProvider === 'copilot') {
    const ok = await window.lil.openCopilotLoginTerminal();
    if (!ok) {
      appendLine('无法自动打开 Copilot 终端，请手动运行 copilot login', 'error');
    } else {
      appendLine('已打开 Copilot 终端，请按提示完成登录。', 'assistant');
      showAuthHint(true);
    }
  }
});

authTerminalBtn.addEventListener('click', async () => {
  if (currentProvider === 'claude') {
    const ok = await window.lil.openClaudeLoginTerminal();
    if (!ok) {
      appendLine('无法自动打开终端，请手动在系统终端运行 claude 并执行 /login', 'error');
    } else {
      appendLine('已打开终端，请在终端中执行 /login 完成 Claude CLI 登录。', 'assistant');
      showAuthHint(true);
    }
  } else if (currentProvider === 'codex') {
    const ok = await window.lil.openCodexLoginTerminal();
    if (!ok) {
      appendLine('无法自动打开终端，请手动在系统终端运行 codex login --device-auth', 'error');
    } else {
      appendLine('已打开终端，请按提示完成 Codex 设备码登录。', 'assistant');
      showAuthHint(true);
    }
  } else if (currentProvider === 'copilot') {
    const ok = await window.lil.openCopilotLoginTerminal();
    if (!ok) {
      appendLine('无法自动打开终端，请手动在系统终端运行 copilot login', 'error');
    } else {
      appendLine('已打开终端，请按提示完成 Copilot 登录。', 'assistant');
      showAuthHint(true);
    }
  }
});

providerSelect.addEventListener('change', async () => {
  await window.lil.setSelectedProvider(providerSelect.value);
});

window.lil.onChatEvent((event, payload) => {
  if (event === 'provider') {
    applyProvider(payload || {});
  }
  if (event === 'theme') {
    document.body.dataset.theme = payload.theme || 'Peach';
  }
  if (event === 'history') {
    clearOutput();
    showAuthHint(false);
    const list = Array.isArray(payload.messages) ? payload.messages : [];
    for (const msg of list) {
      if (msg.role === 'user') appendLine(`> ${msg.text}`, 'user');
      else if (msg.role === 'assistant') appendLine(msg.text, 'assistant');
      else if (msg.role === 'toolUse') appendLine(`  ${msg.text}`, 'tool');
      else if (msg.role === 'toolResult') appendLine(`  ${msg.text}`, 'done');
      else if (msg.role === 'error') appendLine(msg.text, 'error');
    }
  }
  if (event === 'welcome' && payload.text && !hasWelcome) {
    hasWelcome = true;
    appendLine(payload.text, 'assistant');
  }
  if (event === 'busy') {
    setBusy(!!payload.busy);
  }
  if (event === 'assistant-chunk') {
    appendAssistantChunk(payload.text || '');
  }
  if (event === 'tool-use') {
    endAssistantChunk();
    appendLine(`  ${payload.toolName?.toUpperCase() || 'TOOL'} ${payload.summary || ''}`, 'tool');
  }
  if (event === 'tool-result') {
    endAssistantChunk();
    appendLine(`  ${payload.isError ? 'FAIL' : 'DONE'} ${payload.summary || ''}`, payload.isError ? 'error' : 'done');
  }
  if (event === 'error') {
    endAssistantChunk();
    appendLine(payload.text || 'Unknown error', 'error');
    setBusy(false);
  }
  if (event === 'auth-required') {
    if (payload?.provider === 'codex' || currentProvider === 'codex') {
      setAuthMessage(payload?.message || 'Codex CLI 未登录，请先在终端中执行 codex login --device-auth');
      authLoginBtn.textContent = '打开 Codex 登录';
      showAuthHint(true);
    } else if (payload?.provider === 'copilot' || currentProvider === 'copilot') {
      setAuthMessage(payload?.message || 'Copilot CLI 未登录，请先在终端中执行 copilot login');
      authLoginBtn.textContent = '打开 Copilot 登录';
      showAuthHint(true);
    } else if (currentProvider === 'claude') {
      setAuthMessage(payload?.message || 'Claude 尚未登录，请先执行 /login');
      authLoginBtn.textContent = '一键 /login';
      showAuthHint(true);
    }
  }
  if (event === 'turn-complete') {
    endAssistantChunk();
    setBusy(false);
  }
});

input.focus();
