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

// No-op logging to preserve call sites without emitting logs
const DEBUG = false;
function logDebug() {}
function logInfo() {}
function logWarn() {}
function logError() {}

// Heuristic filter for noisy/benign agent errors we don't want in the UI
function isNoisyAgentError(line) {
  try {
    const text = String(line || '').trim();
    if (!text) return true;
    const patterns = [
      /websockets\.exceptions\.ConnectionClosedOK/i,
      /received\s+1000\s*\(OK\).*sent\s+1000\s*\(OK\)/i,
      /Traceback \(most recent call last\)/i,
      /Exception in thread/i,
      /During handling of the above exception/i,
      /OSError:\s*\[Errno\s*-?9987\]/i,
      /Stream not open/i,
      /Error in voice session:/i,
      /object str can\'?t be used in 'await' expression/i,
      /Enter your query \(or 'v' for voice, 'quit' to exit\):/i,
      /default_audio_interface\.py/i,
      /conversational_ai[\\/]conversation\.py/i,
      /ElevenLabs agent process exited/i
    ];
    for (const re of patterns) { if (re.test(text)) return true; }
    return false;
  } catch (_) {
    return false;
  }
}

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
  const attempts = [];
  // Env override: allow specifying an explicit interpreter (e.g., venv python)
  const override = process.env.BRAVO_PYTHON && String(process.env.BRAVO_PYTHON).trim();
  if (override) {
    try {
      if (fs.existsSync(override)) {
        attempts.push(`${override} --version`);
        const resOv = spawnSync(override, ['--version'], { stdio: 'ignore' });
        if (resOv && resOv.status === 0) {
          logInfo('resolvePython3: using BRAVO_PYTHON override', override);
          return override;
        }
      } else {
        attempts.push(`override not found: ${override}`);
      }
    } catch (e) {
      attempts.push('override failed: ' + (e && e.message));
    }
  }
  // Windows: prefer the launcher `py -3`, then fall back to PATH `python`/`python3`
  if (process.platform === 'win32') {
    try {
      attempts.push('py -3 --version');
      const resPy = spawnSync('py', ['-3', '--version'], { stdio: 'ignore' });
      if (resPy && resPy.status === 0) {
        logDebug('resolvePython3: using Windows launcher `py -3`');
        return 'py';
      }
    } catch (e) { attempts.push('py launcher failed: ' + (e && e.message)); }
    try {
      attempts.push('python --version');
      const resPython = spawnSync('python', ['--version'], { stdio: 'ignore' });
      if (resPython && resPython.status === 0) {
        logDebug('resolvePython3: using `python` from PATH');
        return 'python';
      }
    } catch (e) { attempts.push('python failed: ' + (e && e.message)); }
    try {
      attempts.push('python3 --version');
      const resPython3 = spawnSync('python3', ['--version'], { stdio: 'ignore' });
      if (resPython3 && resPython3.status === 0) {
        logDebug('resolvePython3: using `python3` from PATH');
        return 'python3';
      }
    } catch (e) { attempts.push('python3 failed: ' + (e && e.message)); }
    // Try common absolute install paths (best-effort)
    const winCandidates = [
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      'C:\\Program Files\\Python313\\python.exe',
      'C:\\Program Files\\Python312\\python.exe',
      'C:\\Program Files\\Python311\\python.exe',
      'C:\\Program Files (x86)\\Python313\\python.exe',
      'C:\\Program Files (x86)\\Python312\\python.exe',
      'C:\\Program Files (x86)\\Python311\\python.exe'
    ];
    for (const abs of winCandidates) {
      try {
        if (!fs.existsSync(abs)) continue;
        attempts.push(`${abs} --version`);
        const resAbs = spawnSync(abs, ['--version'], { stdio: 'ignore' });
        if (resAbs && resAbs.status === 0) {
          logDebug('resolvePython3: using absolute Windows path', abs);
          return abs;
        }
      } catch (e) { attempts.push(`${abs} failed: ` + (e && e.message)); }
    }
    logWarn('resolvePython3: no working Python found on Windows. Attempts:', attempts);
    return null;
  }

  // macOS/Linux
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
      attempts.push(`${cmd} ${args.join(' ')}`);
      const res = spawnSync(cmd, args, { stdio: 'ignore' });
      if (res && res.status === 0) {
        logDebug('resolvePython3: using', cmd);
        return cmd;
      }
    } catch (e) { attempts.push(`${cmd} failed: ` + (e && e.message)); }
  }
  logWarn('resolvePython3: no working Python found on macOS/Linux. Attempts:', attempts);
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
    
    if (!fs.existsSync(browserAgentPath)) {
      
      return;
    }

    const pythonCmd = resolvePython3();
    if (!pythonCmd) {
      
      return;
    }

    const execCmd = pythonCmd === '/usr/bin/env' ? '/usr/bin/env' : pythonCmd;
    const execArgs = pythonCmd === '/usr/bin/env' ? ['python3', '-u', 'main.py'] : ['-u', 'main.py'];
    

    browserAgentProcess = spawn(execCmd, execArgs, {
      cwd: browserAgentPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    // Removed auto-start of voice mode when only orb is present

    browserAgentProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
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
        if (isNoisyAgentError(line)) continue;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('browser-agent-error', line);
        }
      }
    });

    browserAgentProcess.on('close', (code) => {
      
      browserAgentProcess = null;
      voiceModeActive = false;
      try { if (autoVoiceTimer) { clearTimeout(autoVoiceTimer); autoVoiceTimer = null; } } catch (_) {}
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-closed', code);
      }
    });

    browserAgentProcess.on('error', (error) => {
      
      browserAgentProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-error', `Spawn error: ${error.message}`);
      }
    });
  } catch (error) {
    
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
    
    if (!fs.existsSync(browserAgentPath)) {
      
      return { success: false, message: `Backend path not found: ${browserAgentPath}` };
    }

    // Resolve a working python3 binary
    const pythonCmd = resolvePython3();
    if (!pythonCmd) {
      
      return { success: false, message: 'No working python3 executable found on this system.' };
    }

    const execCmd = pythonCmd === '/usr/bin/env' ? '/usr/bin/env' : pythonCmd;
    // On Windows, `py` launcher needs `-3` and script; others use -u main.py
    const execArgs = (process.platform === 'win32' && pythonCmd === 'py')
      ? ['-3', '-u', 'main.py']
      : (pythonCmd === '/usr/bin/env' ? ['python3', '-u', 'main.py'] : ['-u', 'main.py']);
    

    browserAgentProcess = spawn(execCmd, execArgs, {
      cwd: browserAgentPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    
    // Set up output handlers for the agent
    browserAgentProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
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
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('browser-agent-error', line);
        }
      }
    });
    
    browserAgentProcess.on('close', (code, signal) => {
      browserAgentProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-agent-closed', code);
      }
    });
    
    browserAgentProcess.on('error', (error) => {
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

