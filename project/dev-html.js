const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.HTML_DEV_PORT || 5189);
const HOST = '127.0.0.1';
const BASE_URL = `http://localhost:${PORT}`;
const CORE_DIR = path.join(__dirname, 'core');
const WEB_APP_HTML_PATH = 'C:\\My App\\Quran Classes Tracker\\student-web-app\\index.html';
const FIREBASE_BASE_URL = 'https://quran-classes-tracker-default-rtdb.firebaseio.com';
const ELECTRON_EXE = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const NO_OPEN = process.argv.includes('--no-open');

const sseClients = new Set();
const cloudSessionCache = new Map();
const localRenderCache = new Map();
let cachedIndexList = null;
let cachedIndexAt = 0;
let lastKnownNewestCloudId = '';

function parseSessionIdTimestamp(sessionId) {
  const parts = String(sessionId || '').split('_');
  const tail = parts[parts.length - 1] || '';
  const ts = parseInt(tail, 36);
  return Number.isFinite(ts) ? ts : 0;
}

function parseSessionIdMeta(sessionId) {
  const parts = String(sessionId || '').split('_');
  const studentKey = parts[0] || '';
  const datePart = parts.find(p => /^\d{4}-\d{2}-\d{2}$/.test(p)) || '';
  const ts = parseSessionIdTimestamp(sessionId);
  return { id: sessionId, studentKey, dateStr: datePart, createdAt: ts };
}

function fetchJson(urlString, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlString, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout loading real session')));
    req.on('error', reject);
  });
}

function loadSessionStoreFresh() {
  const storePath = path.join(CORE_DIR, 'session-store.js');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(CORE_DIR + path.sep) || key === CORE_DIR) {
      delete require.cache[key];
    }
  }
  return require(storePath);
}

function loadLocalStudentNameMap() {
  try {
    const store = loadSessionStoreFresh();
    const students = typeof store.getQuranTrackerStudents === 'function'
      ? store.getQuranTrackerStudents()
      : [];
    const map = new Map();
    for (const s of students) {
      if (s && s.id && s.name) {
        map.set(String(s.id).toLowerCase(), s.name);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function listRecentCloudSessions(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedIndexList && (now - cachedIndexAt) < 12000) {
    return cachedIndexList;
  }
  const shallow = await fetchJson(`${FIREBASE_BASE_URL}/audioMushafSessions.json?shallow=true`, 10000);
  const keys = shallow && typeof shallow === 'object' ? Object.keys(shallow) : [];
  const nameMap = loadLocalStudentNameMap();
  const items = keys
    .map(parseSessionIdMeta)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 14)
    .map(item => {
      const knownName = nameMap.get(String(item.studentKey).toLowerCase());
      const cached = cloudSessionCache.get(item.id);
      const displayName = cached?.studentName || knownName || item.studentKey;
      const timeLabel = item.createdAt
        ? new Date(item.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
        : '';
      return {
        ...item,
        label: [displayName, item.dateStr, timeLabel].filter(Boolean).join(' • '),
      };
    });
  if (items[0]?.id) lastKnownNewestCloudId = items[0].id;
  cachedIndexList = items;
  cachedIndexAt = now;
  return items;
}

async function getCloudSessionData(requestedId = '', forceRefresh = false) {
  if (forceRefresh) {
    cloudSessionCache.clear();
    cachedIndexList = null;
  }
  const list = await listRecentCloudSessions(forceRefresh);
  if (list.length === 0) return { session: null, sessionId: '', list: [] };
  const targetId = requestedId && list.some(x => x.id === requestedId)
    ? requestedId
    : list[0].id;

  let data = !forceRefresh ? cloudSessionCache.get(targetId) : null;
  if (!data) {
    data = await fetchJson(`${FIREBASE_BASE_URL}/audioMushafSessions/${encodeURIComponent(targetId)}.json`, 20000);
    if (data && typeof data === 'object') {
      cloudSessionCache.set(targetId, data);
      const match = list.find(x => x.id === targetId);
      if (match && data.studentName) {
        const timeLabel = match.createdAt
          ? new Date(match.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
          : '';
        match.label = [data.studentName, data.dateStr || match.dateStr, timeLabel].filter(Boolean).join(' • ');
      }
    }
  }
  return { session: data || null, sessionId: targetId, list };
}

function listLocalPdfSessions() {
  const store = loadSessionStoreFresh();
  const rootDir = store.SESSIONS_ROOT_DIR;
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const entries = [];
  for (const d of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const metaPath = path.join(rootDir, d.name, 'session.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!meta?.sourcePdfPath || !fs.existsSync(meta.sourcePdfPath)) continue;
      const st = fs.statSync(metaPath);
      const clipsCount = Array.isArray(meta.clips) ? meta.clips.length : 0;
      entries.push({
        id: meta.sessionKey || d.name,
        metaPath,
        studentName: meta.studentName || 'طالب',
        dateStr: meta.dateStr || '',
        clipsCount,
        sortScore: (clipsCount > 0 ? 1e14 : 0) + (meta.lastRecordedAt || st.mtimeMs || 0),
        label: `${meta.studentName || 'طالب'} • PDF محلي (${clipsCount} صوت)`,
      });
    } catch { /* skip broken */ }
  }
  entries.sort((a, b) => b.sortScore - a.sortScore);
  return entries.slice(0, 10);
}

async function runLiveLocalPdfWorker(sessionItem, forceRefresh = false) {
  if (!sessionItem) throw new Error('لا توجد جلسة محلية تحتوي على ملف PDF.');
  if (!forceRefresh && localRenderCache.has(sessionItem.id)) {
    return localRenderCache.get(sessionItem.id);
  }

  // Try to reuse report section specs (including verseSpan) from the matching student's cloud session
  let reportSections = [];
  try {
    const cloudList = await listRecentCloudSessions(false);
    const normTarget = String(sessionItem.studentName || '').trim().toLowerCase();
    const matchingCloud = cloudList.find(c => c.label.toLowerCase().includes(normTarget));
    if (matchingCloud) {
      const cloudRes = await getCloudSessionData(matchingCloud.id, false);
      if (Array.isArray(cloudRes?.session?.sections)) {
        reportSections = cloudRes.session.sections.map(sec => ({
          key: sec.key,
          group: sec.group,
          groupTitleAr: sec.groupTitleAr,
          groupTitleEn: sec.groupTitleEn,
          titleAr: sec.titleAr,
          titleEn: sec.titleEn,
          summaryAr: sec.summaryAr,
          summaryEn: sec.summaryEn,
          startPage: sec.startPage,
          endPage: sec.endPage,
          verseSpan: sec.verseSpan || null,
          pages: Array.isArray(sec.pages) ? sec.pages.map(p => ({ pdfPage: p.pdfPage })) : [],
        }));
      }
    }
  } catch { /* fallback cleanly to PDF annotations/page 1 */ }

  const tmpBase = path.join(os.tmpdir(), `dev_pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const outJsonPath = `${tmpBase}_out.json`;
  const sectionsJsonPath = `${tmpBase}_sec.json`;
  fs.writeFileSync(sectionsJsonPath, JSON.stringify(reportSections), 'utf8');

  try {
    await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      delete childEnv.VITE_DEV_SERVER_URL;
      const child = spawn(
        ELECTRON_EXE,
        [path.join(__dirname, 'dev-pdf-worker.js'), sessionItem.metaPath, outJsonPath, sectionsJsonPath],
        { cwd: __dirname, env: childEnv, windowsHide: true, stdio: 'ignore' }
      );
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0 && fs.existsSync(outJsonPath)) resolve();
        else reject(new Error(`تعذرت معالجة PDF محلياً (كود ${code})`));
      });
    });
    const rendered = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));
    if (rendered?.error) throw new Error(rendered.error);
    localRenderCache.set(sessionItem.id, rendered);
    return rendered;
  } finally {
    try { if (fs.existsSync(outJsonPath)) fs.unlinkSync(outJsonPath); } catch { /* ignore */ }
    try { if (fs.existsSync(sectionsJsonPath)) fs.unlinkSync(sectionsJsonPath); } catch { /* ignore */ }
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildFallbackSampleData() {
  return {
    studentName: 'معاينة احتياطية (غير متصل)',
    dateStr: new Date().toLocaleDateString('en-CA'),
    language: 'ar',
    sections: [
      {
        key: 'new',
        titleAr: 'الدرس القادم: الحفظ الجديد',
        titleEn: 'New Hifz',
        summaryAr: 'ص ٥٨٢',
        summaryEn: 'p. 582',
        pages: [{ pdfPage: 582, imageDataUrl: '', markers: [] }],
      },
    ],
  };
}

function loadPublisherFresh() {
  loadSessionStoreFresh();
  return require('./core/publisher');
}

function buildDevOverlaySnippet({ source, mode, langPref, sessionId, sessionsList, isRealData, clean }) {
  const reloadScript = `
<script>
(function() {
  var es = new EventSource('/events');
  es.onmessage = function(ev) {
    if (ev.data === 'reload') {
      location.reload();
    }
  };
})();
</script>`;
  if (clean) return reloadScript;

  const hasWebApp = fs.existsSync(WEB_APP_HTML_PATH);
  const nextSource = source === 'local' ? 'cloud' : 'local';
  const nextMode = mode === 'web' ? 'html' : 'web';
  const nextLang = langPref === 'ar' ? 'en' : langPref === 'en' ? 'auto' : 'ar';
  const langBtnLabel = langPref === 'ar' ? 'اللغة: عربي' : langPref === 'en' ? 'Lang: EN' : 'لغة الجلسة';

  const makeUrl = (patch = {}) => {
    const p = new URLSearchParams();
    const targetSource = patch.source ?? source;
    const targetMode = patch.mode ?? mode;
    const targetSession = patch.sessionId !== undefined ? patch.sessionId : (targetSource === source ? sessionId : '');
    const targetLang = patch.lang ?? langPref;
    const mushafId = targetSession || 'live_local';
    if (targetMode === 'web') p.set('mushaf', mushafId);
    p.set('source', targetSource);
    p.set('mode', targetMode);
    if (targetSession) p.set('session', targetSession);
    if (targetLang && targetLang !== 'auto') p.set('lang', targetLang);
    if (patch.refresh) p.set('refresh', '1');
    return `/?${p.toString()}`;
  };

  const optionsMarkup = sessionsList.map(item => (
    `<option value="${escapeHtml(item.id)}" ${item.id === sessionId ? 'selected' : ''}>${escapeHtml(item.label)}</option>`
  )).join('');

  return `${reloadScript}
<style>
  #html-dev-bar {
    position: fixed;
    bottom: 14px;
    left: 14px;
    z-index: 99999;
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
    max-width: calc(100vw - 28px);
    padding: 7px 11px;
    border-radius: 999px;
    background: rgba(2, 6, 23, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid ${source === 'local' ? 'rgba(167, 139, 250, 0.55)' : isRealData ? 'rgba(52, 211, 153, 0.45)' : 'rgba(251, 191, 36, 0.45)'};
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
    color: #e2e8f0;
    font-family: "Segoe UI", Tahoma, sans-serif;
    font-size: 12px;
    direction: rtl;
  }
  #html-dev-bar .dev-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: ${source === 'local' ? '#a78bfa' : isRealData ? '#10b981' : '#f59e0b'};
    box-shadow: 0 0 8px ${source === 'local' ? '#a78bfa' : isRealData ? '#10b981' : '#f59e0b'};
    flex-shrink: 0;
  }
  #html-dev-bar select {
    background: rgba(30, 41, 59, 0.9);
    color: #f8fafc;
    border: 1px solid rgba(255,255,255,0.16);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11px;
    font-family: inherit;
    max-width: 230px;
    cursor: pointer;
    outline: none;
  }
  #html-dev-bar a, #html-dev-bar button {
    appearance: none;
    border: 1px solid rgba(255,255,255,0.16);
    background: rgba(255,255,255,0.08);
    color: #f8fafc;
    text-decoration: none;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }
  #html-dev-bar a:hover, #html-dev-bar button:hover {
    background: rgba(16, 185, 129, 0.24);
    border-color: rgba(52, 211, 153, 0.55);
  }
  #html-dev-bar .mode-pill {
    background: rgba(56, 189, 248, 0.16);
    border-color: rgba(56, 189, 248, 0.45);
    color: #bae6fd;
  }
  #html-dev-bar .src-pill {
    background: ${source === 'local' ? 'rgba(139, 92, 246, 0.25)' : 'rgba(16, 185, 129, 0.16)'};
    border-color: ${source === 'local' ? 'rgba(167, 139, 250, 0.55)' : 'rgba(52, 211, 153, 0.45)'};
    color: ${source === 'local' ? '#ddd6fe' : '#a7f3d0'};
  }
</style>
<div id="html-dev-bar" title="معاينة فورية لبياناتك — تتحدث تلقائياً بدون نشر">
  <span class="dev-dot"></span>
  <a class="src-pill" href="${escapeHtml(makeUrl({ source: nextSource, sessionId: '' }))}" title="التبديل بين السحابة الحية ومعالجة PDF محلياً بدون نشر">
    ${source === 'local' ? 'توليد حي من PDF' : 'السحابة الحية'}
  </a>
  ${optionsMarkup ? `<select id="dev-session-select" aria-label="اختر جلسة حقيقية">${optionsMarkup}</select>` : ''}
  ${hasWebApp ? `<a class="mode-pill" href="${escapeHtml(makeUrl({ mode: nextMode }))}">${mode === 'web' ? 'واجهة: الرابط' : 'واجهة: HTML'}</a>` : ''}
  <a href="${escapeHtml(makeUrl({ lang: nextLang }))}">${escapeHtml(langBtnLabel)}</a>
  <a href="${escapeHtml(makeUrl({ refresh: true }))}" title="إعادة الجلب أو المعالجة الآن">🔄 تحديث</a>
  <button type="button" onclick="document.getElementById('html-dev-bar').remove()" title="إخفاء الشريط">✕</button>
</div>
<script>
(function() {
  var sel = document.getElementById('dev-session-select');
  if (sel) {
    sel.addEventListener('change', function() {
      var id = sel.value;
      var params = new URLSearchParams(window.location.search);
      params.set('session', id);
      params.set('source', ${JSON.stringify(source)});
      params.set('mode', ${JSON.stringify(mode)});
      if (${JSON.stringify(mode)} === 'web') params.set('mushaf', id);
      window.location.search = params.toString();
    });
  }
})();
</script>`;
}

function injectBeforeLastBodyClose(html, snippet) {
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return `${html}\n${snippet}`;
  return `${html.slice(0, idx)}${snippet}\n${html.slice(idx)}`;
}

function renderWebAppWithSession({ webHtml, source, langPref, overlay }) {
  let html = webHtml;
  const localUrlExpr = `'/local-session/' + encodeURIComponent(sessionId) + '.json?source=${encodeURIComponent(source)}&lang=${encodeURIComponent(langPref)}'`;
  html = html.replace(
    /(['"])https:\/\/quran-classes-tracker-default-rtdb\.firebaseio\.com\/audioMushafSessions\/\1\s*\+\s*encodeURIComponent\(sessionId\)\s*\+\s*(['"])\.json\2/,
    localUrlExpr
  );
  html = html.replace(
    /if\s*\(\s*'serviceWorker'\s+in\s+navigator\s*\)/,
    "if (false && 'serviceWorker' in navigator)"
  );
  return injectBeforeLastBodyClose(html, overlay);
}

async function resolveSessionForRequest({ source, requestedId, forceRefresh }) {
  if (source === 'local') {
    const list = listLocalPdfSessions();
    const target = (requestedId && list.find(x => x.id === requestedId)) || list[0] || null;
    if (!target) return { session: null, sessionId: '', list: [], isRealData: false };
    const session = await runLiveLocalPdfWorker(target, forceRefresh);
    return { session, sessionId: target.id, list, isRealData: Boolean(session) };
  }
  try {
    const res = await getCloudSessionData(requestedId, forceRefresh);
    return { ...res, isRealData: Boolean(res.session) };
  } catch (err) {
    console.warn('تعذر جلب الجلسة السحابية، سيتم استخدام نموذج احتياطي:', err.message);
    return { session: null, sessionId: '', list: [], isRealData: false };
  }
}

async function renderPreviewPage(urlObj) {
  const hasWebApp = fs.existsSync(WEB_APP_HTML_PATH);
  const source = urlObj.searchParams.get('source') === 'local' ? 'local' : 'cloud';
  const rawMode = urlObj.searchParams.get('mode');
  const mode = rawMode === 'html' ? 'html' : (hasWebApp ? 'web' : 'html');
  const langParam = urlObj.searchParams.get('lang');
  const langPref = langParam === 'ar' || langParam === 'en' ? langParam : 'auto';
  const clean = urlObj.searchParams.get('clean') === '1';
  const forceRefresh = urlObj.searchParams.get('refresh') === '1';
  const requestedId = urlObj.searchParams.get('session') || urlObj.searchParams.get('mushaf') || '';

  const { session, sessionId, list, isRealData } = await resolveSessionForRequest({
    source,
    requestedId: requestedId === 'live_local' ? '' : requestedId,
    forceRefresh,
  });

  const sessionData = session || buildFallbackSampleData();
  const effectiveLang = langPref === 'auto' ? (sessionData.language === 'en' ? 'en' : 'ar') : langPref;

  const overlay = buildDevOverlaySnippet({
    source,
    mode,
    langPref,
    sessionId,
    sessionsList: list,
    isRealData,
    clean,
  });

  if (mode === 'web' && hasWebApp && isRealData) {
    const webHtml = fs.readFileSync(WEB_APP_HTML_PATH, 'utf8');
    return {
      html: renderWebAppWithSession({ webHtml, source, langPref, overlay }),
      redirectToMushaf: !urlObj.searchParams.get('mushaf')
        ? `/?mushaf=${encodeURIComponent(sessionId || 'live_local')}&source=${source}&mode=web${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}${langPref !== 'auto' ? `&lang=${langPref}` : ''}`
        : null,
    };
  }

  const { buildInteractiveHtml } = loadPublisherFresh();
  const rawHtml = buildInteractiveHtml({
    studentName: sessionData.studentName || 'طالب',
    dateStr: sessionData.dateStr || new Date().toLocaleDateString('en-CA'),
    language: effectiveLang,
    sections: Array.isArray(sessionData.sections) ? sessionData.sections : [],
  });

  return { html: injectBeforeLastBodyClose(rawHtml, overlay), redirectToMushaf: null };
}

function renderErrorHtml(err) {
  const msg = escapeHtml(err?.stack || err?.message || String(err));
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<title>خطأ في معاينة HTML</title>
<style>
  body { background: #0f172a; color: #f8fafc; font-family: "Segoe UI", Tahoma, sans-serif; padding: 32px; }
  .box { max-width: 780px; margin: 0 auto; background: rgba(127, 29, 29, 0.35); border: 1px solid #ef4444; border-radius: 16px; padding: 20px; }
  h1 { color: #fca5a5; font-size: 1.2rem; margin-bottom: 12px; }
  pre { direction: ltr; text-align: left; white-space: pre-wrap; word-break: break-word; background: rgba(0,0,0,0.4); padding: 14px; border-radius: 10px; font-size: 13px; color: #fecaca; }
</style>
</head>
<body>
  <div class="box">
    <h1>حدث خطأ مؤقت أثناء تجهيز المعاينة — سيتم التحديث تلقائياً فور الإصلاح:</h1>
    <pre>${msg}</pre>
  </div>
  <script>
    new EventSource('/events').onmessage = function(ev) {
      if (ev.data === 'reload') location.reload();
    };
  </script>
</body>
</html>`;
}

function openBrowser(targetUrl) {
  if (NO_OPEN) return;
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', targetUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [targetUrl], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    const child = spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

function notifyReload() {
  for (const res of sseClients) {
    try {
      res.write('data: reload\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', BASE_URL);

  if (urlObj.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (urlObj.pathname.startsWith('/local-session/') && urlObj.pathname.endsWith('.json')) {
    try {
      const id = decodeURIComponent(urlObj.pathname.slice('/local-session/'.length, -'.json'.length));
      const source = urlObj.searchParams.get('source') === 'local' ? 'local' : 'cloud';
      const { session } = await resolveSessionForRequest({
        source,
        requestedId: id === 'live_local' ? '' : id,
        forceRefresh: false,
      });
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('null');
        return;
      }
      const langParam = urlObj.searchParams.get('lang');
      const payload = (langParam === 'ar' || langParam === 'en')
        ? { ...session, language: langParam }
        : session;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    try {
      const { html, redirectToMushaf } = await renderPreviewPage(urlObj);
      if (redirectToMushaf) {
        res.writeHead(302, { Location: redirectToMushaf });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(renderErrorHtml(err));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log(`معاينة واجهة HTML تعمل بالفعل على ${BASE_URL}`);
    openBrowser(BASE_URL);
    process.exit(0);
    return;
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`معاينة المصحح الصوتي المباشرة تعمل الآن على: ${BASE_URL}`);

  const watchers = [];
  let reloadTimer = null;
  const triggerReload = (label, clearLocal = false) => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (clearLocal) localRenderCache.clear();
      console.log(`[تحديث تلقائي] ${label}`);
      notifyReload();
    }, 150);
  };

  watchers.push(fs.watch(CORE_DIR, (_ev, fileName) => {
    if (fileName && /\.(js|css|html)$/i.test(String(fileName))) {
      triggerReload(`core/${fileName}`, true);
    }
  }));

  if (fs.existsSync(WEB_APP_HTML_PATH)) {
    watchers.push(fs.watch(path.dirname(WEB_APP_HTML_PATH), (_ev, fileName) => {
      if (fileName && String(fileName).toLowerCase() === 'index.html') {
        triggerReload('student-web-app/index.html', false);
      }
    }));
  }

  // Watch local audio sessions directory so newly saved recordings auto-refresh local PDF mode
  try {
    const store = loadSessionStoreFresh();
    if (store.SESSIONS_ROOT_DIR && fs.existsSync(store.SESSIONS_ROOT_DIR)) {
      watchers.push(fs.watch(store.SESSIONS_ROOT_DIR, { recursive: true }, (_ev, fileName) => {
        if (fileName && /session\.json$/i.test(String(fileName))) {
          triggerReload('local-session update', true);
        }
      }));
    }
  } catch { /* ignore recursive watch fallback */ }

  // Auto-detect new published cloud sessions only while a preview tab is open
  const cloudPoll = setInterval(async () => {
    if (sseClients.size === 0) return;
    try {
      const prevNewest = lastKnownNewestCloudId;
      const list = await listRecentCloudSessions(true);
      if (list[0]?.id && prevNewest && list[0].id !== prevNewest) {
        console.log(`[جلسة جديدة] تم رصد ${list[0].label}`);
        notifyReload();
      }
    } catch { /* ignore transient network blip */ }
  }, 5000);

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(cloudPoll);
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  openBrowser(BASE_URL);
});
