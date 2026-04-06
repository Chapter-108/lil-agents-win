const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const {
  THINKING_PHRASES,
  COMPLETION_PHRASES,
  COMPLETION_SOUND_FILES,
  PROVIDERS,
  PROJECT_LINKS
} = require('./config');

const GPU_ENABLED = process.env.LIL_AGENTS_WIN_ENABLE_GPU === '1';

if (process.platform === 'win32' && !GPU_ENABLED) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('no-sandbox');
}

let tray = null;
let petWin = null;
let chatWin = null;
let activeChatCharacterId = null;
let chatReady = false;
let chatQueue = [];
let cachedState = null;

const STATE_PATH = () => path.join(app.getPath('userData'), 'pet-state.json');
let lastCompletionSoundIndex = -1;

function defaultState() {
  return {
    showBruce: true,
    showJazz: true,
    sounds: true,
    theme: 'Peach',
    pinnedDisplayId: 'auto',
    onboardingDone: false,
    selectedProvider: 'claude'
  };
}

function loadState(forceReload = false) {
  if (!forceReload && cachedState) {
    return { ...cachedState };
  }
  const base = defaultState();
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_PATH(), 'utf8'));
    cachedState = {
      ...base,
      ...obj
    };
    return { ...cachedState };
  } catch {
    cachedState = { ...base };
    return base;
  }
}

function saveState(state) {
  try {
    const nextState = { ...defaultState(), ...(state || {}) };
    const filePath = STATE_PATH();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(nextState, null, 2), 'utf8');
    cachedState = nextState;
  } catch (err) {
    console.error(err);
  }
}

function detectNodeBinDirs() {
  const dirs = [];
  try {
    const whereNode = spawnSync('where.exe', ['node'], { encoding: 'utf8' });
    if (whereNode.status === 0 && whereNode.stdout) {
      const paths = whereNode.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const p of paths) {
        const dir = path.dirname(p);
        if (dir && !dirs.includes(dir)) dirs.push(dir);
      }
    }
  } catch {}
  // Common Windows Node install locations.
  const fallback = [
    'C:\\Program Files\\nodejs',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs')
  ];
  for (const d of fallback) {
    if (d && fs.existsSync(d) && !dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

let cachedSystemProxy = undefined;

function parseProxyFromNetshOutput(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('direct access')) return null;

  const uri = text.match(/((?:https?|socks5?):\/\/[^\s;]+)/i);
  if (uri && uri[1]) return uri[1].trim();

  const mapped = text.match(/(?:http|https)\s*=\s*([^\s;]+)/i);
  if (mapped && mapped[1]) {
    const hostPort = mapped[1].trim();
    return /^https?:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`;
  }

  const hostPort = text.match(/([a-zA-Z0-9.\-]+:\d{2,5})/);
  if (hostPort && hostPort[1]) return `http://${hostPort[1].trim()}`;
  return null;
}

function detectSystemProxy() {
  if (cachedSystemProxy !== undefined) return cachedSystemProxy;

  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    null;
  if (fromEnv) {
    cachedSystemProxy = fromEnv;
    return cachedSystemProxy;
  }

  try {
    const out = spawnSync('netsh', ['winhttp', 'show', 'proxy'], { encoding: 'utf8' });
    if (out.status === 0 && out.stdout) {
      const parsed = parseProxyFromNetshOutput(out.stdout);
      cachedSystemProxy = parsed || null;
      return cachedSystemProxy;
    }
  } catch {}

  cachedSystemProxy = null;
  return cachedSystemProxy;
}

function applyNetworkEnv(env) {
  const proxy = detectSystemProxy();
  if (proxy) {
    if (!env.HTTPS_PROXY && !env.https_proxy) env.HTTPS_PROXY = proxy;
    if (!env.HTTP_PROXY && !env.http_proxy) env.HTTP_PROXY = proxy;
    if (!env.ALL_PROXY && !env.all_proxy) env.ALL_PROXY = proxy;
  }
  if (!env.NO_PROXY && !env.no_proxy) {
    env.NO_PROXY = 'localhost,127.0.0.1';
  }
}

function buildCliEnvironment() {
  const env = { ...process.env };
  const appData = process.env.APPDATA || '';
  const npmGlobal = appData ? path.join(appData, 'npm') : '';
  const pathParts = (env.PATH || '').split(';').filter(Boolean);
  if (npmGlobal && !pathParts.includes(npmGlobal)) {
    pathParts.unshift(npmGlobal);
  }
  for (const nodeDir of detectNodeBinDirs()) {
    if (!pathParts.includes(nodeDir)) {
      pathParts.unshift(nodeDir);
    }
  }
  env.PATH = pathParts.join(';');
  env.TERM = 'dumb';
  applyNetworkEnv(env);
  return env;
}

class ClaudeSession {
  constructor(characterId) {
    this.characterId = characterId;
    this.process = null;
    this.input = null;
    this.lineBuffer = '';
    this.isRunning = false;
    this.isBusy = false;
    this.history = [];
    this.onEvent = null;
    this.networkHintShown = false;
  }

  emit(type, payload = {}) {
    if (this.onEvent) this.onEvent(type, payload);
  }

  resolveClaudePath() {
    const where = spawnSync('where.exe', ['claude'], { encoding: 'utf8' });
    if (where.status === 0 && where.stdout) {
      const first = where.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first) return first;
    }
    return null;
  }

  buildEnvironment() {
    return buildCliEnvironment();
  }

  startIfNeeded() {
    if (this.isRunning) return true;
    const claudePath = this.resolveClaudePath();
    if (!claudePath) {
      const msg =
        'Claude CLI not found.\n\nTo install, run:\n  npm i -g @anthropic-ai/claude-code\n\nOr visit https://claude.ai/download';
      this.history.push({ role: 'error', text: msg });
      this.emit('error', { text: msg });
      return false;
    }
    try {
      const proc = spawn(
        claudePath,
        ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
        {
          cwd: os.homedir(),
          env: this.buildEnvironment(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );
      this.process = proc;
      this.input = proc.stdin;
      this.isRunning = true;
      proc.stdout.on('data', (chunk) => this.processOutput(chunk.toString('utf8')));
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (!text.trim()) return;
        if (
          !this.networkHintShown &&
          /(Unable to connect to Anthropic services|api\.anthropic\.com|ERR_BAD_REQUEST|supported-countries)/i.test(text)
        ) {
          this.networkHintShown = true;
          const hint =
            'Claude 当前网络不可达（api.anthropic.com）。\n' +
            '请先确认：\n' +
            '1) 网络位于 Anthropic 支持地区\n' +
            '2) 已配置可用代理（HTTPS_PROXY / HTTP_PROXY）\n' +
            '3) 终端中 `claude` 可正常对话后再回到桌宠窗口';
          this.history.push({ role: 'error', text: hint });
          this.emit('error', { text: hint });
          return;
        }
        this.history.push({ role: 'error', text });
        this.emit('error', { text });
      });
      proc.on('exit', () => {
        this.isRunning = false;
        this.isBusy = false;
        this.emit('busy', { busy: false });
        this.emit('session-ended', {});
      });
      return true;
    } catch (err) {
      const msg = `Failed to launch Claude CLI: ${err.message}`;
      this.history.push({ role: 'error', text: msg });
      this.emit('error', { text: msg });
      return false;
    }
  }

  terminate() {
    if (this.process) {
      this.process.kill();
    }
    this.process = null;
    this.input = null;
    this.isRunning = false;
    this.isBusy = false;
  }

  send(message) {
    if (!this.startIfNeeded()) return;
    if (!this.input) return;

    this.isBusy = true;
    this.networkHintShown = false;
    this.history.push({ role: 'user', text: message });
    this.emit('user', { text: message });
    this.emit('busy', { busy: true });

    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: message
      }
    };
    this.input.write(`${JSON.stringify(payload)}\n`);
  }

  processOutput(text) {
    this.lineBuffer += text;
    while (true) {
      const idx = this.lineBuffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.lineBuffer.slice(0, idx).trim();
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (!line) continue;
      this.parseLine(line);
    }
  }

  parseLine(line) {
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const type = json.type || '';

    if (type === 'assistant') {
      const message = json.message || {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.emit('assistant-chunk', { text: block.text });
        } else if (block.type === 'tool_use') {
          const toolName = block.name || 'Tool';
          const input = block.input || {};
          const summary = this.formatToolSummary(toolName, input);
          this.history.push({ role: 'toolUse', text: `${toolName}: ${summary}` });
          this.emit('tool-use', { toolName, summary });
        }
      }
      return;
    }

    if (type === 'user') {
      const message = json.message || {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          const isError = !!block.is_error;
          let summary = '';
          if (typeof block.content === 'string') {
            summary = block.content.slice(0, 120);
          }
          this.history.push({ role: 'toolResult', text: isError ? `ERROR: ${summary}` : summary });
          this.emit('tool-result', { summary, isError });
        }
      }
      return;
    }

    if (type === 'result') {
      const result = typeof json.result === 'string' ? json.result : '';
      if (result) this.history.push({ role: 'assistant', text: result });
      if (/Unable to connect to Anthropic services|api\.anthropic\.com|ERR_BAD_REQUEST|supported-countries/i.test(result)) {
        const hint =
          'Claude 当前网络不可达（api.anthropic.com）。请切换到可访问网络或配置代理后重试。';
        this.history.push({ role: 'error', text: hint });
        this.emit('error', { text: hint });
      }
      if (/Not logged in/i.test(result) || /Please run\s+\/login/i.test(result)) {
        this.emit('auth-required', { provider: 'claude', message: result });
      }
      this.isBusy = false;
      this.emit('busy', { busy: false });
      this.emit('turn-complete', {});
    }
  }

  formatToolSummary(toolName, input) {
    if (toolName === 'Bash') return input.command || '';
    if (toolName === 'Read') return input.file_path || '';
    if (toolName === 'Edit' || toolName === 'Write') return input.file_path || '';
    if (toolName === 'Glob' || toolName === 'Grep') return input.pattern || '';
    return input.description || Object.keys(input).slice(0, 3).join(', ');
  }
}

class GenericExecSession {
  constructor(providerId, characterId) {
    this.providerId = providerId;
    this.characterId = characterId;
    this.process = null;
    this.isBusy = false;
    this.history = [];
    this.onEvent = null;
    this.binaryPath = null;
  }

  emit(type, payload = {}) {
    if (this.onEvent) this.onEvent(type, payload);
  }

  buildEnvironment() {
    return buildCliEnvironment();
  }

  refreshBinary() {
    this.binaryPath = null;
  }

  resolveBinary() {
    if (this.binaryPath) return this.binaryPath;
    const result = spawnSync('where.exe', [this.providerId], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout) {
      const candidates = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (candidates.length > 0) {
        let selected = candidates[0];
        // On Windows npm global CLIs are typically *.cmd launchers.
        if (process.platform === 'win32') {
          const cmdCandidate = candidates.find((p) => p.toLowerCase().endsWith('.cmd'));
          const exeCandidate = candidates.find((p) => p.toLowerCase().endsWith('.exe'));
          const batCandidate = candidates.find((p) => p.toLowerCase().endsWith('.bat'));
          selected = cmdCandidate || exeCandidate || batCandidate || selected;
        }
        this.binaryPath = selected;
        return selected;
      }
    }
    return null;
  }

  startIfNeeded() {
    const binary = this.resolveBinary();
    if (!binary) {
      const msg = PROVIDERS[this.providerId]?.installMessage || `${this.providerId} CLI not found.`;
      this.history.push({ role: 'error', text: msg });
      this.emit('error', { text: msg });
      return false;
    }
    return true;
  }

  buildPrompt(message) {
    const prior = this.history.slice(0, -1);
    if (prior.length === 0) return message;
    const lines = [];
    for (const m of prior) {
      if (m.role === 'user') lines.push(`User: ${m.text}`);
      if (m.role === 'assistant') lines.push(`Assistant: ${m.text}`);
      if (m.role === 'error') lines.push(`Error: ${m.text}`);
    }
    return `Conversation so far:\n\n${lines.join('\n\n')}\n\n---\n\nUser follow-up: ${message}`;
  }

  buildArgs(prompt) {
    if (this.providerId === 'codex') {
      return ['exec', '--json', '--full-auto', '--skip-git-repo-check', prompt];
    }
    if (this.providerId === 'gemini') {
      return ['-p', prompt];
    }
    // Copilot CLI output format varies by version; JSON first, then fallback plain.
    return ['-p', prompt, '--output-format', 'json', '--allow-all'];
  }

  parseProviderOutput(raw) {
    const text = raw.trim();
    if (!text) return '';
    const lines = text.split(/\r?\n/);
    let out = '';
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const json = JSON.parse(s);
        const t = json.type || '';
        if (this.providerId === 'codex') {
          if (t === 'item.completed' && json.item && json.item.type === 'agent_message' && typeof json.item.text === 'string') {
            out += (out ? '\n' : '') + json.item.text;
          }
        } else if (this.providerId === 'gemini') {
          if (t === 'content' && typeof json.text === 'string') {
            out += (out ? '\n' : '') + json.text;
          }
        } else {
          const data = json.data || {};
          if (t === 'assistant.message' && typeof data.content === 'string') {
            out += (out ? '\n' : '') + data.content;
          } else if (t === 'assistant.message_delta' && typeof data.deltaContent === 'string') {
            out += data.deltaContent;
          } else if (typeof json.result === 'string') {
            out += (out ? '\n' : '') + json.result;
          }
        }
      } catch {
        out += (out ? '\n' : '') + s;
      }
    }
    return out.trim();
  }

  send(message) {
    if (!this.startIfNeeded()) return;
    this.isBusy = true;
    this.history.push({ role: 'user', text: message });
    this.emit('user', { text: message });
    this.emit('busy', { busy: true });

    const prompt = this.buildPrompt(message);
    const args = this.buildArgs(prompt);
    const proc = spawn(this.resolveBinary(), args, {
      cwd: os.homedir(),
      env: this.buildEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process = proc;

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      try {
        proc.kill();
      } catch {}
      this.process = null;
      this.isBusy = false;
      const timeoutMsg =
        this.providerId === 'codex'
          ? 'Codex timed out. This is commonly caused by unauthenticated MCP servers (figma/linear/notion). Run `codex mcp list` and either login or remove those servers.'
          : `${PROVIDERS[this.providerId].displayName} timed out.`;
      this.history.push({ role: 'error', text: timeoutMsg });
      this.emit('error', { text: timeoutMsg });
      this.emit('busy', { busy: false });
      this.emit('turn-complete', {});
    }, 35000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      finished = true;
      clearTimeout(timeout);
      this.process = null;
      this.isBusy = false;
      const msg = `Failed to launch ${PROVIDERS[this.providerId].displayName} CLI: ${err.message}`;
      this.history.push({ role: 'error', text: msg });
      this.emit('error', { text: msg });
      this.emit('busy', { busy: false });
      this.emit('turn-complete', {});
    });

    proc.on('exit', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      this.process = null;
      const parsed = this.parseProviderOutput(stdout);
      if (parsed) {
        this.history.push({ role: 'assistant', text: parsed });
        this.emit('assistant-chunk', { text: parsed });
      }
      if (!parsed && stderr.trim()) {
        let msg = stderr.trim();
        if (
          this.providerId === 'codex' &&
          /(responses_websocket|wss:\/\/api\.openai\.com\/v1\/responses|os error 10054|远程主机强迫关闭)/i.test(stderr)
        ) {
          msg =
            'Codex 无法连接到 OpenAI 实时通道（wss://api.openai.com/v1/responses，10054）。\n' +
            '通常是网络/代理拦截导致。请先在系统终端验证并配置代理：\n' +
            '1) setx HTTPS_PROXY http://127.0.0.1:7890\n' +
            '2) setx HTTP_PROXY  http://127.0.0.1:7890\n' +
            '3) 重开终端后执行 codex exec --json --full-auto --skip-git-repo-check "hi"\n' +
            '验证通过后再回桌宠窗口使用 Codex。';
          this.emit('auth-required', {
            provider: 'codex',
            message: 'Codex 网络连接异常，请先配置可用代理后重试。'
          });
        }
        if (
          this.providerId === 'codex' &&
          /(AuthRequired|invalid_token|mcp\.figma|mcp\.linear|mcp\.notion|oauth)/i.test(stderr)
        ) {
          msg =
            'Codex is blocked by unauthenticated MCP servers (figma/linear/notion).\n' +
            'Fix quickly:\n' +
            '1) codex login --device-auth\n' +
            '2) codex mcp list\n' +
            '3) codex mcp remove figma\n' +
            '   codex mcp remove linear\n' +
            '   codex mcp remove notion\n' +
            '(or login each MCP service instead of removing)';
        }
        if (
          this.providerId === 'codex' &&
          /(login|auth|unauthorized|forbidden|device-auth|Not logged in)/i.test(stderr)
        ) {
          this.emit('auth-required', {
            provider: 'codex',
            message: 'Codex CLI 未登录。请先在终端执行 `codex login --device-auth`。'
          });
        }
        if (this.providerId === 'copilot' && /No authentication information found/i.test(stderr)) {
          this.emit('auth-required', {
            provider: 'copilot',
            message: 'Copilot CLI 未登录。请先在终端运行 `copilot login` 完成授权。'
          });
        }
        this.history.push({ role: 'error', text: msg });
        this.emit('error', { text: msg });
      }
      this.isBusy = false;
      this.emit('busy', { busy: false });
      this.emit('turn-complete', {});
    });
  }

  terminate() {
    if (this.process) this.process.kill();
    this.process = null;
    this.isBusy = false;
  }
}

const sessionStore = {};

function normalizeCharacterId(id) {
  return id === 'jazz' ? 'jazz' : 'bruce';
}

function normalizeProviderId(id) {
  return Object.keys(PROVIDERS).includes(id) ? id : 'claude';
}

function currentProviderId() {
  return normalizeProviderId(loadState().selectedProvider);
}

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

function currentSession() {
  if (!activeChatCharacterId) return null;
  return getOrCreateSession(currentProviderId(), activeChatCharacterId);
}

function pushChatSnapshot() {
  if (!activeChatCharacterId) return;
  const state = loadState();
  const session = currentSession();
  if (!session) return;
  const provider = PROVIDERS[currentProviderId()];
  sendChat('provider', {
    id: provider.id,
    displayName: provider.displayName,
    inputPlaceholder: provider.inputPlaceholder
  });
  sendChat('theme', { theme: state.theme, characterId: activeChatCharacterId });
  sendChat('history', { messages: session.history });
  sendChat('busy', { busy: session.isBusy });
}

function sendPet(cmd, payload) {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.webContents.send('pet-command', cmd, payload);
}

function sendChat(event, payload = {}) {
  if (!chatWin || chatWin.isDestroyed()) return;
  if (!chatReady) {
    chatQueue.push({ event, payload });
    return;
  }
  chatWin.webContents.send('chat-event', event, payload);
}

function getSelectedDisplay() {
  const state = loadState();
  const displays = screen.getAllDisplays();
  if (state.pinnedDisplayId !== 'auto') {
    const selected = displays.find((d) => String(d.id) === String(state.pinnedDisplayId));
    if (selected) return selected;
  }
  return screen.getPrimaryDisplay();
}

function createPetWindow() {
  const target = getSelectedDisplay();
  const { x, y, width, height } = target.workArea;
  const winH = 200;
  const winY = y + height - winH;

  petWin = new BrowserWindow({
    x,
    y: winY,
    width,
    height: winH,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWin.on('closed', () => {
    petWin = null;
  });
  petWin.webContents.on('did-finish-load', () => {
    const state = loadState();
    sendPet('visibility', { bruce: state.showBruce, jazz: state.showJazz });
    sendPet('theme', { theme: state.theme });
    if (!state.onboardingDone) {
      sendPet('completion', { id: 'bruce', text: 'hi!' });
      if (state.sounds) sendPet('ding', { name: 'completion' });
    }
  });
}

function positionPetWindow() {
  if (!petWin || petWin.isDestroyed()) return;
  const target = getSelectedDisplay();
  const { x, y, width, height } = target.workArea;
  const winH = 200;
  const winY = y + height - winH;
  petWin.setBounds({ x, y: winY, width, height: winH });
}

function createChatWindow(anchor = null) {
  if (chatWin && !chatWin.isDestroyed()) return chatWin;

  chatWin = new BrowserWindow({
    width: 420,
    height: 310,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  chatWin.setAlwaysOnTop(true, 'floating');
  chatWin.loadFile(path.join(__dirname, 'renderer', 'terminal.html'));
  chatReady = false;
  chatQueue = [];

  chatWin.webContents.on('did-finish-load', () => {
    chatReady = true;
    for (const item of chatQueue) {
      chatWin.webContents.send('chat-event', item.event, item.payload);
    }
    chatQueue = [];
  });

  if (anchor) {
    const workArea = getSelectedDisplay().workArea;
    const x = Math.max(workArea.x, Math.min(Math.round(anchor.screenX - 210), workArea.x + workArea.width - 420));
    const y = Math.max(workArea.y + 40, Math.min(Math.round(anchor.screenY - 290), workArea.y + workArea.height - 310));
    chatWin.setPosition(x, y);
  } else {
    const target = getSelectedDisplay();
    const x = Math.round(target.workArea.x + target.workArea.width / 2 - 210);
    const y = Math.round(target.workArea.y + target.workArea.height - 310 - 220);
    chatWin.setPosition(x, Math.max(target.workArea.y + 40, y));
  }

  chatWin.on('closed', () => {
    sendPet('chat-closed', {});
    chatReady = false;
    chatQueue = [];
    chatWin = null;
    const session = currentSession();
    const state = loadState();
    if (session && session.isBusy) {
      const phrase = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
      sendPet('thinking', { id: activeChatCharacterId, text: phrase });
    }
    activeChatCharacterId = null;
    if (!state.onboardingDone) {
      state.onboardingDone = true;
      saveState(state);
      sendPet('hide-completion', {});
    }
  });

  return chatWin;
}

function openChat(payload) {
  activeChatCharacterId = normalizeCharacterId(payload?.id);
  const win = createChatWindow(payload.anchor || null);
  const state = loadState();
  win.show();
  win.focus();
  sendPet('chat-opened', { id: activeChatCharacterId });
  sendPet('hide-thinking', { id: activeChatCharacterId });
  sendPet('hide-completion', { id: activeChatCharacterId });

  const session = getOrCreateSession(currentProviderId(), activeChatCharacterId);
  pushChatSnapshot();

  if (!state.onboardingDone && activeChatCharacterId === 'bruce' && session.history.length === 0) {
    const welcome =
      "hey! we're bruce and jazz — your lil dock agents.\n\nclick either of us to open an AI chat. we'll walk around while you work and let you know when it's thinking.\n\ncheck the menu bar icon (top right) for provider, themes, sounds, and more options.";
    sendChat('welcome', { text: welcome });
  }
}

function buildDisplaySubmenu(state) {
  const displays = screen.getAllDisplays();
  const items = [
    {
      label: 'Auto (Main Display)',
      type: 'radio',
      checked: state.pinnedDisplayId === 'auto',
      click: () => {
        const next = loadState();
        next.pinnedDisplayId = 'auto';
        saveState(next);
        positionPetWindow();
        rebuildTrayMenu();
      }
    },
    { type: 'separator' }
  ];
  for (const d of displays) {
    const label = `${d.label || 'Display'} (${d.size.width}x${d.size.height})`;
    items.push({
      label,
      type: 'radio',
      checked: String(state.pinnedDisplayId) === String(d.id),
      click: () => {
        const next = loadState();
        next.pinnedDisplayId = String(d.id);
        saveState(next);
        positionPetWindow();
        rebuildTrayMenu();
      }
    });
  }
  return items;
}

function buildThemeSubmenu(state) {
  const themes = ['Peach', 'Midnight', 'Cloud', 'Moss'];
  return themes.map((theme) => ({
    label: theme,
    type: 'radio',
    checked: state.theme === theme,
    click: () => {
      const next = loadState();
      next.theme = theme;
      saveState(next);
      sendPet('theme', { theme });
      sendChat('theme', { theme, characterId: activeChatCharacterId || 'bruce' });
      rebuildTrayMenu();
    }
  }));
}

function buildProviderSubmenu(state) {
  const current = normalizeProviderId(state.selectedProvider);
  return Object.values(PROVIDERS).map((provider) => ({
    label: provider.displayName,
    type: 'radio',
    checked: current === provider.id,
    click: () => {
      const next = loadState();
      next.selectedProvider = provider.id;
      saveState(next);
      if (chatWin && !chatWin.isDestroyed() && activeChatCharacterId) {
        pushChatSnapshot();
      }
      rebuildTrayMenu();
    }
  }));
}

function trayImage() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="0" y="0" width="16" height="16" rx="3" fill="#ff9a4d"/><circle cx="5.5" cy="8" r="1.8" fill="#fff" opacity="0.95"/><circle cx="10.5" cy="8" r="1.8" fill="#fff" opacity="0.95"/></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return nativeImage.createFromDataURL(url);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = loadState();
  const menu = Menu.buildFromTemplate([
    {
      label: 'Bruce',
      type: 'checkbox',
      checked: s.showBruce,
      click: (item) => {
        const st = loadState();
        st.showBruce = item.checked;
        saveState(st);
        sendPet('visibility', { bruce: st.showBruce, jazz: st.showJazz });
      }
    },
    {
      label: 'Jazz',
      type: 'checkbox',
      checked: s.showJazz,
      click: (item) => {
        const st = loadState();
        st.showJazz = item.checked;
        saveState(st);
        sendPet('visibility', { bruce: st.showBruce, jazz: st.showJazz });
      }
    },
    { type: 'separator' },
    {
      label: 'Sounds',
      type: 'checkbox',
      checked: s.sounds,
      click: (item) => {
        const st = loadState();
        st.sounds = item.checked;
        saveState(st);
      }
    },
    {
      label: 'Provider',
      submenu: buildProviderSubmenu(s)
    },
    {
      label: 'Style',
      submenu: buildThemeSubmenu(s)
    },
    {
      label: 'Display',
      submenu: buildDisplaySubmenu(s)
    },
    { type: 'separator' },
    {
      label: 'Check for Updates…',
      click: () => {
        shell.openExternal(PROJECT_LINKS.releases);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('lil agents');
  rebuildTrayMenu();
}

function openProviderLoginTerminal(providerId) {
  const cwd = process.cwd();
  let cmd = 'claude';
  if (providerId === 'codex') cmd = 'codex login --device-auth';
  if (providerId === 'copilot') cmd = 'copilot login';
  if (providerId === 'gemini') cmd = 'gemini auth';
  const shellCmd = `cd /d "${cwd}" && ${cmd}`;
  try {
    const wt = spawn('wt.exe', ['cmd', '/k', shellCmd], { detached: true, stdio: 'ignore' });
    wt.unref();
    return true;
  } catch {
    try {
      execFile('powershell.exe', ['-NoExit', '-Command', `Set-Location "${cwd}"; ${cmd}`], {
        detached: true,
        stdio: 'ignore'
      }).unref();
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }
}

function wireSessionBridge(session, providerId, characterId) {
  session.onEvent = (event, payload) => {
    const isCurrent =
      activeChatCharacterId === characterId && normalizeProviderId(loadState().selectedProvider) === providerId;
    if (isCurrent) {
      if (event === 'assistant-chunk') sendChat('assistant-chunk', payload);
      if (event === 'tool-use') sendChat('tool-use', payload);
      if (event === 'tool-result') sendChat('tool-result', payload);
      if (event === 'error') sendChat('error', payload);
      if (event === 'auth-required') sendChat('auth-required', payload);
      if (event === 'turn-complete') sendChat('turn-complete', payload);
      if (event === 'session-ended') sendChat('error', { text: `${PROVIDERS[providerId].displayName} session ended.` });
      if (event === 'busy') sendChat('busy', payload);
    }

    const state = loadState();
    if (event === 'busy' && payload.busy) {
      if (activeChatCharacterId !== characterId) {
        const phrase = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
        sendPet('thinking', { id: characterId, text: phrase });
      }
    }
    if (event === 'turn-complete') {
      if (Notification.isSupported()) {
        const isFocused = chatWin && !chatWin.isDestroyed() && chatWin.isFocused();
        if (!isFocused) {
          new Notification({
            title: 'lil agents',
            body: `${PROVIDERS[providerId].displayName} 回复完成`,
            silent: true
          }).show();
        }
      }
      sendPet('hide-thinking', { id: characterId });
      const phrase = COMPLETION_PHRASES[Math.floor(Math.random() * COMPLETION_PHRASES.length)];
      if (activeChatCharacterId !== characterId) {
        sendPet('completion', { id: characterId, text: phrase });
      }
      if (state.sounds) {
        let next = Math.floor(Math.random() * COMPLETION_SOUND_FILES.length);
        if (COMPLETION_SOUND_FILES.length > 1) {
          while (next === lastCompletionSoundIndex) {
            next = Math.floor(Math.random() * COMPLETION_SOUND_FILES.length);
          }
        }
        lastCompletionSoundIndex = next;
        sendPet('ding', { file: COMPLETION_SOUND_FILES[next] });
      }
    }
    if (event === 'error') {
      sendPet('hide-thinking', { id: characterId });
    }
  };
}

function setupSessionBridges() {
  for (const providerId of Object.keys(PROVIDERS)) {
    for (const characterId of ['bruce', 'jazz']) {
      getOrCreateSession(providerId, characterId);
    }
  }
}

function updateJumpList() {
  try {
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
  } catch (err) {
    console.error('JumpList update failed:', err);
  }
}

app.whenReady().then(() => {
  // Handle --switch-provider command line argument
  const switchProviderArg = process.argv.find((a) => a.startsWith('--switch-provider='));
  if (switchProviderArg) {
    const providerId = normalizeProviderId(switchProviderArg.split('=')[1]);
    const state = loadState();
    if (state.selectedProvider !== providerId) {
      state.selectedProvider = providerId;
      saveState(state);
    }
  }

  setupSessionBridges();
  createPetWindow();
  createTray();
  updateJumpList();

  screen.on('display-metrics-changed', () => {
    positionPetWindow();
    rebuildTrayMenu();
  });
  screen.on('display-added', () => rebuildTrayMenu());
  screen.on('display-removed', () => rebuildTrayMenu());

  ipcMain.on('set-mouse-passthrough', (_, ignore) => {
    if (petWin && !petWin.isDestroyed()) {
      // forward=true keeps mouse-move events flowing to renderer while window is click-through,
      // so pets can detect hover and re-enable click capture on demand.
      if (ignore) {
        petWin.setIgnoreMouseEvents(true, { forward: true });
      } else {
        petWin.setIgnoreMouseEvents(false);
      }
    }
  });

  ipcMain.handle('pet-state-get', () => loadState());
  ipcMain.handle('pet-state-save', (_, state) => {
    saveState(state);
    rebuildTrayMenu();
    return true;
  });

  ipcMain.handle('asset-path', (_, relPath) => {
    const repoRoot = path.join(__dirname, '..');
    if (typeof relPath !== 'string' || !relPath.trim()) return null;

    const root = path.resolve(repoRoot);
    const abs = path.resolve(root, relPath);
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

    // Prevent path traversal: only allow files inside repository root.
    if (abs !== root && !abs.startsWith(rootWithSep)) return null;
    return pathToFileURL(abs).toString();
  });

  ipcMain.handle('open-chat', (_, payload) => {
    const anchor = payload && payload.anchor ? payload.anchor : null;
    openChat({ id: payload?.id, anchor });
    return true;
  });

  ipcMain.handle('close-chat', () => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.close();
    return true;
  });

  ipcMain.handle('chat-send-message', (_, payload) => {
    const session = currentSession();
    if (!session) return false;
    const text = (payload?.message || '').trim();
    if (!text) return false;

    if (text.startsWith('/')) {
      const cmd = text.split(' ')[0].toLowerCase();

      if (cmd === '/clear') {
        session.history = [];
        sendChat('history', { messages: [] });
        return true;
      }

      if (cmd === '/copy') {
        const last = session.history.slice().reverse().find((m) => m.role === 'assistant');
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

    session.send(text);
    return true;
  });

  ipcMain.handle('set-selected-provider', (_, payload) => {
    const nextId = normalizeProviderId(payload?.providerId);
    const state = loadState();
    if (state.selectedProvider !== nextId) {
      state.selectedProvider = nextId;
      saveState(state);
      rebuildTrayMenu();
    }
    if (chatWin && !chatWin.isDestroyed() && activeChatCharacterId) {
      pushChatSnapshot();
    }
    return true;
  });

  ipcMain.handle('open-external-url', async (_, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('open-claude-login-terminal', () => {
    return openProviderLoginTerminal('claude');
  });

  ipcMain.handle('open-codex-login-terminal', () => {
    return openProviderLoginTerminal('codex');
  });

  ipcMain.handle('open-copilot-login-terminal', () => {
    return openProviderLoginTerminal('copilot');
  });

  ipcMain.handle('open-gemini-login-terminal', () => {
    return openProviderLoginTerminal('gemini');
  });

  ipcMain.handle('copy-last-response', () => {
    const session = currentSession();
    const last = session?.history.slice().reverse().find((m) => m.role === 'assistant');
    if (last) {
      const { clipboard } = require('electron');
      clipboard.writeText(last.text);
      return true;
    }
    return false;
  });

  ipcMain.handle('check-for-updates', async () => {
    await shell.openExternal(PROJECT_LINKS.releases);
    return true;
  });
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  for (const providerBucket of Object.values(sessionStore)) {
    Object.values(providerBucket).forEach((session) => session.terminate());
  }
});
