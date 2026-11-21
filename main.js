const { app, BrowserWindow, ipcMain, globalShortcut, screen, clipboard, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { extractPdfAnnotations, matchClipsToAnnotations, mergeReportAndAudioSections } = require('./core/annotation-matcher');
const {
    SESSIONS_ROOT_DIR,
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
    matchWindowTitleToStudent,
} = require('./core/session-store');
const {
    renderPdfPagesToImages,
    buildInteractiveHtml,
    saveInteractiveHtmlFile,
    publishAudioSessionToCloud,
} = require('./core/publisher');

let mainWindow = null;
let lastKnownDetectedPdf = '';
let preReviewBounds = null;
let moveSaveTimer = null;

function clampHudCoordinates(x, y, width, height) {
    const primary = screen.getPrimaryDisplay().workArea;
    const rawX = Number.isFinite(Number(x)) ? Number(x) : primary.x + primary.width - width - 10;
    const rawY = Number.isFinite(Number(y)) ? Number(y) : primary.y + Math.round(primary.height * 0.28);
    const display = screen.getDisplayNearestPoint({ x: Math.round(rawX), y: Math.round(rawY) });
    const area = display?.workArea || primary;
    const clampedX = Math.max(area.x + 8, Math.min(Math.round(rawX), area.x + area.width - width - 8));
    const clampedY = Math.max(area.y + 8, Math.min(Math.round(rawY), area.y + area.height - height - 8));
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
        const psScript = [
            'Add-Type @"',
            'using System;',
            'using System.Text;',
            'using System.Runtime.InteropServices;',
            'public class WinPoll {',
            '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
            '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
            '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
            '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
            '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
            '}',
            '"@',
            '$fg = [WinPoll]::GetForegroundWindow()',
            '$sbFg = New-Object System.Text.StringBuilder 512',
            '[WinPoll]::GetWindowText($fg, $sbFg, 512) | Out-Null',
            '$fgTitle = $sbFg.ToString()',
            'if ($fgTitle -match "Xodo|Acrobat") { Write-Output ("FG|" + $fgTitle); exit 0 }',
            '$script:found = ""',
            '$cb = [WinPoll+EnumWindowsProc]{ param($h,$l) if ([WinPoll]::IsWindowVisible($h)) { $sb = New-Object System.Text.StringBuilder 512; [WinPoll]::GetWindowText($h, $sb, 512) | Out-Null; $t = $sb.ToString(); if ($t -match "Xodo" -and -not $script:found) { $script:found = "BG|" + $t } }; return $true }',
            '[WinPoll]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null',
            'if ($script:found) { Write-Output $script:found }',
        ].join('\n');
        const { stdout } = await runExec('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 4000 });
        const line = stdout.trim().split(/\r?\n/).find(Boolean) || '';
        if (!line) return null;
        const idx = line.indexOf('|');
        return { foreground: line.startsWith('FG|'), title: line.slice(idx + 1).trim(), filePath: '' };
    }

    if (process.platform === 'darwin') {
        const script = [
            'tell application "System Events"',
            '  set frontApp to name of first application process whose frontmost is true',
            '  if frontApp contains "Acrobat" or (exists process "Adobe Acrobat") then',
            '    try',
            '      tell application "Adobe Acrobat"',
            '        if (count of documents) > 0 then',
            '          set d to front document',
            '          set p to POSIX path of (file alias of d)',
            '          set n to name of d',
            '          return frontApp & "|" & n & "|" & p',
            '        end if',
            '      end tell',
            '    end try',
            '  end if',
            'end tell',
            'return ""',
        ].join('\n');
        const { stdout } = await runExec('osascript', ['-e', script], { timeout: 4000 });
        const line = stdout.trim();
        if (!line) return null;
        const [frontApp, name, filePath] = line.split('|');
        return {
            foreground: /Acrobat/i.test(frontApp || ''),
            title: (name || '').trim(),
            filePath: (filePath || '').trim(),
        };
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
        const script = [
            'tell application "Adobe Acrobat"',
            '  if (count of documents) > 0 then save front document',
            'end tell',
        ].join('\n');
        await runExec('osascript', ['-e', script], { timeout: 5000 });
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
    const initW = initialMode === 'pill' ? 78 : 410;
    const initH = initialMode === 'pill' ? 112 : 172;
    const pos = clampHudCoordinates(savedHud?.x, savedHud?.y, initW, initH);

    mainWindow = new BrowserWindow({
        width: initW,
        height: initH,
        x: pos.x,
        y: pos.y,
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
            additionalArguments: [`--hud-mode=${initialMode}`],
        },
    });
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform === 'darwin') mainWindow.setAlwaysOnTop(true, 'floating');
    else mainWindow.setAlwaysOnTop(true, 'screen-saver');

    const persistCurrentBounds = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const b = mainWindow.getBounds();
        if (b.width > 460) return; // Never overwrite docked bar/pill position with centered Review modal
        saveHudState({ x: b.x, y: b.y, mode: b.width <= 120 ? 'pill' : 'bar' });
    };

    mainWindow.on('moved', () => {
        if (moveSaveTimer) clearTimeout(moveSaveTimer);
        moveSaveTimer = setTimeout(persistCurrentBounds, 220);
    });
    mainWindow.on('close', () => {
        if (moveSaveTimer) {
            clearTimeout(moveSaveTimer);
            moveSaveTimer = null;
        }
        persistCurrentBounds();
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
        mainWindow.loadURL(devUrl);
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }
}

function registerShortcuts() {
    const bindings = [
        ['F17', 'toggle-record'],
        ['F22', 'undo-last'],
        ['F21', 'redo-last'],
        ['F20', 'finish-export'],
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

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
    app.whenReady().then(() => {
        fs.mkdirSync(SESSIONS_ROOT_DIR, { recursive: true });
        createWindow();
        registerShortcuts();
    });
}

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// === IPC Handlers ===

ipcMain.handle('hud:resize', (_event, { width, height, anchorSide }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const area = display.workArea;
    const nextW = Math.max(68, Math.min(Number(width) || 78, area.width - 20));
    const nextH = Math.max(88, Math.min(Number(height) || 112, area.height - 20));

    if (anchorSide === 'center') {
        if (bounds.width <= 460) preReviewBounds = { ...bounds };
        const centerX = Math.max(area.x + 8, Math.round(area.x + (area.width - nextW) / 2));
        const centerY = Math.max(area.y + 8, Math.round(area.y + (area.height - nextH) / 2));
        mainWindow.setBounds({ x: centerX, y: centerY, width: Math.round(nextW), height: Math.round(nextH) });
        return { ok: true };
    }

    if (preReviewBounds) {
        const restoredPos = clampHudCoordinates(preReviewBounds.x, preReviewBounds.y, Math.round(nextW), Math.round(nextH));
        preReviewBounds = null;
        mainWindow.setBounds({ x: restoredPos.x, y: restoredPos.y, width: Math.round(nextW), height: Math.round(nextH) });
        return { ok: true };
    }

    if (bounds.width === Math.round(nextW) && bounds.height === Math.round(nextH)) {
        return { ok: true };
    }

    let nextX = bounds.x;
    if (bounds.x + bounds.width / 2 > area.x + area.width / 2) {
        nextX = bounds.x + bounds.width - nextW;
    }
    const clamped = clampHudCoordinates(nextX, bounds.y, Math.round(nextW), Math.round(nextH));
    mainWindow.setBounds({ x: clamped.x, y: clamped.y, width: Math.round(nextW), height: Math.round(nextH) });
    saveHudState({ x: clamped.x, y: clamped.y, mode: nextW <= 120 ? 'pill' : 'bar' });
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
        saveHudState({ x: Math.round(nextX), y: Math.round(nextY), mode: bounds.width <= 120 ? 'pill' : 'bar' });
    }
    return { ok: true, side: snapRight ? 'right' : 'left' };
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
        const bytes = fs.readFileSync(pdfPath);
        const annotations = await extractPdfAnnotations(bytes);
        const { markers, unmatchedClips } = matchClipsToAnnotations(session.clips || [], annotations, {
            sessionStartedAt: session.startedAt || 0,
        });
        const { sections, allPdfPages } = mergeReportAndAudioSections({
            reportSections: [],
            markers,
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
            sourcePdfPath: pdfPath,
            markers,
            unmatchedClips,
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
            sections: [],
            allPdfPages: [],
            suggestedPages: [1],
        };
    }
});

ipcMain.handle('session:render-pages', async (_event, { sourcePdfPath, pageNumbers, scale }) => {
    try {
        const images = await renderPdfPagesToImages({
            BrowserWindow,
            pdfPath: sourcePdfPath,
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
    if (!session.clips || session.clips.length === 0) {
        return { success: false, error: 'لا توجد أي تسجيلات صوتية في الجلسة الحالية.' };
    }

    if (autoSave) {
        await triggerAutoSavePdfViewer(pdfPath, session.lastRecordedAt);
    }
    const annotations = await extractPdfAnnotations(fs.readFileSync(pdfPath));
    const { markers, unmatchedClips } = matchClipsToAnnotations(session.clips, annotations, {
        sessionStartedAt: session.startedAt || 0,
    });

    if (markers.length === 0) {
        return {
            success: false,
            needsManualReview: true,
            unmatchedClips,
            error: 'تعذّر مطابقة التسجيلات مع تظليل جديد في الملف. يرجى حفظ الملف أو تثبيت مواضع الصوت يدوياً.',
        };
    }

    const { sections, allPdfPages } = mergeReportAndAudioSections({ reportSections: [], markers });
    const renderedImages = await renderPdfPagesToImages({
        BrowserWindow,
        pdfPath,
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

ipcMain.handle('hud:open-output-folder', async () => {
    fs.mkdirSync(OUTPUT_HTML_DIR, { recursive: true });
    await shell.openPath(OUTPUT_HTML_DIR);
    return { ok: true };
});
