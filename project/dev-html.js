const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.HTML_DEV_PORT || 5189);
const HOST = '127.0.0.1';
const BASE_URL = `http://localhost:${PORT}`;
const CORE_DIR = path.join(__dirname, 'core');
const NO_OPEN = process.argv.includes('--no-open');

const sseClients = new Set();

function createSoftChimeWavDataUrl(freqHz = 523.25, durationSec = 0.45) {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.02);
    const decay = Math.exp(-5.5 * t);
    const sample = Math.sin(2 * Math.PI * freqHz * t) * 0.28 * attack * decay;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createMockMushafPageDataUrl({ pageNum, surahTitle, verses, highlights = [] }) {
  const width = 760;
  const height = 1146;
  const lineStartY = 195;
  const lineGap = 58;

  const linesMarkup = verses.map((lineText, idx) => {
    const y = lineStartY + idx * lineGap;
    return `
      <line x1="88" y1="${y + 14}" x2="${width - 88}" y2="${y + 14}" stroke="#e7dec4" stroke-width="1" />
      <text x="${width / 2}" y="${y}" text-anchor="middle" direction="rtl" font-family="Amiri, Traditional Arabic, Tahoma, serif" font-size="25" fill="#1e293b">${escapeXml(lineText)}</text>
    `;
  }).join('');

  const highlightsMarkup = highlights.map(h => {
    const hx = (h.xPercent / 100) * width - 58;
    const hy = (h.yPercent / 100) * height - 10;
    return `<rect x="${Math.max(76, hx)}" y="${Math.max(70, hy)}" width="116" height="32" rx="6" fill="#22c55e" fill-opacity="0.28" stroke="#16a34a" stroke-opacity="0.55" stroke-width="1.5" />`;
  }).join('');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#fdfaf0" />
  <rect x="44" y="42" width="${width - 88}" height="${height - 84}" rx="12" fill="none" stroke="#aba000" stroke-width="4.5" />
  <rect x="54" y="52" width="${width - 108}" height="${height - 104}" rx="8" fill="none" stroke="#d4c76a" stroke-width="1.5" />
  <rect x="74" y="76" width="${width - 148}" height="56" rx="10" fill="#f3ebd3" stroke="#aba000" stroke-width="2" />
  <text x="${width / 2}" y="112" text-anchor="middle" direction="rtl" font-family="Amiri, Traditional Arabic, Tahoma, serif" font-size="27" font-weight="bold" fill="#5b4d12">${escapeXml(surahTitle)}</text>
  ${highlightsMarkup}
  ${linesMarkup}
  <text x="${width / 2}" y="${height - 64}" text-anchor="middle" font-family="Tahoma, sans-serif" font-size="18" fill="#7c6b22">${escapeXml(String(pageNum))}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

const SAMPLE_VERSES_A = [
  'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
  'سَبِّحِ اسْمَ رَبِّكَ الْأَعْلَى ۝١ الَّذِي خَلَقَ فَسَوَّىٰ ۝٢',
  'وَالَّذِي قَدَّرَ فَهَدَىٰ ۝٣ وَالَّذِي أَخْرَجَ الْمَرْعَىٰ ۝٤',
  'فَجَعَلَهُ غُثَاءً أَحْوَىٰ ۝٥ سَنُقْرِئُكَ فَلَا تَنسَىٰ ۝٦',
  'إِلَّا مَا شَاءَ اللَّهُ ۚ إِنَّهُ يَعْلَمُ الْجَهْرَ وَمَا يَخْفَىٰ ۝٧',
  'وَنُيَسِّرُكَ لِلْيُسْرَىٰ ۝٨ فَذَكِّرْ إِن نَّفَعَتِ الذِّكْرَىٰ ۝٩',
  'سَيَذَّكَّرُ مَن يَخْشَىٰ ۝١٠ وَيَتَجَنَّبُهَا الْأَشْقَى ۝١١',
  'الَّذِي يَصْلَى النَّارَ الْكُبْرَىٰ ۝١٢ ثُمَّ لَا يَمُوتُ فِيهَا وَلَا يَحْيَىٰ ۝١٣',
  'قَدْ أَفْلَحَ مَن تَزَكَّىٰ ۝١٤ وَذَكَرَ اسْمَ رَبِّهِ فَصَلَّىٰ ۝١٥',
  'بَلْ تُؤْثِرُونَ الْحَيَاةَ الدُّنْيَا ۝١٦ وَالْآخِرَةُ خَيْرٌ وَأَبْقَىٰ ۝١٧',
  'إِنَّ هَٰذَا لَفِي الصُّحُفِ الْأُولَىٰ ۝١٨ صُحُفِ إِبْرَاهِيمَ وَمُوسَىٰ ۝١٩',
];

const SAMPLE_VERSES_B = [
  'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
  'هَلْ أَتَاكَ حَدِيثُ الْغَاشِيَةِ ۝١ وُجُوهٌ يَوْمَئِذٍ خَاشِعَةٌ ۝٢',
  'عَامِلَةٌ نَّاصِبَةٌ ۝٣ تَصْلَىٰ نَارًا حَامِيَةً ۝٤',
  'تُسْقَىٰ مِنْ عَيْنٍ آنِيَةٍ ۝٥ لَّيْسَ لَهُمْ طَعَامٌ إِلَّا مِن ضَرِيعٍ ۝٦',
  'لَّا يُسْمِنُ وَلَا يُغْنِي مِن جُوعٍ ۝٧ وُجُوهٌ يَوْمَئِذٍ نَّاعِمَةٌ ۝٨',
  'لِّسَعْيِهَا رَاضِيَةٌ ۝٩ فِي جَنَّةٍ عَالِيَةٍ ۝١٠ لَّا تَسْمَعُ فِيهَا لَاغِيَةً ۝١١',
  'فِيهَا عَيْنٌ جَارِيَةٌ ۝١٢ فِيهَا سُرُرٌ مَّرْفُوعَةٌ ۝١٣',
  'وَأَكْوَابٌ مَّوْضُوعَةٌ ۝١٤ وَنَمَارِقُ مَصْفُوفَةٌ ۝١٥',
  'وَزَرَابِيُّ مَبْثُوثَةٌ ۝١٦ أَفَلَا يَنظُرُونَ إِلَى الْإِبِلِ كَيْفَ خُلِقَتْ ۝١٧',
];

function buildSampleData(layout = 'grouped') {
  const audio1 = createSoftChimeWavDataUrl(523.25, 0.45);
  const audio2 = createSoftChimeWavDataUrl(659.25, 0.45);
  const audio3 = createSoftChimeWavDataUrl(783.99, 0.45);

  const page582Markers = [
    { id: 'dev_clip_1', xPercent: 62, yPercent: 27, durationMs: 3200, audioDataUrl: audio1 },
    { id: 'dev_clip_2', xPercent: 34, yPercent: 48, durationMs: 4100, audioDataUrl: audio2 },
  ];
  const page583Markers = [
    { id: 'dev_clip_3', xPercent: 52, yPercent: 38, durationMs: 2800, audioDataUrl: audio3 },
  ];
  const page584Markers = [
    { id: 'dev_clip_4', xPercent: 44, yPercent: 32, durationMs: 3600, audioDataUrl: audio1 },
    { id: 'dev_clip_5', xPercent: 66, yPercent: 56, durationMs: 2500, audioDataUrl: audio2 },
  ];

  const page582Img = createMockMushafPageDataUrl({
    pageNum: 582,
    surahTitle: 'سُورَةُ الأَعْلَى',
    verses: SAMPLE_VERSES_A,
    highlights: page582Markers,
  });
  const page583Img = createMockMushafPageDataUrl({
    pageNum: 583,
    surahTitle: 'سُورَةُ الغَاشِيَةِ',
    verses: SAMPLE_VERSES_B,
    highlights: page583Markers,
  });
  const page584Img = createMockMushafPageDataUrl({
    pageNum: 584,
    surahTitle: 'سُورَةُ الفَجْرِ',
    verses: SAMPLE_VERSES_A,
    highlights: page584Markers,
  });

  if (layout === 'simple') {
    return {
      studentName: 'أحمد محمد (معاينة)',
      dateStr: new Date().toLocaleDateString('en-CA'),
      sections: [
        {
          key: 'corrections',
          titleAr: 'تصحيحات الحصة',
          titleEn: 'Lesson Corrections',
          summaryAr: 'ص ٥٨٢ – ٥٨٣',
          summaryEn: 'p. 582 – 583',
          pages: [
            { pdfPage: 582, imageDataUrl: page582Img, markers: page582Markers },
            { pdfPage: 583, imageDataUrl: page583Img, markers: page583Markers },
          ],
        },
      ],
    };
  }

  return {
    studentName: 'أحمد محمد (معاينة)',
    dateStr: new Date().toLocaleDateString('en-CA'),
    sections: [
      {
        key: 'rev',
        group: 'reading',
        groupTitleAr: 'الدرس الحالي',
        groupTitleEn: 'Current Lesson',
        titleAr: 'الدرس الحالي: المراجعة القريبة',
        titleEn: 'Near Revision',
        summaryAr: 'ص ٥٨٢ – ٥٨٣',
        summaryEn: 'p. 582 – 583',
        pages: [
          { pdfPage: 582, imageDataUrl: page582Img, markers: page582Markers },
          { pdfPage: 583, imageDataUrl: page583Img, markers: page583Markers },
        ],
      },
      {
        key: 'oldRev',
        group: 'reading',
        groupTitleAr: 'الدرس الحالي',
        groupTitleEn: 'Current Lesson',
        titleAr: 'الدرس الحالي: المراجعة القديمة',
        titleEn: 'Old Revision',
        summaryAr: 'ص ٥٨٤',
        summaryEn: 'p. 584',
        pages: [
          { pdfPage: 584, imageDataUrl: page584Img, markers: page584Markers.slice(0, 1) },
        ],
      },
      {
        key: 'new',
        group: 'homework',
        groupTitleAr: 'الدرس القادم',
        groupTitleEn: 'Next Lesson',
        titleAr: 'الدرس القادم: الحفظ الجديد',
        titleEn: 'New Hifz',
        summaryAr: 'ص ٥٨٤',
        summaryEn: 'p. 584',
        pages: [
          { pdfPage: 584, imageDataUrl: page584Img, markers: page584Markers },
        ],
      },
      {
        key: 'corrections',
        titleAr: 'تصحيحات إضافية من الحصة',
        titleEn: 'Additional Lesson Corrections',
        summaryAr: 'ص ٥٨٢',
        summaryEn: 'p. 582',
        pages: [
          { pdfPage: 582, imageDataUrl: page582Img, markers: page582Markers.slice(0, 1) },
        ],
      },
    ],
  };
}

function loadPublisherFresh() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(CORE_DIR + path.sep) || key === CORE_DIR) {
      delete require.cache[key];
    }
  }
  return require('./core/publisher');
}

function buildDevOverlaySnippet({ language, layout, clean }) {
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

  const toggleLang = language === 'en' ? 'ar' : 'en';
  const toggleLayout = layout === 'simple' ? 'grouped' : 'simple';

  return `${reloadScript}
<style>
  #html-dev-bar {
    position: fixed;
    bottom: 14px;
    left: 14px;
    z-index: 99999;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 11px;
    border-radius: 999px;
    background: rgba(2, 6, 23, 0.9);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(52, 211, 153, 0.4);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    color: #e2e8f0;
    font-family: "Segoe UI", Tahoma, sans-serif;
    font-size: 12px;
    direction: rtl;
  }
  #html-dev-bar .dev-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #10b981;
    box-shadow: 0 0 8px #10b981;
  }
  #html-dev-bar a, #html-dev-bar button {
    appearance: none;
    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(255,255,255,0.08);
    color: #f8fafc;
    text-decoration: none;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
  }
  #html-dev-bar a:hover, #html-dev-bar button:hover {
    background: rgba(16, 185, 129, 0.24);
    border-color: rgba(52, 211, 153, 0.55);
  }
</style>
<div id="html-dev-bar" title="معاينة مطور لملف HTML — تتحدث تلقائياً عند أي تعديل">
  <span class="dev-dot"></span>
  <span>وضع المطور</span>
  <a href="?lang=${toggleLang}&layout=${layout}">${language === 'en' ? 'عربي' : 'English'}</a>
  <a href="?lang=${language}&layout=${toggleLayout}">${layout === 'simple' ? 'أقسام متعددة' : 'قسم واحد'}</a>
  <button type="button" onclick="document.getElementById('html-dev-bar').remove()" title="إخفاء الشريط">✕</button>
</div>`;
}

function renderPreviewHtml(urlObj) {
  const language = urlObj.searchParams.get('lang') === 'en' ? 'en' : 'ar';
  const layout = urlObj.searchParams.get('layout') === 'simple' ? 'simple' : 'grouped';
  const clean = urlObj.searchParams.get('clean') === '1';

  const { buildInteractiveHtml } = loadPublisherFresh();
  const sample = buildSampleData(layout);
  const rawHtml = buildInteractiveHtml({
    studentName: sample.studentName,
    dateStr: sample.dateStr,
    language,
    sections: sample.sections,
  });

  const overlay = buildDevOverlaySnippet({ language, layout, clean });
  if (rawHtml.includes('</body>')) {
    return rawHtml.replace('</body>', `${overlay}\n</body>`);
  }
  return `${rawHtml}\n${overlay}`;
}

function renderErrorHtml(err) {
  const msg = escapeXml(err?.stack || err?.message || String(err));
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
    <h1>حدث خطأ مؤقت أثناء بناء واجهة HTML — سيتم التحديث تلقائياً فور الإصلاح:</h1>
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

const server = http.createServer((req, res) => {
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

  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    try {
      const html = renderPreviewHtml(urlObj);
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
  console.log(`معاينة واجهة HTML (وضع المطور) تعمل الآن على: ${BASE_URL}`);
  console.log('أي تعديل في core/publisher.js سيظهر مباشرة في المتصفح.');

  let reloadTimer = null;
  const watcher = fs.watch(CORE_DIR, (_eventType, fileName) => {
    if (!fileName || !/\.(js|css|html)$/i.test(String(fileName))) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      console.log(`[تحديث تلقائي] تم تعديل core/${fileName}`);
      notifyReload();
    }, 120);
  });

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
    try { watcher.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  openBrowser(BASE_URL);
});
