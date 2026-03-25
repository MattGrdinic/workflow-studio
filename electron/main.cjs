const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const PORT = 4317;
const HOST = '127.0.0.1';
const SERVER_URL = `http://${HOST}:${PORT}`;

let serverProcess = null;
let mainWindow = null;

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

  serverProcess = spawn(process.execPath, [script, '--port', String(PORT)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  serverProcess.stdout.on('data', (data) => {
    process.stdout.write(`[server] ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Workflow Studio',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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

app.whenReady().then(async () => {
  startServer();

  try {
    await waitForServer();
  } catch (err) {
    dialog.showErrorBox(
      'Workflow Studio',
      'Failed to start the server. Please check the logs and try again.'
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
