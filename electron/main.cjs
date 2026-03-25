const { app, BrowserWindow, shell, dialog, ipcMain, Notification } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const os = require('os');

const PORT = 4317;
const HOST = '127.0.0.1';

// macOS GUI apps get a minimal PATH. Augment with common binary locations
// so the server child process can find claude, node, aws, etc.
function getEnrichedPath() {
  const home = os.homedir();
  const extra = [
    path.join(home, '.local', 'bin'),          // claude CLI
    path.join(home, '.nvm', 'versions', 'node'), // nvm — resolved below
    '/opt/homebrew/bin',                         // Homebrew (Apple Silicon)
    '/opt/homebrew/sbin',
    '/usr/local/bin',                            // Homebrew (Intel) / system
  ];

  // Resolve active nvm node version if present
  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    const dirs = require('fs').readdirSync(nvmDir).filter(d => d.startsWith('v')).sort().reverse();
    if (dirs.length > 0) extra.push(path.join(nvmDir, dirs[0], 'bin'));
  } catch { /* nvm not installed */ }

  // On Windows, also check common locations
  if (process.platform === 'win32') {
    extra.push(path.join(home, 'AppData', 'Roaming', 'npm'));
    extra.push(path.join(home, '.local', 'bin'));
  }

  // Try to get the user's full shell PATH (macOS)
  if (process.platform === 'darwin') {
    try {
      const shellPath = execSync('/bin/zsh -ilc "echo $PATH"', { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (shellPath) return shellPath;
    } catch { /* fall through to manual augmentation */ }
  }

  const current = process.env.PATH || '';
  const combined = [...extra, ...current.split(path.delimiter)];
  // Deduplicate while preserving order
  return [...new Set(combined)].join(path.delimiter);
}
const SERVER_URL = `http://${HOST}:${PORT}`;

let serverProcess = null;
let mainWindow = null;
let serverStderr = '';

function getServerScript() {
  // In packaged app, resources are in the app.asar or unpacked directory
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'dist', 'cli.js');
  }
  return path.join(__dirname, '..', 'dist', 'cli.js');
}

function getServerCwd() {
  // Use the user's home directory as the working directory so config/workflows persist
  if (app.isPackaged) {
    return app.getPath('userData');
  }
  return path.join(__dirname, '..');
}

function startServer() {
  const script = getServerScript();
  const cwd = getServerCwd();

  const enrichedEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: getEnrichedPath() };

  serverProcess = spawn(process.execPath, [script, '--port', String(PORT)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: enrichedEnv,
  });

  serverProcess.stdout.on('data', (data) => {
    process.stdout.write(`[server] ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    serverStderr += data.toString();
    process.stderr.write(`[server] ${data}`);
  });

  serverProcess.on('exit', (code) => {
    console.log(`Server exited with code ${code}`);
    serverProcess = null;
  });
}

function waitForServer(retries = 30, interval = 200) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const socket = new net.Socket();
      socket.setTimeout(interval);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        attempts++;
        if (attempts >= retries) {
          reject(new Error('Server failed to start'));
        } else {
          setTimeout(check, interval);
        }
      });
      socket.once('timeout', () => {
        socket.destroy();
        attempts++;
        if (attempts >= retries) {
          reject(new Error('Server start timed out'));
        } else {
          setTimeout(check, interval);
        }
      });
      socket.connect(PORT, HOST);
    };
    check();
  });
}

function getPreloadPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'electron', 'preload.cjs');
  }
  return path.join(__dirname, 'preload.cjs');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Workflow Studio',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: getPreloadPath(),
    },
  });

  mainWindow.loadURL(SERVER_URL);

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC Handlers ---

ipcMain.handle('dialog:save', async (_event, options) => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || 'output.md',
    filters: options.filters || [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result;
});

ipcMain.handle('notification:show', async (_event, title, body) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    n.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
  }
});

app.whenReady().then(async () => {
  startServer();

  try {
    await waitForServer();
  } catch (err) {
    const detail = serverStderr
      ? `\n\nServer output:\n${serverStderr.slice(-500)}`
      : '';
    dialog.showErrorBox(
      'Workflow Studio',
      `Failed to start the server.${detail}`
    );
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
