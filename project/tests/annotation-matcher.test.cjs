const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFName } = require('pdf-lib');
const {
  parsePdfDate,
  rectToPagePercent,
  extractPdfAnnotations,
  matchClipsToAnnotations,
  recolorAnnotationsToGreenInPdfBytes,
  mergeReportAndAudioSections,
} = require('../core/annotation-matcher');
const { publishAudioSessionToCloud, buildInteractiveHtml } = require('../core/publisher');
const {
  loadHudState,
  saveHudState,
  parseXodoFileNameMapping,
  loadOrCreateSession,
  addAudioClipToSession,
  removeClipFromSession,
  redoClipInSession,
} = require('../core/session-store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('parsePdfDate handles Z, explicit offsets, and local PDF dates accurately', () => {
  assert.equal(parsePdfDate('(D:20260905212826Z)'), Date.UTC(2026, 8, 5, 21, 28, 26));
  assert.equal(parsePdfDate("D:20261121224015+02'00'"), Date.UTC(2026, 10, 21, 20, 40, 15));
  assert.equal(parsePdfDate('invalid'), null);
});

test('rectToPagePercent converts full-page PDF coordinates independent of viewer zoom', () => {
  // Page 500x1000, bottom-left origin in PDF -> rect near top-right word (center Y = 800 -> +1.4% above center = 814)
  const res = rectToPagePercent([300, 780, 400, 820], { x: 0, y: 0, width: 500, height: 1000 }, 0);
  assert.equal(res.xPercent, 70);
  assert.equal(res.yPercent, 18.6);

  // Thin vs tall annotations centered on the same word must land at the exact same line-gap height
  const thin = rectToPagePercent([300, 790, 400, 810], { x: 0, y: 0, width: 500, height: 1000 }, 0);
  const tall = rectToPagePercent([300, 767, 400, 833], { x: 0, y: 0, width: 500, height: 1000 }, 0);
  assert.equal(thin.yPercent, tall.yPercent);
});

test('extractPdfAnnotations & matchClipsToAnnotations match timestamps 1-to-1 and keep manual overrides', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([500, 1000]);

  const t1 = Date.UTC(2026, 10, 21, 20, 10, 15);
  const t2 = Date.UTC(2026, 10, 21, 20, 11, 20);
  const oldT = Date.UTC(2024, 4, 10, 10, 0, 0);

  const mkAnnot = (rect, dateStr, color = [1, 1, 0]) => doc.context.register(doc.context.obj({
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: rect,
    C: color,
    CreationDate: dateStr,
  }));

  // Old highlight on page 1 must be ignored; page 2 & 3 highlights match clip1 & clip2
  doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([
    mkAnnot([100, 500, 150, 520], 'D:20240510100000Z'),
  ]));
  doc.getPage(1).node.set(PDFName.of('Annots'), doc.context.obj([
    mkAnnot([200, 700, 300, 740], 'D:20261121201017Z'),
  ]));
  doc.getPage(2).node.set(PDFName.of('Annots'), doc.context.obj([
    mkAnnot([50, 400, 150, 440], 'D:20261121201122Z'),
  ]));

  const annotations = await extractPdfAnnotations(await doc.save());
  assert.equal(annotations.length, 3);
  assert.equal(annotations[0].createdAtMs, oldT);

  const clips = [
    { id: 'c1', fileName: 'c1.mp3', startedAt: t1, endedAt: t1 + 4000, durationMs: 4000 },
    { id: 'c2', fileName: 'c2.mp3', startedAt: t2, endedAt: t2 + 3000, durationMs: 3000 },
    { id: 'c3', fileName: 'c3.mp3', startedAt: t2 + 60000, endedAt: t2 + 63000, durationMs: 3000, manualPage: 4, manualXPercent: 42, manualYPercent: 60 },
  ];

  const { markers, unmatchedClips } = matchClipsToAnnotations(clips, annotations, {
    sessionStartedAt: t1 - 30000,
  });

  assert.equal(unmatchedClips.length, 0);
  assert.equal(markers.length, 3);
  assert.equal(markers[0].clipId, 'c1');
  assert.equal(markers[0].pdfPage, 2);
  assert.equal(markers[0].xPercent, 50);
  assert.equal(markers[1].clipId, 'c2');
  assert.equal(markers[1].pdfPage, 3);
  assert.equal(markers[2].source, 'manual');
  assert.equal(markers[2].pdfPage, 4);
});

test('mergeReportAndAudioSections includes all report pages and appends extra marked pages without duplicates', () => {
  const reportSections = [
    { key: 'rev', titleAr: 'المراجعة القريبة', startPage: 10, endPage: 11, pdfPages: [10, 11] },
    { key: 'new', titleAr: 'الجديد', startPage: 12, endPage: 12, pdfPages: [12] },
  ];
  const markers = [
    { clipId: 'c1', pdfPage: 11, xPercent: 40, yPercent: 30 },
    { clipId: 'c2', pdfPage: 15, xPercent: 55, yPercent: 70 },
  ];
  const merged = mergeReportAndAudioSections({ reportSections, markers, totalSourcePages: 620 });
  assert.deepEqual(merged.allPdfPages, [10, 11, 12, 15]);
  assert.equal(merged.sections.length, 3);
  assert.equal(merged.sections[0].pages[1].markers.length, 1);
  assert.equal(merged.sections[2].key, 'corrections');
  assert.equal(merged.sections[2].pages[0].pdfPage, 15);
});

test('publishAudioSessionToCloud retains at most 3 newest sessions per student and deletes older ones', async () => {
  const store = {
    '/audioMushafIndex/s1.json': { old1: 100, old2: 200, old3: 300 },
    '/audioMushafSessions/old1.json': { id: 'old1' },
    '/audioMushafSessions/old2.json': { id: 'old2' },
    '/audioMushafSessions/old3.json': { id: 'old3' },
  };
  const mockRequest = (urlStr, opts, cb) => {
    const u = new URL(urlStr);
    const req = new EventEmitter();
    let reqBody = '';
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.write = (chunk) => { reqBody += String(chunk); };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      let respText = 'null';
      if (opts.method === 'GET') {
        respText = JSON.stringify(store[u.pathname] ?? null);
      } else if (opts.method === 'PUT') {
        store[u.pathname] = reqBody ? JSON.parse(reqBody) : null;
        respText = reqBody || 'null';
      } else if (opts.method === 'DELETE') {
        delete store[u.pathname];
      }
      cb(res);
      res.emit('data', Buffer.from(respText));
      res.emit('end');
    };
    return req;
  };

  const res = await publishAudioSessionToCloud({
    studentId: 's1',
    studentName: 'Bilal',
    dateStr: '2026-11-21',
    createdAt: 400,
    sections: [],
  }, { maxSessionsPerStudent: 3, requestImpl: mockRequest });

  assert.equal(res.success, true);
  assert.equal(res.prunedCount, 1);
  assert.equal(store['/audioMushafSessions/old1.json'], undefined);
  assert.ok(store['/audioMushafSessions/old2.json']);
  assert.ok(store['/audioMushafSessions/old3.json']);
  assert.equal(Object.keys(store['/audioMushafIndex/s1.json']).length, 3);

  const html = buildInteractiveHtml({
    studentName: 'Bilal',
    dateStr: '2026-11-21',
    language: 'en',
    sections: [{ key: 'new', titleEn: 'New', summaryEn: 'Page 5', pages: [{ pdfPage: 5, imageDataUrl: 'data:image/jpeg;base64,AA==', markers: [{ id: 'm1', xPercent: 50, yPercent: 40, audioDataUrl: 'data:audio/mpeg;base64,AA==' }] }] }],
  });
  assert.match(html, /togglePinAudio/);
  assert.match(html, /left:50%;top:40%/);
});

test('session undo (F22), redo (F21), and hud-state persistence work reliably', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qac-test-'));
  try {
    const sess = loadOrCreateSession({
      studentId: 'st1',
      studentName: 'Ahmed',
      dateStr: '2026-11-22',
      rootDir: tmpDir,
    });
    const added = addAudioClipToSession(sess.sessionKey, {
      buffer: Buffer.from('FAKE_MP3'),
      ext: 'mp3',
      startedAt: 1000,
      endedAt: 3000,
      durationMs: 2000,
    }, tmpDir);
    assert.equal(added.session.clips.length, 1);

    const undone = removeClipFromSession(sess.sessionKey, null, tmpDir);
    assert.ok(undone.removed);
    assert.equal(undone.session.clips.length, 0);
    assert.equal(undone.session.undoneClips.length, 1);

    const redone = redoClipInSession(sess.sessionKey, tmpDir);
    assert.ok(redone.restored);
    assert.equal(redone.session.clips.length, 1);
    assert.equal(redone.session.undoneClips.length, 0);

    const hudFile = path.join(tmpDir, 'hud-state.json');
    saveHudState({ x: 320, y: 140, mode: 'bar' }, hudFile);
    const loadedHud = loadHudState(hudFile);
    assert.equal(loadedHud.x, 320);
    assert.equal(loadedHud.y, 140);
    assert.equal(loadedHud.mode, 'bar');

    const mapFile = path.join(tmpDir, 'FileNameMapping.txt');
    const xml = '\uFEFF<?xml version="1.0" encoding="utf-16"?><ArrayOfKeyValuePair><KeyValuePair><Key>G:\\Books\\Ahmed.pdf</Key><Value>C:\\Xodo\\OpenDocuments\\123\\Ahmed.pdf</Value></KeyValuePair></ArrayOfKeyValuePair>';
    fs.writeFileSync(mapFile, Buffer.from(xml, 'utf16le'));
    const parsed = parseXodoFileNameMapping(mapFile);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].key, 'G:\\Books\\Ahmed.pdf');
    assert.equal(parsed[0].value, 'C:\\Xodo\\OpenDocuments\\123\\Ahmed.pdf');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('unmatched new yellow highlights are detected and recolored to green [0, 1, 0] in memory', async () => {
  const zlib = require('node:zlib');
  const doc = await PDFDocument.create();
  doc.addPage([500, 1000]);
  doc.addPage([500, 1000]);

  const ap1 = doc.context.flateStream(zlib.deflateSync(Buffer.from('/G0 gs\n1 1 0 RG\n24 w\n10 10 m 50 10 l S', 'latin1')));
  const ap2 = doc.context.flateStream(zlib.deflateSync(Buffer.from('/G0 gs\n1 1 0 RG\n24 w\n20 20 m 80 20 l S', 'latin1')));

  const t1 = Date.UTC(2026, 10, 22, 0, 10, 0);
  const t2 = Date.UTC(2026, 10, 22, 0, 12, 0); // No audio clip -> memorization highlight

  const a1 = doc.context.register(doc.context.obj({
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: [100, 600, 200, 640],
    C: [1, 1, 0],
    AP: { N: doc.context.register(ap1) },
    CreationDate: 'D:20261122001002Z',
  }));
  const a2 = doc.context.register(doc.context.obj({
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: [150, 400, 250, 440],
    C: [1, 1, 0],
    AP: { N: doc.context.register(ap2) },
    CreationDate: 'D:20261122001200Z',
  }));
  doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([a1]));
  doc.getPage(1).node.set(PDFName.of('Annots'), doc.context.obj([a2]));

  const origBytes = await doc.save();
  const annots = await extractPdfAnnotations(origBytes);
  const clips = [{ id: 'c1', fileName: 'c1.mp3', startedAt: t1, endedAt: t1 + 3000, durationMs: 3000 }];
  const { markers, unmatchedNewAnnotations } = matchClipsToAnnotations(clips, annots, { sessionStartedAt: t1 - 5000 });

  assert.equal(markers.length, 1);
  assert.equal(markers[0].pdfPage, 1);
  assert.equal(unmatchedNewAnnotations.length, 1);
  assert.equal(unmatchedNewAnnotations[0].pdfPage, 2);

  const recoloredBytes = await recolorAnnotationsToGreenInPdfBytes(origBytes, unmatchedNewAnnotations);
  const reExtracted = await extractPdfAnnotations(recoloredBytes);
  assert.deepEqual(reExtracted[0].color, [1, 1, 0]); // Matched voice clip stays yellow
  assert.deepEqual(reExtracted[1].color, [0, 1, 0]); // Unmatched memorization highlight becomes green

  const merged = mergeReportAndAudioSections({ reportSections: [], markers, unmatchedNewAnnotations });
  assert.deepEqual(merged.allPdfPages, [1, 2]);
});

test('findSessionForStudent falls back across day transition or today when calendar date differs from recording date', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const {
    loadOrCreateSession,
    addAudioClipToSession,
    findSessionForStudent,
    getTodayDateStr,
  } = require('../core/session-store');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qac-find-'));
  try {
    const todayStr = getTodayDateStr();
    const sess = loadOrCreateSession({ studentId: 'st9', studentName: 'محمد علي', dateStr: todayStr, rootDir: tmpDir });
    addAudioClipToSession(sess.sessionKey, {
      buffer: Buffer.from('FAKE_MP3'),
      ext: 'mp3',
      startedAt: Date.now() - 2000,
      endedAt: Date.now(),
      durationMs: 2000,
    }, tmpDir);

    // Calendar viewing a past day (e.g. 2026-11-16) should still locate today's active clips
    const found = findSessionForStudent({ studentId: 'st9', studentName: 'محمد علي', dateStr: '2026-11-16', rootDir: tmpDir });
    assert.ok(found);
    assert.equal(found.clips.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
