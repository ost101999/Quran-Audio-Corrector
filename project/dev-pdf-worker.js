const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const {
  extractPdfAnnotations,
  matchClipsToAnnotations,
  prepareCorrectionPdfForRendering,
  mergeReportAndAudioSections,
} = require('./core/annotation-matcher');
const {
  resolvePdfPagesForVerseSpan620,
  computePageCropForVerseSpan620,
  transformMarkerForCrop,
} = require('./core/mushaf-crop-data');
const {
  resolveLatestPdfCopyForReading,
  readClipAudioDataUrl,
} = require('./core/session-store');
const { renderPdfPagesToImages } = require('./core/publisher');

const [, , inputSessionPath, outJsonPath, reportSectionsPath] = process.argv;

function fallbackMapPages(startPage, endPage, pdfPageCount) {
  if (!Number.isInteger(pdfPageCount) || pdfPageCount < 1) return [];
  const lo = Math.max(1, Math.min(startPage || 1, endPage || 1));
  const hi = Math.min(604, Math.max(startPage || 1, endPage || 1));
  const pages = [];
  for (let p = lo; p <= hi; p++) {
    const base = pdfPageCount === 604 ? p : pdfPageCount === 605 ? p + 1 : (p <= 2 ? 2 : p + Math.max(0, pdfPageCount - 620));
    const clamped = Math.max(1, Math.min(base, pdfPageCount));
    if (pages[pages.length - 1] !== clamped) pages.push(clamped);
  }
  return pages;
}

app.whenReady().then(async () => {
  try {
    if (!inputSessionPath || !outJsonPath || !fs.existsSync(inputSessionPath)) {
      throw new Error('Missing local session metadata file.');
    }
    const session = JSON.parse(fs.readFileSync(inputSessionPath, 'utf8'));
    const pdfPath = session.sourcePdfPath;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      throw new Error('ملف PDF الخاص بهذه الجلسة غير موجود حالياً.');
    }

    let reportSections = [];
    if (reportSectionsPath && fs.existsSync(reportSectionsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(reportSectionsPath, 'utf8'));
        if (Array.isArray(parsed)) reportSections = parsed;
      } catch { /* ignore */ }
    }

    const readablePdfPath = resolveLatestPdfCopyForReading(pdfPath);
    const sourceBytes = fs.readFileSync(readablePdfPath);
    const sourceDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
    const totalSourcePages = sourceDoc.getPageCount();

    const reportSectionsWithPages = reportSections.map(sec => {
      const resolved620Pages = resolvePdfPagesForVerseSpan620(sec.verseSpan, totalSourcePages, 0);
      const fallbackPages = Array.isArray(sec.pages)
        ? sec.pages.map(p => p.pdfPage).filter(n => Number.isInteger(n) && n >= 1)
        : fallbackMapPages(sec.startPage, sec.endPage, totalSourcePages);
      return {
        ...sec,
        pdfPages: (resolved620Pages && resolved620Pages.length > 0) ? resolved620Pages : fallbackPages,
      };
    });

    const clips = Array.isArray(session.clips) ? session.clips : [];
    const annotations = await extractPdfAnnotations(sourceDoc);
    const matched = matchClipsToAnnotations(clips, annotations, {
      sessionStartedAt: session.startedAt || (Date.now() - 4 * 3600 * 1000),
    });

    const merged = mergeReportAndAudioSections({
      reportSections: reportSectionsWithPages,
      markers: matched.markers || [],
      unmatchedNewAnnotations: matched.unmatchedNewAnnotations || [],
      includeExtraPages: reportSectionsWithPages.length === 0,
      totalSourcePages,
      pageOffset: 0,
      mapPagesFn: fallbackMapPages,
    });

    if (merged.allPdfPages.length === 0) {
      merged.sections.push({
        key: 'corrections',
        titleAr: 'معاينة مصحف الطالب',
        titleEn: 'Student Mushaf Preview',
        summaryAr: 'صفحة ١',
        summaryEn: 'Page 1',
        pages: [{ pdfPage: 1, markers: [] }],
      });
      merged.allPdfPages.push(1);
    }

    const allowedSet = new Set(merged.allPdfPages);
    const filteredRecolor = (matched.unmatchedNewAnnotations || []).filter(a => allowedSet.has(a.pdfPage));
    const renderBytes = await prepareCorrectionPdfForRendering(
      sourceBytes, filteredRecolor, merged.allPdfPages
    );

    const cropPlanMap = new Map();
    const cropRequests = [];
    const sectionPageCropKey = new Map();

    merged.sections.forEach((sec, secIdx) => {
      (sec.pages || []).forEach(p => {
        const crop = computePageCropForVerseSpan620(p.pdfPage, sec.verseSpan, totalSourcePages, 0);
        const cropKey = crop.isCropped
          ? `${p.pdfPage}_${crop.topFrac.toFixed(4)}_${crop.botFrac.toFixed(4)}_${crop.drawTopBar ? 1 : 0}${crop.drawBotBar ? 1 : 0}`
          : String(p.pdfPage);
        sectionPageCropKey.set(`${secIdx}:${p.pdfPage}`, { crop, cropKey });
        if (!cropPlanMap.has(cropKey)) {
          cropPlanMap.set(cropKey, crop);
          cropRequests.push({ key: cropKey, pdfPage: p.pdfPage, crop });
        }
      });
    });

    const renderedImages = await renderPdfPagesToImages({
      BrowserWindow,
      pdfPath: readablePdfPath,
      pdfBytes: renderBytes,
      pageNumbers: merged.allPdfPages,
      cropRequests,
      scale: 1.55,
    });

    const enrichedSections = merged.sections.map((sec, secIdx) => ({
      ...sec,
      pages: sec.pages.map(p => {
        const plan = sectionPageCropKey.get(`${secIdx}:${p.pdfPage}`);
        const cropKey = plan ? plan.cropKey : String(p.pdfPage);
        const crop = plan ? plan.crop : null;
        const rendered = renderedImages[cropKey] || renderedImages[String(p.pdfPage)];
        const mappedMarkers = (p.markers || [])
          .map(m => {
            const transformed = transformMarkerForCrop(m, rendered?.cropApplied ? crop : null, rendered);
            if (!transformed) return null;
            return {
              id: transformed.clipId,
              xPercent: transformed.xPercent,
              yPercent: transformed.yPercent,
              durationMs: transformed.durationMs || 0,
              audioDataUrl: readClipAudioDataUrl(session.sessionKey, transformed.audioFileName),
            };
          })
          .filter(Boolean);
        return {
          pdfPage: p.pdfPage,
          imageDataUrl: rendered?.imageDataUrl || '',
          markers: mappedMarkers,
        };
      }),
    }));

    const outPayload = {
      id: `local_${session.sessionKey}`,
      studentName: session.studentName || 'طالب',
      dateStr: session.dateStr || new Date().toLocaleDateString('en-CA'),
      language: /[\u0600-\u06FF]/.test(session.studentName || '') ? 'ar' : 'en',
      sections: enrichedSections,
      generatedAt: Date.now(),
    };
    fs.writeFileSync(outJsonPath, JSON.stringify(outPayload), 'utf8');
    app.exit(0);
  } catch (err) {
    console.error('DEV_PDF_WORKER_ERROR:', err);
    fs.writeFileSync(outJsonPath || '', JSON.stringify({ error: err?.message || String(err) }), 'utf8');
    app.exit(1);
  }
});
