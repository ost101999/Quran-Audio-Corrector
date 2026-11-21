import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Eye,
  FileCode2,
  FolderOpen,
  GripVertical,
  Link2,
  Loader2,
  Mic,
  Minimize2,
  Play,
  RotateCcw,
  RotateCw,
  Square,
  Trash2,
  UserCheck,
  Volume2,
} from 'lucide-react';
import { AudioInputDevice, listAudioInputs, Mp3VoiceRecorder, playSoftTone } from './audioEncoder';

type HudMode = 'pill' | 'bar' | 'review';

interface StudentOption {
  id: string;
  name: string;
  academy: string;
  sourcePdfPath: string;
}

interface SessionClip {
  id: string;
  fileName: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  manualPage: number | null;
  manualXPercent: number | null;
  manualYPercent: number | null;
}

export default function App() {
  const [mode, setMode] = useState<HudMode>(() => (window.correctorAPI?.initialMode === 'pill' ? 'pill' : 'bar'));
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [manualLock, setManualLock] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<{
    id: string;
    name: string;
    sourcePdfPath: string;
  }>({ id: '', name: 'في انتظار فتح مصحف...', sourcePdfPath: '' });
  const [session, setSession] = useState<{
    sessionKey: string;
    clips: SessionClip[];
    undoneClips?: SessionClip[];
    startedAt: number;
  } | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);
  const [activeMic, setActiveMic] = useState<AudioInputDevice | null>(null);
  const [showMicMenu, setShowMicMenu] = useState(false);

  // Review state
  const [matchData, setMatchData] = useState<{
    markers: any[];
    unmatchedClips: SessionClip[];
    unmatchedNewAnnotations?: any[];
    allPdfPages: number[];
    sourcePdfPath: string;
    error?: string;
  } | null>(null);
  const [pageImages, setPageImages] = useState<Record<string, { imageDataUrl: string }>>({});
  const [reviewError, setReviewError] = useState('');
  const [activePinClipId, setActivePinClipId] = useState<string | null>(null);
  const [customPageInput, setCustomPageInput] = useState<string>('');
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);

  const recorderRef = useRef<Mp3VoiceRecorder | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const modeRef = useRef<HudMode>(mode);
  modeRef.current = mode;

  const flashStatus = useCallback((msg: string, ms = 3200) => {
    setStatusMsg(msg);
    window.setTimeout(() => {
      setStatusMsg(prev => (prev === msg ? '' : prev));
    }, ms);
  }, []);

  // Resize native Electron window cleanly when switching HUD modes
  useEffect(() => {
    const api = window.correctorAPI;
    if (!api) return;
    if (mode === 'pill') {
      void api.resize({ width: 78, height: 112, anchorSide: 'edge' });
    } else if (mode === 'bar') {
      void api.resize({ width: 410, height: 172, anchorSide: 'edge' });
    } else {
      void api.resize({ width: 900, height: 760, anchorSide: 'center' });
    }
  }, [mode]);

  // Warm up microphone pipeline once on boot (auto-defaults to Voicemeeter Out B1 or saved choice)
  useEffect(() => {
    let alive = true;
    const rec = new Mp3VoiceRecorder();
    recorderRef.current = rec;

    const refreshDevices = async () => {
      try {
        const list = await listAudioInputs();
        if (alive) setAudioInputs(list);
      } catch { /* ignore */ }
    };

    const initMic = async () => {
      try {
        const saved = await window.correctorAPI?.getHudState().catch(() => null);
        const pref = saved?.micDeviceId || saved?.micLabel
          ? { deviceId: saved.micDeviceId, label: saved.micLabel }
          : null;
        await rec.warmUp(pref);
        if (!alive) return;
        setActiveMic(rec.getActiveMic());
        await refreshDevices();
      } catch { /* ignore */ }
    };

    void initMic();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
      rec.dispose();
    };
  }, []);

  // Toggle between compact Pill and expanded Bar with Esc when HUD window is focused
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      if (showMicMenu) {
        setShowMicMenu(false);
        return;
      }
      setMode(prev => (prev === 'pill' ? 'bar' : 'pill'));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showMicMenu]);

  // Load students list on boot
  useEffect(() => {
    window.correctorAPI?.listStudents().then(setStudents).catch(() => {});
  }, []);

  // Ensure a session exists whenever selectedStudent changes
  const syncSessionForStudent = useCallback(async (info: { id: string; name: string; sourcePdfPath: string }) => {
    if (!window.correctorAPI) return;
    setMatchData(null);
    setPageImages({});
    setActivePinClipId(null);
    setReviewError('');
    const loaded = await window.correctorAPI.loadOrCreateSession({
      studentId: info.id,
      studentName: info.name,
      sourcePdfPath: info.sourcePdfPath,
    });
    setSession(loaded);
  }, []);

  // Poll active Xodo / Acrobat window when not manually locked
  useEffect(() => {
    let timer: number | undefined;
    const poll = async () => {
      if (manualLock || isRecording || modeRef.current === 'review' || !window.correctorAPI) return;
      try {
        const res = await window.correctorAPI.detectActiveStudent();
        if (res?.detected && res.detected.studentName) {
          const next = {
            id: res.detected.studentId || '',
            name: res.detected.studentName,
            sourcePdfPath: res.detected.sourcePdfPath || '',
          };
          setSelectedStudent(prev => {
            if (prev.name === next.name && prev.sourcePdfPath === next.sourcePdfPath) return prev;
            void syncSessionForStudent(next);
            return next;
          });
        }
      } catch { /* ignore */ }
    };
    void poll();
    timer = window.setInterval(poll, 2600);
    return () => { if (timer) window.clearInterval(timer); };
  }, [manualLock, isRecording, syncSessionForStudent]);

  // Elapsed recording seconds ticker
  useEffect(() => {
    if (!isRecording) {
      setRecordSeconds(0);
      return;
    }
    const id = window.setInterval(() => setRecordSeconds(s => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [isRecording]);

  const toggleRecording = useCallback(async () => {
    if (busy || !window.correctorAPI) return;
    if (!isRecording) {
      try {
        if (!recorderRef.current) recorderRef.current = new Mp3VoiceRecorder();
        await recorderRef.current.start();
        setIsRecording(true);
        playSoftTone(1050, 90, 0.06);
        flashStatus('جاري التسجيل... (F20 للإيقاف)');
        if (!session) {
          void window.correctorAPI.loadOrCreateSession({
            studentId: selectedStudent.id,
            studentName: selectedStudent.name === 'في انتظار فتح مصحف...' ? 'طالب' : selectedStudent.name,
            sourcePdfPath: selectedStudent.sourcePdfPath,
          }).then(setSession).catch(() => {});
        }
      } catch {
        playSoftTone(300, 220, 0.07);
        flashStatus('تعذر فتح الميكروفون');
      }
      return;
    }

    // Stop recording
    const rec = recorderRef.current;
    setIsRecording(false);
    if (!rec) return;

    try {
      const result = await rec.stop();
      if (result.silent || result.bytes.length === 0) {
        playSoftTone(260, 240, 0.06);
        flashStatus('تم تجاهل تسجيل صامت');
        return;
      }
      let targetSession = session;
      if (!targetSession) {
        targetSession = await window.correctorAPI.loadOrCreateSession({
          studentId: selectedStudent.id,
          studentName: selectedStudent.name === 'في انتظار فتح مصحف...' ? 'طالب' : selectedStudent.name,
          sourcePdfPath: selectedStudent.sourcePdfPath,
        });
      }
      if (!targetSession) return;
      const saved = await window.correctorAPI.addClip({
        sessionKey: targetSession.sessionKey,
        audioBytes: result.bytes,
        ext: 'mp3',
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        durationMs: result.durationMs,
      });
      setSession(saved.session);
      playSoftTone(700, 100, 0.06);
      flashStatus(`تم حفظ التصحيح (${saved.session.clips.length})`);
    } catch {
      playSoftTone(260, 240, 0.06);
      flashStatus('تعذر حفظ المقطع الصوتي');
    }
  }, [busy, isRecording, session, selectedStudent, flashStatus]);

  const handleUndoLast = useCallback(async () => {
    if (!session || isRecording || !window.correctorAPI) return;
    const res = await window.correctorAPI.removeClip({ sessionKey: session.sessionKey });
    if (res?.removed) {
      setSession(res.session);
      playSoftTone(420, 140, 0.06);
      flashStatus('تم التراجع عن آخر تسجيل (F21 للإرجاع)');
    } else {
      flashStatus('لا توجد تسجيلات للتراجع');
    }
  }, [session, isRecording, flashStatus]);

  const handleRedoLast = useCallback(async () => {
    if (!session || isRecording || !window.correctorAPI) return;
    const res = await window.correctorAPI.redoClip({ sessionKey: session.sessionKey });
    if (res?.restored) {
      setSession(res.session);
      playSoftTone(580, 120, 0.06);
      flashStatus(`تمت إعادة التسجيل (${res.session.clips?.length || 0})`);
    } else {
      flashStatus('لا توجد تسجيلات متراجع عنها للإرجاع');
    }
  }, [session, isRecording, flashStatus]);

  const openReviewModal = useCallback(async () => {
    if (!session || !window.correctorAPI) return;
    setBusy(true);
    setMode('review');
    setPageImages({});
    setReviewError('');
    try {
      const matched = await window.correctorAPI.matchAnnotations({
        sessionKey: session.sessionKey,
        sourcePdfPath: selectedStudent.sourcePdfPath,
        autoSave: true,
      });
      setMatchData(matched);
      if (!matched?.success) {
        const msg = matched?.error || 'لم يتم العثور على ملف PDF مصحف الطالب.';
        setReviewError(msg);
        flashStatus(msg, 4500);
        return;
      }
      if (matched.unmatchedClips?.length > 0) {
        setActivePinClipId(matched.unmatchedClips[0].id);
      } else {
        setActivePinClipId(null);
      }
      const pagesToRender = new Set<number>(matched.allPdfPages?.length ? matched.allPdfPages : (matched.suggestedPages || [1]));
      if (matched.sourcePdfPath && pagesToRender.size > 0) {
        const rendered = await window.correctorAPI.renderPages({
          sourcePdfPath: matched.sourcePdfPath,
          pageNumbers: [...pagesToRender].sort((a, b) => a - b),
          scale: 1.5,
          recolorAnnotations: matched.unmatchedNewAnnotations || [],
        });
        if (rendered?.success && rendered?.images && Object.keys(rendered.images).length > 0) {
          setPageImages(rendered.images);
        } else {
          const msg = rendered?.error || 'تعذّر عرض صفحات المصحف داخل المعاينة.';
          setReviewError(msg);
          flashStatus(msg, 4500);
        }
      }
    } catch {
      const msg = 'تعذر تحميل صفحات المعاينة.';
      setReviewError(msg);
      flashStatus(msg, 4500);
    } finally {
      setBusy(false);
    }
  }, [session, selectedStudent.sourcePdfPath, flashStatus]);

  const handleExport = useCallback(async (exportMode: 'web_link' | 'html') => {
    if (!session || !window.correctorAPI) return;
    if (isRecording) await toggleRecording();
    setBusy(true);
    flashStatus(exportMode === 'web_link' ? 'جاري التجهيز والرفع كرابط...' : 'جاري إنشاء ملف HTML التفاعلي...');
    try {
      const res = await window.correctorAPI.exportSession({
        sessionKey: session.sessionKey,
        sourcePdfPath: selectedStudent.sourcePdfPath,
        mode: exportMode,
        language: /[\u0600-\u06FF]/.test(selectedStudent.name) ? 'ar' : 'en',
        autoSave: true,
      });
      if (res?.success) {
        playSoftTone(1200, 120, 0.06);
        if ((res.unmatchedCount || 0) > 0) {
          flashStatus(`تم الحفظ، تنبيه: ${res.unmatchedCount} تسجيل بدون تظليل لم يُضف`, 6000);
        } else {
          flashStatus(exportMode === 'web_link' ? 'تم رفع ونسخ الرابط بنجاح ✅' : 'تم حفظ ونسخ ملف HTML ✅', 5000);
        }
      } else if (res?.needsManualReview) {
        flashStatus('لم يتم العثور على تظليل جديد؛ افتح المعاينة لتثبيت العلامة', 4500);
        await openReviewModal();
      } else {
        flashStatus(res?.error || 'تعذر التصدير');
      }
    } finally {
      setBusy(false);
    }
  }, [session, isRecording, toggleRecording, selectedStudent.name, flashStatus, openReviewModal]);

  // Listen to global shortcuts F17 / F22 / F21 / F20
  useEffect(() => {
    if (!window.correctorAPI) return;
    return window.correctorAPI.onShortcut((action) => {
      if (action === 'toggle-record') void toggleRecording();
      else if (action === 'undo-last') void handleUndoLast();
      else if (action === 'redo-last') void handleRedoLast();
      else if (action === 'finish-export') void handleExport('web_link');
    });
  }, [toggleRecording, handleUndoLast, handleRedoLast, handleExport]);

  const playClipAudio = async (clip: { id: string; fileName: string }) => {
    if (!session || !window.correctorAPI) return;
    if (playingClipId === clip.id && audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      setPlayingClipId(null);
      return;
    }
    const url = await window.correctorAPI.clipDataUrl({ sessionKey: session.sessionKey, fileName: clip.fileName });
    if (!url) return;
    if (audioPlayerRef.current) audioPlayerRef.current.pause();
    const audio = new Audio(url);
    audioPlayerRef.current = audio;
    setPlayingClipId(clip.id);
    audio.onended = () => setPlayingClipId(null);
    await audio.play().catch(() => setPlayingClipId(null));
  };

  const handlePageImageClick = async (pdfPage: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (!activePinClipId || !session || !window.correctorAPI) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPercent = Number((((e.clientX - rect.left) / rect.width) * 100).toFixed(2));
    const yPercent = Number((((e.clientY - rect.top) / rect.height) * 100).toFixed(2));
    const updated = await window.correctorAPI.updatePin({
      sessionKey: session.sessionKey,
      clipId: activePinClipId,
      pdfPage,
      xPercent,
      yPercent,
    });
    setSession(updated);
    setActivePinClipId(null);
    await openReviewModal();
  };

  const handleLoadExtraPage = async () => {
    const p = Number(customPageInput);
    if (!Number.isInteger(p) || p < 1 || !matchData?.sourcePdfPath || !window.correctorAPI) return;
    setBusy(true);
    try {
      const rendered = await window.correctorAPI.renderPages({
        sourcePdfPath: matchData.sourcePdfPath,
        pageNumbers: [p],
        scale: 1.5,
        recolorAnnotations: matchData.unmatchedNewAnnotations || [],
      });
      if (rendered?.images) {
        setPageImages(prev => ({ ...prev, ...rendered.images }));
      }
    } finally {
      setBusy(false);
    }
  };

  const clipsCount = session?.clips?.length || 0;
  const redoCount = session?.undoneClips?.length || 0;

  // === MODE 1: COLLAPSED EDGE PILL ===
  if (mode === 'pill') {
    return (
      <div className="w-full h-full flex items-center justify-center p-1.5">
        <div
          className={`hud-drag w-full h-full rounded-2xl border shadow-xl flex flex-col items-center justify-between py-2 px-1 transition-all ${
            isRecording
              ? 'bg-rose-950/95 border-rose-400/70 shadow-rose-500/30'
              : 'bg-slate-900/92 border-emerald-400/40 shadow-black/40'
          }`}
        >
          <button
            type="button"
            onClick={() => void toggleRecording()}
            title={isRecording ? 'إيقاف التسجيل (F20)' : 'بدء التسجيل (F20)'}
            className={`hud-no-drag w-10 h-10 rounded-full flex items-center justify-center transition-transform active:scale-95 ${
              isRecording ? 'bg-rose-500 text-white animate-pulse' : 'bg-emerald-500 text-white hover:bg-emerald-400'
            }`}
          >
            {isRecording ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
          </button>

          <button
            type="button"
            onClick={() => setMode('bar')}
            title="توسيع شريط المصحح الصوتي"
            className="hud-no-drag w-full rounded-xl py-1 px-1 bg-white/10 hover:bg-white/20 text-white text-xs font-bold flex items-center justify-center gap-1"
          >
            <span>{isRecording ? `${recordSeconds}ث` : clipsCount}</span>
            <Volume2 size={12} className="text-emerald-300" />
          </button>
        </div>
      </div>
    );
  }

  // === MODE 3: FULL VISUAL REVIEW & PIN ADJUSTMENT MODAL ===
  if (mode === 'review') {
    const renderedPages = Object.keys(pageImages)
      .map(Number)
      .filter(n => Number.isInteger(n))
      .sort((a, b) => a - b);

    return (
      <div className="w-full h-full p-2">
        <div className="w-full h-full rounded-2xl bg-slate-900 text-slate-100 border border-white/15 shadow-2xl flex flex-col overflow-hidden">
          <div className="hud-drag shrink-0 px-5 py-3.5 bg-slate-950/80 border-b border-white/10 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                <Volume2 size={18} />
              </span>
              <div>
                <h2 className="text-base font-bold text-white">مراجعة وتعديل مواضع التصحيحات — {selectedStudent.name}</h2>
                <p className="text-xs text-slate-400">
                  {activePinClipId
                    ? 'اضغط على الكلمة داخل أي صفحة لتثبيت علامة الصوت عليها'
                    : 'اختر مقطعاً صوتياً من القائمة لتحريكه أو الاستماع له'}
                </p>
              </div>
            </div>
            <div className="hud-no-drag flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void openReviewModal()}
                className="px-3 py-1.5 rounded-xl bg-emerald-600/30 hover:bg-emerald-600/50 disabled:opacity-40 text-xs font-bold text-emerald-200 flex items-center gap-1"
              >
                <RotateCcw size={13} /> تحديث الصفحات
              </button>
              <button
                type="button"
                onClick={() => setMode('bar')}
                className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold"
              >
                رجوع للشريط
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 grid grid-cols-12 overflow-hidden">
            {/* Clips Sidebar */}
            <aside className="col-span-4 border-l border-white/10 bg-slate-950/40 p-3 overflow-y-auto space-y-2.5">
              <div className="text-xs font-bold text-slate-400">المقاطع الصوتية ({clipsCount})</div>
              {(session?.clips || []).map((clip, idx) => {
                const matchedPin = matchData?.markers?.find(m => m.clipId === clip.id);
                const isSelected = activePinClipId === clip.id;
                return (
                  <div
                    key={clip.id}
                    className={`rounded-xl p-2.5 border transition-colors ${
                      isSelected
                        ? 'border-amber-400 bg-amber-500/15'
                        : matchedPin
                          ? 'border-emerald-500/30 bg-slate-800/70'
                          : 'border-rose-500/50 bg-rose-500/10'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold text-white">تصحيح {idx + 1}</span>
                      <span className="text-[11px] text-slate-400">{Math.max(1, Math.round((clip.durationMs || 1000) / 1000))} ث</span>
                    </div>
                    <div className="text-xs mt-1 text-slate-300">
                      {matchedPin ? `مثبّت في صفحة ${matchedPin.pdfPage}` : 'غير مربوط بتظليل — اختر لتثبيته'}
                    </div>
                    <div className="flex items-center gap-1.5 mt-2">
                      <button
                        type="button"
                        onClick={() => void playClipAudio(clip)}
                        className="px-2 py-1 rounded-lg bg-emerald-600/80 hover:bg-emerald-600 text-xs flex items-center gap-1"
                      >
                        <Play size={12} /> {playingClipId === clip.id ? 'إيقاف' : 'سماع'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setActivePinClipId(isSelected ? null : clip.id)}
                        className={`px-2 py-1 rounded-lg text-xs ${
                          isSelected ? 'bg-amber-400 text-slate-950 font-bold' : 'bg-white/10 hover:bg-white/20'
                        }`}
                      >
                        {isSelected ? 'اضغط على الصفحة' : 'تحديد الموضع'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!session) return;
                          const res = await window.correctorAPI.removeClip({ sessionKey: session.sessionKey, clipId: clip.id });
                          setSession(res.session);
                          await openReviewModal();
                        }}
                        className="p-1 rounded-lg text-rose-300 hover:bg-rose-500/20 mr-auto"
                        title="حذف المقطع"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {matchData?.sourcePdfPath && (
                <div className="pt-3 border-t border-white/10 space-y-1.5">
                  <label className="block text-xs text-slate-400">عرض صفحة إضافية من المصحف:</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      min={1}
                      value={customPageInput}
                      onChange={e => setCustomPageInput(e.target.value)}
                      placeholder="رقم الصفحة"
                      className="w-full px-2.5 py-1 rounded-lg bg-slate-800 border border-white/15 text-xs text-white focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleLoadExtraPage()}
                      className="px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-bold shrink-0"
                    >
                      عرض
                    </button>
                  </div>
                </div>
              )}
            </aside>

            {/* Pages Viewport */}
            <div className="col-span-8 p-4 overflow-y-auto space-y-5 bg-slate-950/60">
              {busy && (
                <div className="flex items-center justify-center py-10 gap-2 text-emerald-400">
                  <Loader2 size={20} className="animate-spin" />
                  <span className="text-sm">جاري تجهيز صفحات المصحف...</span>
                </div>
              )}
              {reviewError && !busy && (
                <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-5 text-center text-sm text-rose-200 space-y-1">
                  <div className="font-bold">تعذّر عرض صفحات المصحف</div>
                  <div className="text-xs text-rose-300">{reviewError}</div>
                </div>
              )}
              {renderedPages.length === 0 && !busy && !reviewError && (
                <div className="rounded-xl border border-white/10 bg-slate-900/70 p-6 text-center text-sm text-slate-300">
                  اختر رقم صفحة من القائمة لعرضها أو تأكد من ربط مصحف الطالب.
                </div>
              )}
              {renderedPages.map(pageNum => {
                const img = pageImages[String(pageNum)]?.imageDataUrl;
                const pins = (matchData?.markers || []).filter(m => m.pdfPage === pageNum);
                if (!img) return null;
                return (
                  <div key={pageNum} className="space-y-1.5">
                    <div className="text-xs font-bold text-slate-400 text-center">صفحة {pageNum}</div>
                    <div
                      onClick={(e) => void handlePageImageClick(pageNum, e)}
                      className={`relative w-full rounded-xl overflow-hidden border border-white/15 bg-white ${
                        activePinClipId ? 'cursor-crosshair ring-2 ring-amber-400' : ''
                      }`}
                    >
                      <img src={img} alt={`Page ${pageNum}`} className="w-full h-auto block" />
                      {pins.map(pin => (
                        <button
                          key={pin.clipId}
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void playClipAudio({ id: pin.clipId, fileName: pin.audioFileName });
                          }}
                          style={{ left: `${pin.xPercent}%`, top: `${pin.yPercent}%`, transform: 'translate(-50%, -85%)' }}
                          className={`absolute w-8 h-8 rounded-full border-2 border-white flex items-center justify-center shadow-lg transition-transform hover:scale-110 ${
                            playingClipId === pin.clipId ? 'bg-rose-500 scale-125' : 'bg-emerald-500'
                          }`}
                          title="تشغيل التصحيح"
                        >
                          <Volume2 size={15} className="text-white" />
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 px-5 py-3 bg-slate-950/90 border-t border-white/10 flex items-center justify-between gap-3">
            <span className="text-xs text-emerald-300 font-semibold">{statusMsg}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleExport('html')}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-bold flex items-center gap-1.5 border border-white/15"
              >
                <FileCode2 size={15} /> حفظ ونسخ HTML
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleExport('web_link')}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-xs font-bold text-white flex items-center gap-1.5 shadow-lg shadow-emerald-600/20"
              >
                <Link2 size={15} /> رفع ونسخ الرابط
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // === MODE 2: COMPACT FLOATING HUD BAR ===
  return (
    <div className="w-full h-full p-1.5">
      <div className="relative w-full h-full rounded-2xl bg-slate-900/95 backdrop-blur-md text-slate-100 border border-white/15 shadow-2xl flex flex-col justify-between p-3">
        {/* Draggable Top Bar + Student Picker */}
        <div className="flex items-center justify-between gap-2">
          <div className="hud-drag flex items-center gap-1.5 cursor-grab flex-1 min-w-0">
            <GripVertical size={15} className="text-slate-500 shrink-0" />
            <UserCheck size={15} className={selectedStudent.sourcePdfPath ? 'text-emerald-400 shrink-0' : 'text-amber-400 shrink-0'} />
            <div className="relative flex-1 min-w-0 hud-no-drag">
              <select
                value={selectedStudent.id || selectedStudent.name}
                onChange={(e) => {
                  const found = students.find(s => (s.id || s.name) === e.target.value);
                  if (found) {
                    setManualLock(true);
                    setSelectedStudent({ id: found.id, name: found.name, sourcePdfPath: found.sourcePdfPath });
                    void syncSessionForStudent({ id: found.id, name: found.name, sourcePdfPath: found.sourcePdfPath });
                  }
                }}
                className="w-full appearance-none bg-white/10 hover:bg-white/15 text-xs font-bold text-white rounded-lg py-1 pr-2.5 pl-6 truncate cursor-pointer focus:outline-none"
                title={selectedStudent.sourcePdfPath || 'اختر الطالب'}
              >
                {!students.some(st => (st.id || st.name) === (selectedStudent.id || selectedStudent.name)) && (
                  <option value={selectedStudent.id || selectedStudent.name} className="bg-slate-900 text-white">
                    {selectedStudent.name}
                  </option>
                )}
                {students.map(st => (
                  <option key={st.id} value={st.id} className="bg-slate-900 text-white">
                    {st.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>
            {manualLock && (
              <button
                type="button"
                onClick={() => setManualLock(false)}
                className="hud-no-drag text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 shrink-0"
                title="العودة للاكتشاف التلقائي من نافذة Xodo/Acrobat"
              >
                تلقائي
              </button>
            )}
          </div>

          <div className="hud-no-drag flex items-center gap-1 shrink-0">
            <button
              type="button"
              disabled={isRecording}
              onClick={async () => {
                if (!showMicMenu) {
                  try { setAudioInputs(await listAudioInputs()); } catch { /* ignore */ }
                }
                setShowMicMenu(v => !v);
              }}
              className={`px-1.5 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 max-w-[92px] truncate ${
                showMicMenu ? 'bg-emerald-500/25 text-emerald-200' : 'bg-white/5 hover:bg-white/15 text-slate-300'
              }`}
              title={`المايك الحالي: ${activeMic?.label || 'الافتراضي'} — اضغط للتغيير`}
            >
              <Mic size={11} className="text-emerald-400 shrink-0" />
              <span className="truncate">
                {(activeMic?.label || 'المايك')
                  .replace(/^(Default|Communications)\s*-\s*/i, '')
                  .replace(/\s*\([^)]*\)/g, '')
                  .trim() || 'المايك'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void window.correctorAPI?.openOutputFolder()}
              className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white"
              title="فتح مجلد الحفظ"
            >
              <FolderOpen size={14} />
            </button>
            <button
              type="button"
              onClick={() => { setShowMicMenu(false); setMode('pill'); }}
              className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white"
              title="تصغير لكبسولة جانبية"
            >
              <Minimize2 size={14} />
            </button>
          </div>
        </div>

        {/* Inline Mic Switcher Overlay */}
        {showMicMenu && (
          <div className="hud-no-drag absolute inset-x-3 top-11 bottom-3 z-30 rounded-xl bg-slate-950/98 border border-white/20 shadow-2xl p-2 flex flex-col gap-1 overflow-y-auto">
            <div className="text-[11px] font-bold text-slate-400 px-1 pb-1 border-b border-white/10 flex items-center justify-between">
              <span>اختر المايكروفون</span>
              <button type="button" onClick={() => setShowMicMenu(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>
            {audioInputs.map(dev => {
              const isCurrent = activeMic?.deviceId === dev.deviceId || (activeMic?.label && activeMic.label === dev.label);
              return (
                <button
                  key={dev.deviceId}
                  type="button"
                  onClick={async () => {
                    if (!recorderRef.current) recorderRef.current = new Mp3VoiceRecorder();
                    const next = await recorderRef.current.switchMic(dev).catch(() => null);
                    setActiveMic(next || dev);
                    await window.correctorAPI?.saveMic(next || dev);
                    setShowMicMenu(false);
                    flashStatus(`المايك: ${(next || dev).label}`, 2800);
                  }}
                  className={`w-full text-right px-2 py-1.5 rounded-lg text-[11px] flex items-center justify-between gap-2 ${
                    isCurrent ? 'bg-emerald-600/30 text-emerald-200 font-bold' : 'hover:bg-white/10 text-slate-200'
                  }`}
                  title={dev.label}
                >
                  <span className="truncate">{dev.label}</span>
                  {isCurrent && <Check size={12} className="text-emerald-400 shrink-0" />}
                </button>
              );
            })}
          </div>
        )}

        {/* Main Controls */}
        <div className="flex items-center gap-1.5 my-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggleRecording()}
            className={`flex-1 min-w-0 py-2 px-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
              isRecording
                ? 'bg-rose-600 hover:bg-rose-500 text-white animate-pulse shadow-lg shadow-rose-600/30'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
            }`}
          >
            {isRecording ? <Square size={14} fill="currentColor" /> : <Mic size={15} />}
            <span className="truncate">{isRecording ? `إيقاف (${recordSeconds}ث)` : 'تسجيل (F20)'}</span>
          </button>

          <button
            type="button"
            disabled={busy || isRecording || clipsCount === 0}
            onClick={() => void handleUndoLast()}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-slate-200 shrink-0"
            title="تراجع عن آخر تسجيل (F22)"
          >
            <RotateCcw size={14} />
          </button>

          <button
            type="button"
            disabled={busy || isRecording || redoCount === 0}
            onClick={() => void handleRedoLast()}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-slate-200 shrink-0"
            title="إعادة التسجيل المتراجع عنه (F21)"
          >
            <RotateCw size={14} />
          </button>

          <button
            type="button"
            disabled={busy || isRecording}
            onClick={() => void openReviewModal()}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-sky-300 shrink-0"
            title="معاينة وتعديل المواضع"
          >
            <Eye size={14} />
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleExport('web_link')}
            className="py-2 px-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-35 text-slate-950 font-bold text-xs flex items-center gap-1 shrink-0"
            title="إنهاء ونسخ رابط المصحف الصوتي (F17)"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            <span>رابط</span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleExport('html')}
            className="p-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-amber-300 shrink-0"
            title="حفظ ونسخ ملف HTML تفاعلي"
          >
            <FileCode2 size={14} />
          </button>
        </div>

        {/* Footer Info Line */}
        <div className="flex items-center justify-between text-[11px] text-slate-400 px-0.5">
          <span className="font-semibold text-emerald-300 truncate">{statusMsg || (selectedStudent.sourcePdfPath ? 'جاهز — مرتبط بالمصحف' : 'توجيه يدوي / جاهز للتسجيل')}</span>
          <span className="shrink-0 font-bold text-slate-200">التسجيلات: {clipsCount}</span>
        </div>
      </div>
    </div>
  );
}
