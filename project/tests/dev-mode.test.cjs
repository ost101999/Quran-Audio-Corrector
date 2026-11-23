const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerDevMode } = require('../core/dev-mode');

test('corrector dev-mode detects engine updates and live-reloads core modules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-devmode-'));
  try {
    const baselineDir = path.join(tmp, 'baseline');
    const projectDir = path.join(tmp, 'project');
    const userDataDir = path.join(tmp, 'userData');
    fs.mkdirSync(path.join(baselineDir, 'core'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'vite', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'core'), { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    fs.writeFileSync(path.join(baselineDir, 'main.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'main.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'vite.config.ts'), '', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js'), '', 'utf8');
    fs.writeFileSync(path.join(userDataDir, 'project-root.txt'), projectDir, 'utf8');

    const coreFile = path.join(projectDir, 'core', 'live-check.js');
    fs.writeFileSync(coreFile, 'module.exports = { ver: 1 };\n', 'utf8');

    const handlers = new Map();
    const prevFull = process.env.AC_DEV_FULL;
    process.env.AC_DEV_FULL = '1';
    try {
      const devMode = registerDevMode({
        app: {
          isPackaged: false,
          getAppPath: () => baselineDir,
          getPath: () => userDataDir,
          on: () => {},
        },
        ipcMain: {
          handle: (name, fn) => handlers.set(name, fn),
        },
        dialog: {},
        getMainWindow: () => null,
      });

      assert.equal(devMode.isActive(), true);
      assert.equal(devMode.requireModule('./core/live-check.js').ver, 1);

      fs.writeFileSync(coreFile, 'module.exports = { ver: 2 };\n', 'utf8');
      assert.equal(devMode.requireModule('./core/live-check.js').ver, 2);

      assert.equal(handlers.get('dev-mode:status')().mainOutdated, false);
      fs.writeFileSync(path.join(projectDir, 'main.js'), 'const a = 2;\n', 'utf8');
      assert.equal(handlers.get('dev-mode:status')().mainOutdated, true);
    } finally {
      if (prevFull === undefined) delete process.env.AC_DEV_FULL;
      else process.env.AC_DEV_FULL = prevFull;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
