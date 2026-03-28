const THINKING_PHRASES = [
  'hmm...',
  'thinking...',
  'one sec...',
  'ok hold on',
  'let me check',
  'working on it',
  'almost...',
  'bear with me',
  'on it!',
  'gimme a sec',
  'brb',
  'processing...',
  'hang tight',
  'just a moment',
  'figuring it out',
  'crunching...',
  'reading...',
  'looking...'
];

const COMPLETION_PHRASES = ['done!', 'all set!', 'ready!', 'here you go', 'got it!', 'finished!', 'ta-da!', 'voila!'];

const COMPLETION_SOUND_FILES = [
  'ping-aa.mp3',
  'ping-bb.mp3',
  'ping-cc.mp3',
  'ping-dd.mp3',
  'ping-ee.mp3',
  'ping-ff.mp3',
  'ping-gg.mp3',
  'ping-hh.mp3',
  'ping-jj.m4a'
];

const PROVIDERS = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    inputPlaceholder: 'Ask Claude...',
    installMessage: 'Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code'
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    inputPlaceholder: 'Ask Codex...',
    installMessage: 'Codex CLI not found. Install with: npm i -g @openai/codex'
  },
  copilot: {
    id: 'copilot',
    displayName: 'Copilot',
    inputPlaceholder: 'Ask Copilot...',
    installMessage: 'Copilot CLI not found. Install with: npm i -g @github/copilot'
  }
};

const PROJECT_LINKS = {
  releases: process.env.LIL_AGENTS_WIN_RELEASES_URL || 'https://github.com/Chapter-108/lil-agents-win/releases'
};

module.exports = {
  THINKING_PHRASES,
  COMPLETION_PHRASES,
  COMPLETION_SOUND_FILES,
  PROVIDERS,
  PROJECT_LINKS
};
