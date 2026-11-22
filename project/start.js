const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const electronPath = require('electron');

const DEV_PORT = 5188;
const DEV_URL = `http://localhost:${DEV_PORT}`;
const isDevMode = process.argv.includes('--dev');
const distIndex = path.join(__dirname, 'dist', 'index.html');

if (!isDevMode && fs.existsSync(distIndex)) {
    const electronEnv = { ...process.env };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    delete electronEnv.VITE_DEV_SERVER_URL;
    const child = spawn(electronPath, ['.'], {
        cwd: __dirname,
        env: electronEnv,
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    process.exit(0);
}

const viteBin = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');
const viteProc = spawn(
    process.execPath,
    [viteBin, '--port', String(DEV_PORT), '--strictPort'],
    { cwd: __dirname, stdio: 'inherit' }
);

function waitForVite(retries = 60) {
    return new Promise((resolve, reject) => {
        const tryConnect = (left) => {
            const req = http.get(DEV_URL, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', () => {
                if (left <= 0) reject(new Error('Vite dev server did not start'));
                else setTimeout(() => tryConnect(left - 1), 250);
            });
        };
        tryConnect(retries);
    });
}

waitForVite().then(() => {
    const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: DEV_URL };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, ['.'], {
        cwd: __dirname,
        env: electronEnv,
        stdio: 'inherit',
    });
    child.on('exit', () => {
        viteProc.kill();
        process.exit(0);
    });
}).catch((err) => {
    console.error(err);
    viteProc.kill();
    process.exit(1);
});
