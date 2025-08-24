const path = require('path');
const { app, BrowserWindow, session, shell, ipcMain, screen } = require('electron');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
// Load .env from this app folder (without external deps)
function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) return;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    });
  } catch (e) {
    console.warn('Env load failed for', filePath, e.message);
  }
}
loadEnvFile(path.join(__dirname, '.env'));

// GPU toggles per platform (reduce noisy logs and ensure stable WebGL/WebAudio)
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-angle', 'metal');
  app.disableHardwareAcceleration();
} else if (process.platform === 'win32') {
  // ANGLE D3D11 is default; fallback to D3D9 if needed by uncommenting:
  // app.commandLine.appendSwitch('use-angle', 'd3d9');
}

let orbWindow = null;
let mainWindow = null;
let browserAgentProcess = null;
let voiceModeActive = false;
let autoVoiceTimer = null;

function startVoiceModeInternal() {
  try {
    if (!browserAgentProcess || !browserAgentProcess.stdin) return;
    if (voiceModeActive) return;
    browserAgentProcess.stdin.write('v\n');
    voiceModeActive = true;
  } catch (_) {}
}

function stopVoiceModeInternal() {
  try {
    if (!browserAgentProcess) return;
    if (!voiceModeActive) return;
    browserAgentProcess.kill('SIGINT');
    voiceModeActive = false;
  } catch (_) {}
}

// Resolve a working python3 executable by probing common absolute paths and validating with --version
function resolvePython3() {
  const candidates = [
    // Framework bundle executables (most reliable on macOS when installed from python.org)
    '/Library/Frameworks/Python.framework/Versions/Current/Resources/Python.app/Contents/MacOS/Python',
    '/Library/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python',
    '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python',
    // Homebrew / local
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    // System stub (may be sandbox-limited in some contexts)
    '/usr/bin/python3',
    // Last resort: rely on env
    '/usr/bin/env'
  ];

  for (const cmd of candidates) {
    try {
      if (!fs.existsSync(cmd) && cmd !== '/usr/bin/env') continue;
      const args = cmd === '/usr/bin/env' ? ['python3', '--version'] : ['--version'];
      const res = spawnSync(cmd, args, { stdio: 'ignore' });
      if (res && res.status === 0) {
        return cmd;
      }
    } catch (e) {
      // try next
    }
  }
  return null;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 500,
    height: 889,
    minWidth: 500,
    minHeight: 889,
    maxWidth: 500,
    maxHeight: 889,
    resizable: false,
    title: 'Bravo',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required'
    }
  });


  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile('index.html');

  // Position on the right side of the screen
  try { positionMainWindowRight(mainWindow); } catch (_) {}

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Show orb again (do not resume voice mode)
    try { if (orbWindow && !orbWindow.isDestroyed()) orbWindow.show(); } catch (_) {}
  });

  if (!app.isPackaged && process.env.BRAVO_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // When text window opens, hide orb and stop voice mode
  try { if (autoVoiceTimer) { clearTimeout(autoVoiceTimer); autoVoiceTimer = null; } } catch (_) {}
  try { if (orbWindow && !orbWindow.isDestroyed()) orbWindow.hide(); } catch (_) {}
  stopVoiceModeInternal();
  // Nudge agent back to text prompt in case voice handler swallowed SIGINT
  try { setTimeout(() => { try { if (browserAgentProcess && browserAgentProcess.stdin) browserAgentProcess.stdin.write('\n'); } catch (_) {} }, 200); } catch (_) {}

  return mainWindow;
}

// Start Browser Agent in background (prewarm) to reduce first-command latency
async function startBrowserAgentWarm() {
  if (browserAgentProcess) {
    return;
  }
  try {
    const projectRoot = path.dirname(__dirname);
    const browserAgentPath = path.join(projectRoot, 'Voice-Agent');
    console.log('[Warmup] Resolved ElevenLabs Voice Agent path:', browserAgentPath);
    if (!fs.existsSync(browserAgentPath)) {
      console.warn('[Warmup] Backend path not found, skipping prewarm:', browserAgentPath);
      return;
    }

    const pythonCmd = resolvePython3();
    if (!pythonCmd) {
      console.warn('[Warmup] No working python3 executable found, skipping prewarm.');
      return;
    }

    const execCmd = pythonCmd === '/usr/bin/env' ? '/usr/bin/env' : pythonCmd;
    const execArgs = pythonCmd === '/usr/bin/env' ? ['python3', '-u', 'main.py'] : ['-u', 'main.py'];
    console.log('[Warmup] Launching ElevenLabs Voice Agent with:', execCmd, execArgs.join(' '));

    browserAgentProcess = spawn(execCmd, execArgs, {
      cwd: browserAgentPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    // Removed auto-start of voice mode when only orb is present

    browserAgentProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('ElevenLabs Agent Output:', output);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-output', output);
      }
    });

    browserAgentProcess.stderr.on('data', (data) => {
      const raw = data.toString();
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        // Drop noisy INFO/DEBUG/WARNING/httpx logs; forward only real errors
        if (/\b(INFO|DEBUG|WARNING)\b/i.test(line)) continue;
        if (/httpx:HTTP Request:/i.test(line)) continue;
        console.error('ElevenLabs Agent Error:', line);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('browser-agent-error', line);
        }
      }
    });

    browserAgentProcess.on('close', (code) => {
      console.log(`[Warmup] ElevenLabs agent process exited with code ${code}`);
      browserAgentProcess = null;
      voiceModeActive = false;
      try { if (autoVoiceTimer) { clearTimeout(autoVoiceTimer); autoVoiceTimer = null; } } catch (_) {}
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-closed', code);
      }
    });

    browserAgentProcess.on('error', (error) => {
      console.error('[Warmup] ElevenLabs agent spawn error:', error);
      browserAgentProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-error', `Spawn error: ${error.message}`);
      }
    });
  } catch (error) {
    console.warn('[Warmup] Failed to start browser agent:', error);
  }
}

function positionOrb(win) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const margin = 20;
  const [w, h] = win.getSize();
  const x = Math.max(0, width - w - margin);
  const y = Math.max(0, margin); // place at top-right instead of bottom-right
  win.setPosition(x, y);
}

function positionMainWindowRight(win) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const margin = 20;
  const [w, h] = win.getSize();
  const x = Math.max(0, width - w - margin);
  const y = Math.max(0, Math.floor((height - h) / 2));
  win.setPosition(x, y);
}

function createOrbWindow() {
  if (orbWindow && !orbWindow.isDestroyed()) return orbWindow;

  orbWindow = new BrowserWindow({
    width: 92,
    height: 92,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    hasShadow: false,
    titleBarStyle: 'hidden',
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Ensure permissions (mic) prompts are allowed
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'speaker') {
      return callback(true);
    }
    callback(true);
  });

  orbWindow.loadFile('orb.html');
  orbWindow.once('ready-to-show', () => {
    positionOrb(orbWindow);
  });

  screen.on('display-metrics-changed', () => {
    if (!orbWindow || orbWindow.isDestroyed()) return;
    positionOrb(orbWindow);
  });

  orbWindow.on('closed', () => {
    orbWindow = null;
  });

  return orbWindow;
}

app.whenReady().then(() => {
  createOrbWindow();
  // Removed backend warmup to avoid unintended voice activation while orb is visible

  // Reposition windows when display metrics change
  screen.on('display-metrics-changed', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) positionMainWindowRight(mainWindow);
      if (orbWindow && !orbWindow.isDestroyed()) positionOrb(orbWindow);
    } catch (_) {}
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOrbWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Open main window from orb click
ipcMain.handle('open-main', () => {
  createMainWindow();
});

// IPC: Start browser agent
ipcMain.handle('start-browser-agent', async () => {
  if (browserAgentProcess) {
    return { success: true, message: 'Browser agent already running' };
  }
  
  try {
    const projectRoot = path.dirname(__dirname);
    const browserAgentPath = path.join(projectRoot, 'Voice-Agent');
    console.log('Resolved ElevenLabs Voice Agent path:', browserAgentPath);
    if (!fs.existsSync(browserAgentPath)) {
      return { success: false, message: `Backend path not found: ${browserAgentPath}` };
    }

    // Resolve a working python3 binary
    const pythonCmd = resolvePython3();
    if (!pythonCmd) {
      return { success: false, message: 'No working python3 executable found on this system.' };
    }

    const execCmd = pythonCmd === '/usr/bin/env' ? '/usr/bin/env' : pythonCmd;
    const execArgs = pythonCmd === '/usr/bin/env' ? ['python3', '-u', 'main.py'] : ['-u', 'main.py'];
    console.log('Launching ElevenLabs Voice Agent with:', execCmd, execArgs.join(' '));

    browserAgentProcess = spawn(execCmd, execArgs, {
      cwd: browserAgentPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    
    // Set up output handlers for the agent
    browserAgentProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('ElevenLabs Agent Output:', output);
      // Send output to renderer process
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-output', output);
      }
    });
    
    browserAgentProcess.stderr.on('data', (data) => {
      const raw = data.toString();
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        // Drop noisy INFO/DEBUG/WARNING/httpx logs; forward only real errors
        if (/\b(INFO|DEBUG|WARNING)\b/i.test(line)) continue;
        if (/httpx:HTTP Request:/i.test(line)) continue;
        console.error('ElevenLabs Agent Error:', line);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('browser-agent-error', line);
        }
      }
    });
    
    browserAgentProcess.on('close', (code) => {
      console.log(`ElevenLabs agent process exited with code ${code}`);
      browserAgentProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-closed', code);
      }
    });
    
    browserAgentProcess.on('error', (error) => {
      console.error('ElevenLabs agent spawn error:', error);
      browserAgentProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-error', `Spawn error: ${error.message}`);
      }
    });
    
    return { success: true, message: 'Browser agent started' };
  } catch (error) {
    return { success: false, message: `Failed to start browser agent: ${error.message}` };
  }
});

// IPC: Send message to browser agent
ipcMain.handle('send-to-browser-agent', (event, message) => {
  if (!browserAgentProcess) {
    return { success: false, message: 'Browser agent not running' };
  }
  
  try {
    browserAgentProcess.stdin.write(message + '\n');
    return { success: true };
  } catch (error) {
    return { success: false, message: `Failed to send message: ${error.message}` };
  }
});

// IPC: Start voice mode in ElevenLabs agent (simulate typing 'v' + Enter)
ipcMain.handle('start-voice-mode', () => {
  if (!browserAgentProcess) {
    return { success: false, message: 'Agent not running' };
  }
  try {
    browserAgentProcess.stdin.write('v\n');
    return { success: true };
  } catch (error) {
    return { success: false, message: `Failed to start voice mode: ${error.message}` };
  }
});

// IPC: Stop voice mode by sending SIGINT (agent handles it to end session)
ipcMain.handle('stop-voice-mode', () => {
  if (!browserAgentProcess) {
    return { success: false, message: 'Agent not running' };
  }
  try {
    browserAgentProcess.kill('SIGINT');
    return { success: true };
  } catch (error) {
    return { success: false, message: `Failed to stop voice mode: ${error.message}` };
  }
});

// IPC: Stop browser agent
ipcMain.handle('stop-browser-agent', () => {
  if (browserAgentProcess) {
    try {
      const proc = browserAgentProcess;
      browserAgentProcess = null;
      // Try graceful stop first
      proc.kill('SIGTERM');
      // Escalate after timeout if needed
      setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill('SIGKILL'); } catch (_) {}
        }
      }, 1500);
      return { success: true, message: 'Browser agent stopped' };
    } catch (e) {
      return { success: false, message: `Error stopping agent: ${e.message}` };
    }
  }
  return { success: false, message: 'Browser agent not running' };
});

// Voice agent removed - focusing on text mode only

// On quit, ask renderers to stop any active mic and kill agent processes
app.on('before-quit', () => {
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send('stop-mic');
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stop-mic');
  }
  
  // Kill browser agent process
  if (browserAgentProcess) {
    browserAgentProcess.kill();
    browserAgentProcess = null;
  }
});

// Removed all local STT/TTS IPC endpoints to ensure voice is handled only by the agent

