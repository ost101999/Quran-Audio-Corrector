const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const FULL_DEV_ENV = 'AC_DEV_FULL';
const INSTALLED_APP_ENV = 'AC_INSTALLED_APP_PATH';
const ENGINE_FILES = [
  'main.js',
  'preload.js',
  'core/dev-mode.js',
  'core/app-update.js',
  'core/win-pdf-detector.ps1',
];

function registerDevMode({ app, ipcMain, dialog, getMainWindow, onStatusChange }) {
  let child = null;
  let active = process.env[FULL_DEV_ENV] === '1';
  const fullSource = process.env[FULL_DEV_ENV] === '1';
  let busy = false;
  let fullDevUrl = null;
  const installedUrl = pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href;

  const stop = () => {
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
      child = null;
    }
  };
  app.on('will-quit', stop);

  const validProjectRoot = (dir) =>
    Boolean(dir) &&
    fs.existsSync(path.join(dir, 'package.json')) &&
    (fs.existsSync(path.join(dir, 'vite.config.ts')) || fs.existsSync(path.join(dir, 'vite.config.js'))) &&
    fs.existsSync(path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'));

  const findRoot = () => {
    const candidates = [];
    try {
      const saved = fs.readFileSync(path.join(app.getPath('userData'), 'project-root.txt'), 'utf8').trim();
      if (saved) candidates.push(saved);
    } catch { /* ignore */ }
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'project-meta.json'), 'utf8'));
      if (meta?.projectRoot) candidates.push(meta.projectRoot);
    } catch { /* ignore */ }
    candidates.push(app.getAppPath());

    for (const raw of candidates) {
      if (!raw) continue;
      if (validProjectRoot(raw)) return raw;
      const nested = path.join(raw, 'project');
      if (validProjectRoot(nested)) return nested;
    }
    return null;
  };

  const getElectronBinary = (root) => {
    if (!root) return null;
    const bin = process.platform === 'darwin'
      ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    return fs.existsSync(bin) ? bin : null;
  };

  const getInstalledAppPath = () => {
    if (process.env[INSTALLED_APP_ENV] && fs.existsSync(process.env[INSTALLED_APP_ENV])) {
      return process.env[INSTALLED_APP_ENV];
    }
    if (app.isPackaged) {
      return process.platform === 'darwin'
        ? path.resolve(process.execPath, '../../..')
        : process.execPath;
    }
    return null;
  };

  const fileHash = (filePath) => {
    try {
      if (!fs.existsSync(filePath)) return 'missing';
      return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
      return 'error';
    }
  };

  const baselineRoot = app.getAppPath();
  const baselineHashes = new Map(
    ENGINE_FILES.map((rel) => [rel, fileHash(path.join(baselineRoot, rel))])
  );

  const hasEngineChanges = (root = findRoot()) => {
    if (!root) return false;
    return ENGINE_FILES.some((rel) => {
      const base = baselineHashes.get(rel);
      const live = fileHash(path.join(root, rel));
      return base !== live;
    });
  };

  const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

  const waitForServer = (port, processRef) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    let ended = false;
    const poll = () => {
      if (ended) return;
      if (processRef.exitCode !== null || processRef.signalCode !== null) {
        ended = true;
        return reject(new Error('توقف خادم التطوير قبل بدء التشغيل.'));
      }
      if (Date.now() > deadline) {
        ended = true;
        return reject(new Error('انتهت مهلة تشغيل وضع التطوير.'));
      }
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          ended = true;
          resolve();
        } else {
          setTimeout(poll, 250);
        }
      });
      req.setTimeout(500, () => req.destroy());
      req.on('error', () => setTimeout(poll, 250));
    };
    poll();
  });

  const startViteServer = async (root) => {
    stop();
    const port = await freePort();
    child = spawn(
      process.execPath,
      [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    child.on('error', () => { /* ignore */ });
    await waitForServer(port, child);
    return `http://127.0.0.1:${port}/`;
  };

  const delayedSpawn = (cmd, args, cwd, envObj) => {
    const helperScript = `
      const { spawn } = require('node:child_process');
      const cfg = JSON.parse(process.argv[1]);
      setTimeout(() => {
        try {
          const p = spawn(cfg.cmd, cfg.args, { cwd: cfg.cwd, env: cfg.env, detached: true, stdio: 'ignore', windowsHide: false });
          p.unref();
        } catch {}
      }, 400);
    `;
    const launcher = spawn(
      process.execPath,
      ['-e', helperScript, JSON.stringify({ cmd, args, cwd, env: envObj })],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    launcher.unref();
  };

  const launchFullSourceProcess = (root) => {
    const electronBin = getElectronBinary(root);
    if (!electronBin) return false;
    const installedAppPath = getInstalledAppPath();
    const childEnv = { ...process.env, [FULL_DEV_ENV]: '1' };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.VITE_DEV_SERVER_URL;
    if (installedAppPath) childEnv[INSTALLED_APP_ENV] = installedAppPath;
    stop();
    try { app.releaseSingleInstanceLock?.(); } catch { /* ignore */ }
    delayedSpawn(electronBin, ['.', '--hud-mode=bar'], root, childEnv);
    setTimeout(() => app.exit(0), 60);
    return true;
  };

  const launchInstalledProcess = () => {
    const installedAppPath = getInstalledAppPath();
    if (!installedAppPath) return false;
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv[FULL_DEV_ENV];
    delete childEnv[INSTALLED_APP_ENV];
    delete childEnv.VITE_DEV_SERVER_URL;
    stop();
    try { app.releaseSingleInstanceLock?.(); } catch { /* ignore */ }
    if (process.platform === 'darwin') {
      delayedSpawn('open', ['-n', installedAppPath, '--args', '--hud-mode=bar'], process.cwd(), childEnv);
    } else {
      delayedSpawn(installedAppPath, ['--hud-mode=bar'], path.dirname(installedAppPath), childEnv);
    }
    setTimeout(() => app.exit(0), 60);
    return true;
  };

  const resolveProjectRootWithDialog = async (win) => {
    let root = findRoot();
    if (root) return { root };
    const choice = await dialog.showOpenDialog(win || undefined, {
      title: 'اختر مجلد مشروع المصحح الصوتي (project)',
      properties: ['openDirectory'],
    });
    if (choice.canceled) return { canceled: true };
    const picked = choice.filePaths[0];
    const resolved = validProjectRoot(picked)
      ? picked
      : (validProjectRoot(path.join(picked, 'project')) ? path.join(picked, 'project') : null);
    if (!resolved) {
      return { error: 'مجلد المشروع غير صالح أو اعتماديات التطوير غير مثبتة.' };
    }
    fs.writeFileSync(path.join(app.getPath('userData'), 'project-root.txt'), resolved, 'utf8');
    return { root: resolved };
  };

  const clearProjectCache = (root) => {
    const realRoot = fs.realpathSync(root);
    const normalizedRoot = realRoot + path.sep;
    const nmPrefix = path.join(realRoot, 'node_modules') + path.sep;
    for (const cachedKey of Object.keys(require.cache)) {
      if (cachedKey.startsWith(normalizedRoot) && !cachedKey.startsWith(nmPrefix)) {
        delete require.cache[cachedKey];
      }
    }
  };

  const requireModule = (relPath) => {
    if (active) {
      const root = findRoot();
      if (root) {
        const candidate = path.resolve(root, relPath);
        try {
          const resolved = require.resolve(candidate);
          if (fs.existsSync(resolved)) {
            clearProjectCache(root);
            return require(resolved);
          }
        } catch { /* fallback to packaged module */ }
      }
    }
    return require(path.resolve(app.getAppPath(), relPath));
  };

  const isAvailable = () => app.isPackaged || fullSource;

  const getStatus = () => {
    const root = findRoot();
    return {
      available: isAvailable(),
      active,
      fullSource,
      mainOutdated: Boolean(active || fullSource) ? hasEngineChanges(root) : false,
    };
  };

  const toggleDevMode = async () => {
    const win = getMainWindow();
    if (!isAvailable() || !win || busy) {
      return { ok: false, error: 'تعذر تغيير وضع التطوير.' };
    }
    busy = true;
    try {
      const resolved = await resolveProjectRootWithDialog(win);
      if (resolved.canceled) return { ok: false, canceled: true };
      if (resolved.error || !resolved.root) return { ok: false, error: resolved.error || 'تعذر تحديد مجلد المشروع.' };
      const { root } = resolved;

      if (hasEngineChanges(root) && getElectronBinary(root)) {
        if (launchFullSourceProcess(root)) {
          return { ok: true, relaunching: true };
        }
      }

      if (active && fullSource) {
        if (launchInstalledProcess()) {
          return { ok: true, relaunching: true };
        }
        return { ok: false, error: 'تعذر العثور على مسار النسخة المثبتة.' };
      }

      let target = installedUrl;
      if (!active) {
        target = await startViteServer(root);
      }
      const entering = !active;
      active = entering;
      await win.loadURL(target);
      if (!entering) stop();
      onStatusChange?.();
      return { ok: true };
    } catch (error) {
      stop();
      active = fullSource;
      try { await win.loadURL(installedUrl); } catch { /* ignore */ }
      onStatusChange?.();
      return { ok: false, error: String(error?.message || error) };
    } finally {
      busy = false;
    }
  };

  ipcMain.handle('dev-mode:status', () => getStatus());
  ipcMain.handle('dev-mode:toggle', () => toggleDevMode());

  const prepareFullDevUrl = async () => {
    if (!fullSource) return null;
    const root = findRoot();
    if (!root) return null;
    try {
      fullDevUrl = await startViteServer(root);
      return fullDevUrl;
    } catch {
      return null;
    }
  };

  return {
    isActive: () => active,
    isFullSource: () => fullSource,
    getStatus,
    toggleDevMode,
    requireModule,
    prepareFullDevUrl,
    getOverrideStartUrl: () => fullDevUrl,
  };
}

module.exports = { registerDevMode };
