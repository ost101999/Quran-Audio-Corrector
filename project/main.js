const { app, BrowserWindow, ipcMain, globalShortcut, screen, clipboard, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const {
    extractPdfAnnotations,
    matchClipsToAnnotations,
    recolorAnnotationsToGreenInPdfBytes,
    mergeReportAndAudioSections,
} = require('./core/annotation-matcher');
const {
    SESSIONS_ROOT_DIR,
    HUD_STATE_PATH,
    loadHudState,
    saveHudState,
    OUTPUT_HTML_DIR,
    normalizeText,
    getTodayDateStr,
    loadSession,
    saveSession,
    loadOrCreateSession,
    addAudioClipToSession,
    removeClipFromSession,
    redoClipInSession,
    updateClipManualPin,
    readClipAudioDataUrl,
    getQuranTrackerStudents,
    readShortcutMushafs,
    readXodoOpenDocuments,
    resolveLatestPdfCopyForReading,
    matchWindowTitleToStudent,
} = require('./core/session-store');
const {
    renderPdfPagesToImages,
    buildInteractiveHtml,
    saveInteractiveHtmlFile,
    publishAudioSessionToCloud,
} = require('./core/publisher');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let lastKnownDetectedPdf = '';
let preReviewBounds = null;
let moveSaveTimer = null;
let barMovedSinceExpand = false;
let suppressMoveUntil = 0;
let winPdfWorker = null;
let winPdfWorkerReady = false;
let winPdfQueue = [];
let winPdfBuffer = '';

function ensureWinPdfWorker() {
    if (process.platform !== 'win32') return null;
    if (winPdfWorker && !winPdfWorker.killed) return winPdfWorker;
    const scriptPath = path.join(__dirname, 'core', 'win-pdf-detector.ps1').replace('app.asar', 'app.asar.unpacked');
    if (!fs.existsSync(scriptPath)) return null;
    winPdfWorkerReady = false;
    winPdfBuffer = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        winPdfBuffer += chunk;
        const lines = winPdfBuffer.split(/\r?\n/);
        winPdfBuffer = lines.pop() || '';
        for (const raw of lines) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            try {
                const msg = JSON.parse(trimmed);
                if (msg.ready) {
                    winPdfWorkerReady = true;
                    continue;
                }
                const next = winPdfQueue.shift();
                if (next) next.resolve(msg);
            } catch { /* ignore malformed line */ }
        }
    });
    child.on('exit', () => {
        winPdfWorker = null;
        winPdfWorkerReady = false;
        while (winPdfQueue.length) {
            const pending = winPdfQueue.shift();
            if (pending) pending.resolve(null);
        }
    });
    winPdfWorker = child;
    return child;
}

function queryWinDesktopPdfState(timeoutMs = 1500) {
    const child = ensureWinPdfWorker();
    if (!child || !child.stdin || child.killed) return Promise.resolve(null);
    return new Promise((resolve) => {
        let settled = false;
        const done = (val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(val);
        };
        const timer = setTimeout(() => {
            const idx = winPdfQueue.findIndex(q => q.resolve === done);
            if (idx !== -1) winPdfQueue.splice(idx, 1);
            done(null);
        }, winPdfWorkerReady ? timeoutMs : 3500);
        winPdfQueue.push({ resolve: done });
        try {
            child.stdin.write('POLL\n');
        } catch {
            done(null);
        }
    });
}

function clampHudCoordinates(x, y, width, height) {
    const primary = screen.getPrimaryDisplay().workArea;
    const rawX = Number.isFinite(Number(x)) ? Number(x) : primary.x + primary.width - width - 10;
    const rawY = Number.isFinite(Number(y)) ? Number(y) : primary.y + Math.round(primary.height * 0.28);
    const display = screen.getDisplayNearestPoint({ x: Math.round(rawX), y: Math.round(rawY) });
    const area = display?.bounds || display?.workArea || primary;
    const clampedX = Math.max(area.x, Math.min(Math.round(rawX), area.x + area.width - width));
    const clampedY = Math.max(area.y, Math.min(Math.round(rawY), area.y + area.height - height));
    return { x: clampedX, y: clampedY };
}

function runExec(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { windowsHide: true, timeout: 6000, ...opts }, (err, stdout, stderr) => {
            resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

async function detectActivePdfApp() {
    if (process.platform === 'win32') {
        const uiaState = await queryWinDesktopPdfState(1000);
        const openDocs = readXodoOpenDocuments();
        const findOpenDocByTitle = (rawLabel) => {
            const clean = String(rawLabel || '').replace(/\.pdf$/i, '').trim().toLowerCase();
            if (!clean) return null;
            return openDocs.find(d => {
                const base = path.basename(d.fileName, '.pdf').trim().toLowerCase();
                return base === clean || clean.includes(base) || base.includes(clean);
            }) || null;
        };

        if (uiaState) {
            const candidates = [
                ...(Array.isArray(uiaState.selectedTabs) ? uiaState.selectedTabs : []),
                ...(uiaState.fgTitle && !/^xodo$/i.test(uiaState.fgTitle.trim()) ? [uiaState.fgTitle] : []),
                ...(Array.isArray(uiaState.pdfTitles) ? uiaState.pdfTitles.filter(t => !/^xodo$/i.test(String(t || '').trim())) : []),
            ];
            for (const label of candidates) {
                const openMatch = findOpenDocByTitle(label);
                const resolvedPath = openMatch ? (openMatch.originalPath || openMatch.openCopyPath) : '';
                const matched = matchWindowTitleToStudent(label, resolvedPath);
                if (matched) {
                    return {
                        foreground: true,
                        title: openMatch ? openMatch.fileName : label,
                        filePath: matched.sourcePdfPath || resolvedPath,
                    };
                }
            }
        }

        const hasXodoHint = (uiaState?.xodoWinNames?.length || 0) > 0;
        if (openDocs.length > 0 && (hasXodoHint || /Xodo\.exe/i.test((await runExec('tasklist', ['/FI', 'IMAGENAME eq Xodo.exe', '/NH'], { timeout: 1500 })).stdout))) {
            for (const doc of openDocs) {
                const candidateMatch = matchWindowTitleToStudent(doc.fileName, doc.originalPath || doc.openCopyPath);
                if (candidateMatch) {
                    return {
                        foreground: true,
                        title: doc.fileName,
                        filePath: doc.originalPath || doc.openCopyPath,
                    };
                }
            }
            return {
                foreground: true,
                title: openDocs[0].fileName,
                filePath: openDocs[0].originalPath || openDocs[0].openCopyPath,
            };
        }
        return null;
    }

    if (process.platform === 'darwin') {
        const script = [
            'tell application "System Events"',
            '  set frontApp to name of first application process whose frontmost is true',
            '  set docName to ""',
            '  set docPath to ""',
            '  set hasAcrobat to (exists (some application process whose name contains "Acrobat"))',
            '  set hasPreview to (exists process "Preview")',
            '  set checkPreviewFirst to (frontApp is "Preview") or (not hasAcrobat and hasPreview)',
            '  if checkPreviewFirst and hasPreview then',
            '    try',
            '      set docName to name of front window of process "Preview"',
            '    end try',
            '    if docName is "" or docName is "Preview" then',
            '      try',
            '        tell application "Preview"',
            '          if (count of documents) > 0 then',
            '            set d to front document',
            '            set docName to name of d',
            '            try',
            '              set docPath to POSIX path of (path of d)',
            '            end try',
            '          end if',
            '        end tell',
            '      end try',
            '    end if',
            '  else if hasAcrobat then',
            '    try',
            '      set acrobatProc to first application process whose name contains "Acrobat"',
            '      set docName to name of front window of acrobatProc',
            '    end try',
            '    if docName is "" or docName contains "Acrobat" then',
            '      try',
            '        tell application "Adobe Acrobat"',
            '          if (count of documents) > 0 then',
            '            set d to front document',
            '            set docName to name of d',
            '            try',
            '              set docPath to POSIX path of (file alias of d)',
            '            end try',
            '          end if',
            '        end tell',
            '      end try',
            '    end if',
            '  end if',
            '  if docName is not "" then return frontApp & "|" & docName & "|" & docPath',
            'end tell',
            'return ""',
        ].join('\n');

        const lsofPromise = runExec('/usr/sbin/lsof', ['-c', 'AdobeAcrobat', '-c', 'Preview', '-Fn'], { timeout: 2500 });
        const osaPromise = runExec('osascript', ['-e', script], { timeout: 3500 });
        const [lsofRes, osaRes] = await Promise.all([lsofPromise, osaPromise]);

        const openPdfs = [];
        const seenPdfs = new Set();
        for (const rawLine of String(lsofRes?.stdout || '').split(/\r?\n/)) {
            if (!rawLine.startsWith('n/')) continue;
            const p = rawLine.slice(1).trim();
            if (!/\.pdf$/i.test(p)) continue;
            if (/^\/(?:Applications|System)\//i.test(p)) continue;
            if (/^\/Library\//i.test(p) && !/^\/Library\/CloudStorage\//i.test(p)) continue;
            if (seenPdfs.has(p) || !fs.existsSync(p)) continue;
            seenPdfs.add(p);
            openPdfs.push(p);
        }

        const line = String(osaRes?.stdout || '').trim();
        if (line) {
            const [frontApp, rawName, rawFilePath] = line.split('|');
            const title = (rawName || '').trim();
            let filePath = (rawFilePath || '').trim();
            if (!filePath && title) {
                const normTitle = normalizeText(path.basename(title, '.pdf'));
                const matchedOpen = openPdfs.find((p) => {
                    const normBase = normalizeText(path.basename(p, '.pdf'));
                    return normBase === normTitle || normTitle.includes(normBase) || normBase.includes(normTitle);
                });
                if (matchedOpen) filePath = matchedOpen;
            }
            if (title || filePath) {
                return {
                    foreground: /Acrobat|Preview/i.test(frontApp || ''),
                    title: title || path.basename(filePath),
                    filePath,
                };
            }
        }

        if (openPdfs.length > 0) {
            for (const p of openPdfs) {
                const candidate = matchWindowTitleToStudent(path.basename(p), p);
                if (candidate) {
                    return {
                        foreground: true,
                        title: path.basename(p),
                        filePath: candidate.sourcePdfPath || p,
                    };
                }
            }
            return {
                foreground: true,
                title: path.basename(openPdfs[0]),
                filePath: openPdfs[0],
            };
        }
        return null;
    }
    return null;
}

async function triggerAutoSavePdfViewer(sourcePdfPath, lastRecordedAt) {
    if (!sourcePdfPath || !fs.existsSync(sourcePdfPath)) {
        return { saved: false, reason: 'NO_FILE' };
    }
    const beforeMtime = fs.statSync(sourcePdfPath).mtimeMs;
    if (lastRecordedAt && beforeMtime >= lastRecordedAt) {
        return { saved: true, alreadyFresh: true };
    }

    if (process.platform === 'win32') {
        const psSave = [
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type @"',
            'using System;',
            'using System.Text;',
            'using System.Runtime.InteropServices;',
            'public class WinSave {',
            '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
            '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
            '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
            '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
            '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
            '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
            '}',
            '"@',
            '$script:target = [IntPtr]::Zero',
            '$cb = [WinSave+EnumWindowsProc]{ param($h,$l) if ([WinSave]::IsWindowVisible($h)) { $sb = New-Object System.Text.StringBuilder 512; [WinSave]::GetWindowText($h, $sb, 512) | Out-Null; if ($sb.ToString() -match "Xodo") { $script:target = $h; return $false } }; return $true }',
            '[WinSave]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null',
            'if ($script:target -ne [IntPtr]::Zero) { [WinSave]::ShowWindow($script:target, 9) | Out-Null; [WinSave]::SetForegroundWindow($script:target) | Out-Null; Start-Sleep -Milliseconds 180; [System.Windows.Forms.SendKeys]::SendWait("^s"); Write-Output "SENT" }',
        ].join('\n');
        await runExec('powershell.exe', ['-NoProfile', '-Command', psSave], { timeout: 5000 });
    } else if (process.platform === 'darwin') {
        const targetName = path.basename(sourcePdfPath);
        const script = [
            'on run argv',
            '  set targetName to item 1 of argv',
            '  tell application "Adobe Acrobat"',
            '    if (count of documents) > 0 then',
            '      set matchedDocs to (every document whose name is targetName)',
            '      if (count of matchedDocs) > 0 then',
            '        save item 1 of matchedDocs',
            '      else',
            '        save front document',
            '      end if',
            '    end if',
            '  end tell',
            'end run',
        ].join('\n');
        await runExec('osascript', ['-e', script, targetName], { timeout: 5000 });
    }

    const deadline = Date.now() + 2600;
    while (Date.now() < deadline) {
        try {
            const st = fs.statSync(sourcePdfPath);
            if (st.mtimeMs > beforeMtime) return { saved: true, alreadyFresh: false };
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 200));
    }
    return { saved: false, reason: 'TIMEOUT' };
}

async function copyFileToOsClipboard(filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { success: false, error: 'الملف غير موجود' };
    if (process.platform === 'win32') {
        const { err } = await runExec('powershell.exe', [
            '-NoProfile',
            '-Sta',
            '-Command',
            'Add-Type -AssemblyName System.Windows.Forms; $list = New-Object System.Collections.Specialized.StringCollection; $list.Add($env:CLIP_PATH) | Out-Null; $data = New-Object System.Windows.Forms.DataObject; $data.SetFileDropList($list); [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100);',
        ], { env: { ...process.env, CLIP_PATH: resolved }, timeout: 10000 });
        return err ? { success: false, error: err.message } : { success: true };
    }
    if (process.platform === 'darwin') {
        const jxa = [
            'ObjC.import("AppKit");',
            'function run(argv) {',
            '  const pb = $.NSPasteboard.generalPasteboard;',
            '  pb.clearContents;',
            '  const url = $.NSURL.fileURLWithPath(argv[0]);',
            '  return pb.writeObjects($.NSArray.arrayWithObject(url)) ? "OK" : "FAIL";',
            '}',
        ].join('\n');
        const { err, stdout } = await runExec('osascript', ['-l', 'JavaScript', '-e', jxa, resolved], { timeout: 8000 });
        return (!err && stdout.trim() === 'OK') ? { success: true } : { success: false, error: err?.message || 'تعذر النسخ' };
    }
    return { success: false, error: 'غير مدعوم' };
}

function createWindow() {
    const savedHud = loadHudState();
    const initialMode = savedHud?.mode === 'pill' ? 'pill' : 'bar';
    const initW = initialMode === 'pill' ? 128 : 432;
    const initH = initialMode === 'pill' ? 156 : 192;
    const startX = initialMode === 'pill' && Number.isFinite(Number(savedHud?.pillPos?.x))
        ? savedHud.pillPos.x
        : savedHud?.x;
    const startY = initialMode === 'pill' && Number.isFinite(Number(savedHud?.pillPos?.y))
        ? savedHud.pillPos.y
        : savedHud?.y;
    const pos = clampHudCoordinates(startX, startY, initW, initH);

    mainWindow = new BrowserWindow({
        width: initW,
        height: initH,
        x: pos.x,
        y: pos.y,
        title: 'المصحح الصوتي',
        icon: path.join(__dirname, '.icons', process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'),
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        hasShadow: false,
        skipTaskbar: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
            additionalArguments: [`--hud-mode=${initialMode}`],
        },
    });
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform === 'darwin') mainWindow.setAlwaysOnTop(true, 'floating');
    else mainWindow.setAlwaysOnTop(true, 'screen-saver');

    const persistCurrentBounds = (fromUserMove = false) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const b = mainWindow.getBounds();
        if (b.width > 460) return; // Never overwrite docked bar/pill position with centered Review modal
        const isPill = b.width <= 160;
        if (isPill) {
            saveHudState({ x: b.x, y: b.y, mode: 'pill', pillPos: { x: b.x, y: b.y } });
        } else {
            if (fromUserMove) barMovedSinceExpand = true;
            saveHudState({ x: b.x, y: b.y, mode: 'bar' });
        }
    };

    mainWindow.on('moved', () => {
        if (Date.now() < suppressMoveUntil) return;
        if (moveSaveTimer) clearTimeout(moveSaveTimer);
        moveSaveTimer = setTimeout(() => persistCurrentBounds(true), 220);
    });
    mainWindow.on('show', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setSkipTaskbar(false);
        }
        updateTrayMenu();
    });
    mainWindow.on('hide', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setSkipTaskbar(true);
        }
        updateTrayMenu();
    });
    mainWindow.on('close', (ev) => {
        if (moveSaveTimer) {
            clearTimeout(moveSaveTimer);
            moveSaveTimer = null;
        }
        persistCurrentBounds(false);
        if (!isQuitting) {
            ev.preventDefault();
            hideHudWindow();
        }
    });
    mainWindow.webContents.on('render-process-gone', (_ev, details) => {
        if (isQuitting) return;
        if (details?.reason !== 'clean-exit') {
            setTimeout(() => {
                if (!mainWindow || mainWindow.isDestroyed()) {
                    createWindow();
                } else {
                    mainWindow.reload();
                    showHudWindow();
                }
            }, 300);
        }
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
        mainWindow.loadURL(devUrl);
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }
}

function showHudWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (process.platform === 'darwin') {
        app.show();
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    try {
        const b = mainWindow.getBounds();
        const clamped = clampHudCoordinates(b.x, b.y, b.width, b.height);
        if (clamped.x !== b.x || clamped.y !== b.y) {
            mainWindow.setPosition(clamped.x, clamped.y);
        }
    } catch { /* ignore bounds check */ }
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    if (process.platform === 'darwin') {
        app.focus({ steal: true });
    }
    mainWindow.focus();
}

function hideHudWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
    mainWindow.setSkipTaskbar(true);
    if (process.platform === 'darwin') {
        app.hide();
    }
}

function toggleHudVisibility() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (mainWindow.isVisible()) {
        hideHudWindow();
    } else {
        showHudWindow();
    }
}

function buildHudMenu() {
    const visible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
    return Menu.buildFromTemplate([
        visible
            ? { label: 'إخفاء بجانب الساعة', click: () => hideHudWindow() }
            : { label: 'إظهار المصحح الصوتي', click: () => showHudWindow() },
        { type: 'separator' },
        {
            label: 'إغلاق المصحح الصوتي',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);
}

function updateTrayMenu() {
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(buildHudMenu());
}

function createTray() {
    if (tray && !tray.isDestroyed()) return tray;
    const pngPath = path.join(__dirname, '.icons', 'app-icon.png');
    const icoPath = path.join(__dirname, '.icons', 'app-icon.ico');
    let trayIcon = fs.existsSync(pngPath)
        ? nativeImage.createFromPath(pngPath)
        : (fs.existsSync(icoPath) ? nativeImage.createFromPath(icoPath) : nativeImage.createEmpty());
    if (!trayIcon.isEmpty()) {
        trayIcon = trayIcon.resize({ width: 32, height: 32 });
    }
    tray = new Tray(trayIcon);
    tray.setToolTip(process.platform === 'darwin' ? 'المصحح الصوتي (Fn + R)' : 'المصحح الصوتي (RCtrl + R)');
    tray.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) hideHudWindow();
        else showHudWindow();
    });
    updateTrayMenu();
    return tray;
}

function createMacAppMenu() {
    if (process.platform !== 'darwin') return;
    const sendEditAction = (action) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hud-edit-action', action);
        }
    };
    const menu = Menu.buildFromTemplate([
        {
            label: 'المصحح الصوتي',
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                {
                    label: 'إغلاق المصحح الصوتي',
                    accelerator: 'Cmd+Q',
                    click: () => {
                        isQuitting = true;
                        app.quit();
                    },
                },
            ],
        },
        {
            label: 'Edit',
            submenu: [
                { label: 'Undo', accelerator: 'Cmd+Z', click: () => sendEditAction('undo') },
                { label: 'Redo', accelerator: 'Shift+Cmd+Z', click: () => sendEditAction('redo') },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
    ]);
    Menu.setApplicationMenu(menu);
}

function registerShortcuts() {
    const bindings = [
        ['F20', 'toggle-record'],
        ['F22', 'undo-last'],
        ['F21', 'redo-last'],
        ['F17', 'finish-export'],
    ];
    for (const [accel, action] of bindings) {
        try {
            globalShortcut.register(accel, () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('hud-shortcut', action);
                }
            });
        } catch { /* ignore shortcut collision */ }
    }
}

const HUD_PID_PATH = path.join(path.dirname(HUD_STATE_PATH), 'hud.pid');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        showHudWindow();
    });
    app.whenReady().then(() => {
        fs.mkdirSync(SESSIONS_ROOT_DIR, { recursive: true });
        try { fs.writeFileSync(HUD_PID_PATH, String(process.pid), 'utf8'); } catch { /* ignore */ }
        createMacAppMenu();
        createWindow();
        createTray();
        registerShortcuts();
    });
    if (process.platform !== 'win32') {
        process.on('SIGUSR1', () => {
            toggleHudVisibility();
        });
    }
    app.on('activate', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            showHudWindow();
        } else {
            createWindow();
        }
    });
}

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('will-quit', () => {
    try {
        if (fs.existsSync(HUD_PID_PATH) && fs.readFileSync(HUD_PID_PATH, 'utf8').trim() === String(process.pid)) {
            fs.unlinkSync(HUD_PID_PATH);
        }
    } catch { /* ignore */ }
    globalShortcut.unregisterAll();
    if (tray && !tray.isDestroyed()) {
        try { tray.destroy(); } catch { /* ignore */ }
    }
    if (winPdfWorker && !winPdfWorker.killed) {
        try { winPdfWorker.kill(); } catch { /* ignore */ }
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// === IPC Handlers ===

ipcMain.handle('hud:show-context-menu', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    buildHudMenu().popup({ window: mainWindow });
});

ipcMain.handle('hud:hide-to-tray', () => {
    hideHudWindow();
    return { ok: true };
});

ipcMain.handle('hud:resize', (_event, { width, height, anchorSide }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const area = display.bounds || display.workArea;
    const workArea = display.workArea || area;
    const nextW = Math.round(Math.max(68, Math.min(Number(width) || 78, workArea.width - 20)));
    const nextH = Math.round(Math.max(88, Math.min(Number(height) || 112, workArea.height - 20)));

    if (anchorSide === 'center') {
        if (bounds.width <= 460) preReviewBounds = { ...bounds };
        suppressMoveUntil = Date.now() + 400;
        const centerX = Math.max(workArea.x + 8, Math.round(workArea.x + (workArea.width - nextW) / 2));
        const centerY = Math.max(workArea.y + 8, Math.round(workArea.y + (workArea.height - nextH) / 2));
        mainWindow.setBounds({ x: centerX, y: centerY, width: nextW, height: nextH });
        return { ok: true };
    }

    if (preReviewBounds) {
        suppressMoveUntil = Date.now() + 400;
        const restoredPos = clampHudCoordinates(preReviewBounds.x, preReviewBounds.y, nextW, nextH);
        preReviewBounds = null;
        mainWindow.setBounds({ x: restoredPos.x, y: restoredPos.y, width: nextW, height: nextH });
        return { ok: true };
    }

    if (bounds.width === nextW && bounds.height === nextH) {
        return { ok: true };
    }

    suppressMoveUntil = Date.now() + 400;
    const targetMode = nextW <= 160 ? 'pill' : 'bar';
    const currentIsPill = bounds.width <= 160;

    if (currentIsPill && targetMode === 'bar') {
        // Remember exact pill coordinates before expanding, then grow away from screen edges
        const pillPos = { x: bounds.x, y: bounds.y };
        barMovedSinceExpand = false;
        const onRightHalf = (bounds.x + bounds.width / 2) > (area.x + area.width / 2);
        const onBottomHalf = (bounds.y + bounds.height / 2) > (area.y + area.height / 2);
        const rawX = onRightHalf ? (bounds.x + bounds.width - nextW) : bounds.x;
        const rawY = onBottomHalf ? (bounds.y + bounds.height - nextH) : bounds.y;
        const clamped = clampHudCoordinates(rawX, rawY, nextW, nextH);
        mainWindow.setBounds({ x: clamped.x, y: clamped.y, width: nextW, height: nextH });
        saveHudState({ x: clamped.x, y: clamped.y, mode: 'bar', pillPos });
        return { ok: true };
    }

    if (!currentIsPill && targetMode === 'pill') {
        const saved = loadHudState();
        if (!barMovedSinceExpand && Number.isFinite(Number(saved?.pillPos?.x)) && Number.isFinite(Number(saved?.pillPos?.y))) {
            const restoredPill = clampHudCoordinates(saved.pillPos.x, saved.pillPos.y, nextW, nextH);
            mainWindow.setBounds({ x: restoredPill.x, y: restoredPill.y, width: nextW, height: nextH });
            saveHudState({ x: restoredPill.x, y: restoredPill.y, mode: 'pill', pillPos: restoredPill });
            return { ok: true };
        }
        const onRightHalf = (bounds.x + bounds.width / 2) > (area.x + area.width / 2);
        const onBottomHalf = (bounds.y + bounds.height / 2) > (area.y + area.height / 2);
        const rawX = onRightHalf ? (bounds.x + bounds.width - nextW) : bounds.x;
        const rawY = onBottomHalf ? (bounds.y + bounds.height - nextH) : bounds.y;
        const clamped = clampHudCoordinates(rawX, rawY, nextW, nextH);
        mainWindow.setBounds({ x: clamped.x, y: clamped.y, width: nextW, height: nextH });
        saveHudState({ x: clamped.x, y: clamped.y, mode: 'pill', pillPos: clamped });
        return { ok: true };
    }

    const clamped = clampHudCoordinates(bounds.x, bounds.y, nextW, nextH);
    mainWindow.setBounds({ x: clamped.x, y: clamped.y, width: nextW, height: nextH });
    saveHudState({ x: clamped.x, y: clamped.y, mode: targetMode });
    return { ok: true };
});

ipcMain.handle('hud:snap-edge', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const bounds = mainWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const snapRight = (bounds.x + bounds.width / 2) > (area.x + area.width / 2);
    const nextX = snapRight ? area.x + area.width - bounds.width - 10 : area.x + 10;
    const nextY = Math.max(area.y + 10, Math.min(bounds.y, area.y + area.height - bounds.height - 10));
    mainWindow.setPosition(Math.round(nextX), Math.round(nextY));
    if (bounds.width <= 460) {
        saveHudState({ x: Math.round(nextX), y: Math.round(nextY), mode: bounds.width <= 160 ? 'pill' : 'bar' });
    }
    return { ok: true, side: snapRight ? 'right' : 'left' };
});

ipcMain.handle('hud:get-state', () => {
    return loadHudState();
});

ipcMain.handle('hud:save-mic', (_event, payload) => {
    return saveHudState({
        micDeviceId: String(payload?.deviceId || ''),
        micLabel: String(payload?.label || ''),
    });
});

ipcMain.handle('hud:list-students', () => {
    const students = getQuranTrackerStudents();
    const shortcuts = readShortcutMushafs();
    return students.map(s => {
        const normStudent = normalizeText(s.name);
        const foundShortcut = shortcuts.find(sc => normalizeText(sc.parentFolder) === normStudent);
        return {
            id: s.id,
            name: s.name,
            academy: s.academy || '',
            sourcePdfPath: foundShortcut && fs.existsSync(foundShortcut.localPath) ? foundShortcut.localPath : '',
        };
    });
});

ipcMain.handle('hud:detect-active-student', async () => {
    const detected = await detectActivePdfApp();
    if (!detected) return { detected: null };
    const match = matchWindowTitleToStudent(detected.title, detected.filePath);
    if (match?.sourcePdfPath) lastKnownDetectedPdf = match.sourcePdfPath;
    return { detected: match, foreground: detected.foreground, rawTitle: detected.title };
});

ipcMain.handle('session:load-or-create', (_event, payload) => {
    return loadOrCreateSession({
        studentId: payload?.studentId || '',
        studentName: payload?.studentName || 'طالب بدون اسم',
        sourcePdfPath: payload?.sourcePdfPath || lastKnownDetectedPdf || '',
        dateStr: payload?.dateStr || getTodayDateStr(),
    });
});

ipcMain.handle('session:add-clip', (_event, { sessionKey, audioBytes, ext, startedAt, endedAt, durationMs }) => {
    return addAudioClipToSession(sessionKey, {
        buffer: Buffer.from(audioBytes),
        ext: ext || 'mp3',
        startedAt,
        endedAt,
        durationMs,
    });
});

ipcMain.handle('session:remove-clip', (_event, { sessionKey, clipId }) => {
    return removeClipFromSession(sessionKey, clipId || null);
});

ipcMain.handle('session:redo-clip', (_event, { sessionKey }) => {
    return redoClipInSession(sessionKey);
});

ipcMain.handle('session:update-pin', (_event, { sessionKey, clipId, pdfPage, xPercent, yPercent }) => {
    return updateClipManualPin(sessionKey, clipId, { pdfPage, xPercent, yPercent });
});

ipcMain.handle('session:match-annotations', async (_event, { sessionKey, sourcePdfPath, autoSave }) => {
    const session = (sessionKey ? loadSession(sessionKey) : null) || loadOrCreateSession({});
    const pdfPath = sourcePdfPath || session.sourcePdfPath;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
        return { success: false, error: 'لم يتم العثور على ملف PDF مصحف الطالب.', markers: [], unmatchedClips: session.clips || [] };
    }
    if (pdfPath && session.sourcePdfPath !== pdfPath) {
        session.sourcePdfPath = pdfPath;
        saveSession(session);
    }
    try {
        if (autoSave) {
            await triggerAutoSavePdfViewer(pdfPath, session.lastRecordedAt);
        }
        const readablePdfPath = resolveLatestPdfCopyForReading(pdfPath);
        const bytes = fs.readFileSync(readablePdfPath);
        const annotations = await extractPdfAnnotations(bytes);
        const { markers, unmatchedClips, unmatchedNewAnnotations } = matchClipsToAnnotations(session.clips || [], annotations, {
            sessionStartedAt: session.startedAt || 0,
        });
        const { sections, allPdfPages } = mergeReportAndAudioSections({
            reportSections: [],
            markers,
            unmatchedNewAnnotations,
        });
        const recentAnnotatedPages = [...annotations]
            .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0))
            .map(a => a.pdfPage)
            .filter((p, idx, arr) => Number.isInteger(p) && arr.indexOf(p) === idx)
            .slice(0, 2);
        const suggestedPages = allPdfPages.length > 0
            ? allPdfPages
            : (recentAnnotatedPages.length > 0 ? recentAnnotatedPages : [1]);
        return {
            success: true,
            sourcePdfPath: readablePdfPath,
            markers,
            unmatchedClips,
            unmatchedNewAnnotations,
            sections,
            allPdfPages,
            suggestedPages,
        };
    } catch (err) {
        return {
            success: false,
            error: `تعذّر قراءة التظليلات من المصحف: ${err?.message || 'خطأ غير معروف'}`,
            sourcePdfPath: pdfPath,
            markers: [],
            unmatchedClips: session.clips || [],
            unmatchedNewAnnotations: [],
            sections: [],
            allPdfPages: [],
            suggestedPages: [1],
        };
    }
});

ipcMain.handle('session:render-pages', async (_event, { sourcePdfPath, pageNumbers, scale, recolorAnnotations }) => {
    try {
        let pdfBytes = null;
        if (Array.isArray(recolorAnnotations) && recolorAnnotations.length > 0 && sourcePdfPath && fs.existsSync(sourcePdfPath)) {
            pdfBytes = await recolorAnnotationsToGreenInPdfBytes(fs.readFileSync(sourcePdfPath), recolorAnnotations);
        }
        const images = await renderPdfPagesToImages({
            BrowserWindow,
            pdfPath: sourcePdfPath,
            pdfBytes,
            pageNumbers,
            scale: scale || 1.55,
        });
        return { success: true, images };
    } catch (err) {
        return { success: false, error: err?.message || 'تعذّر عرض صفحات المصحف.', images: {} };
    }
});

ipcMain.handle('session:clip-data-url', (_event, { sessionKey, fileName }) => {
    return readClipAudioDataUrl(sessionKey, fileName);
});

ipcMain.handle('session:export', async (_event, { sessionKey, sourcePdfPath, mode, language = 'ar', autoSave = true }) => {
    const session = (sessionKey ? loadSession(sessionKey) : null) || loadOrCreateSession({});
    const pdfPath = sourcePdfPath || session.sourcePdfPath;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
        return { success: false, error: 'ملف PDF الخاص بالطالب غير محدد أو غير موجود.' };
    }

    if (autoSave) {
        await triggerAutoSavePdfViewer(pdfPath, session.lastRecordedAt);
    }
    const readablePdfPath = resolveLatestPdfCopyForReading(pdfPath);
    const rawPdfBytes = fs.readFileSync(readablePdfPath);
    const annotations = await extractPdfAnnotations(rawPdfBytes);
    const { markers, unmatchedClips, unmatchedNewAnnotations } = matchClipsToAnnotations(session.clips || [], annotations, {
        sessionStartedAt: session.startedAt || 0,
    });

    if ((!session.clips || session.clips.length === 0) && (!unmatchedNewAnnotations || unmatchedNewAnnotations.length === 0)) {
        return { success: false, error: 'لا توجد أي تسجيلات صوتية أو تظليلات جديدة في الجلسة الحالية.' };
    }

    if ((session.clips || []).length > 0 && markers.length === 0) {
        return {
            success: false,
            needsManualReview: true,
            unmatchedClips,
            error: 'تعذّر مطابقة التسجيلات مع تظليل جديد في الملف. يرجى حفظ الملف أو تثبيت مواضع الصوت يدوياً.',
        };
    }

    const { sections, allPdfPages } = mergeReportAndAudioSections({
        reportSections: [],
        markers,
        unmatchedNewAnnotations,
    });
    const recoloredBytes = await recolorAnnotationsToGreenInPdfBytes(rawPdfBytes, unmatchedNewAnnotations);
    const renderedImages = await renderPdfPagesToImages({
        BrowserWindow,
        pdfPath: readablePdfPath,
        pdfBytes: recoloredBytes,
        pageNumbers: allPdfPages,
        scale: 1.55,
    });

    const enrichedSections = sections.map(sec => ({
        ...sec,
        pages: sec.pages.map(p => ({
            pdfPage: p.pdfPage,
            imageDataUrl: renderedImages[String(p.pdfPage)]?.imageDataUrl || '',
            markers: p.markers.map(m => ({
                id: m.clipId,
                xPercent: m.xPercent,
                yPercent: m.yPercent,
                durationMs: m.durationMs || 0,
                audioDataUrl: readClipAudioDataUrl(sessionKey, m.audioFileName),
            })),
        })),
    }));

    if (mode === 'html') {
        const html = buildInteractiveHtml({
            studentName: session.studentName,
            dateStr: session.dateStr,
            language,
            sections: enrichedSections,
        });
        const saved = saveInteractiveHtmlFile({
            outputDir: OUTPUT_HTML_DIR,
            studentName: session.studentName,
            dateStr: session.dateStr,
            html,
            maxFilesToKeep: process.platform === 'darwin' ? 3 : null,
        });
        await copyFileToOsClipboard(saved.filePath);
        return {
            success: true,
            mode: 'html',
            filePath: saved.filePath,
            fileName: saved.fileName,
            unmatchedCount: unmatchedClips.length,
        };
    }

    const published = await publishAudioSessionToCloud({
        studentId: session.studentId || '',
        studentName: session.studentName,
        dateStr: session.dateStr,
        language,
        sections: enrichedSections,
    });
    clipboard.writeText(published.url);
    return {
        success: true,
        mode: 'web_link',
        url: published.url,
        sessionId: published.sessionId,
        unmatchedCount: unmatchedClips.length,
    };
});

ipcMain.handle('hud:native-edit', (event, action) => {
    if (action === 'undo') event.sender.undo();
    else if (action === 'redo') event.sender.redo();
    return { ok: true };
});

ipcMain.handle('hud:open-output-folder', async () => {
    fs.mkdirSync(OUTPUT_HTML_DIR, { recursive: true });
    await shell.openPath(OUTPUT_HTML_DIR);
    return { ok: true };
});
