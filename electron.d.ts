export {};

declare global {
  interface Window {
    correctorAPI: {
      platform: string;
      initialMode: 'pill' | 'bar';
      resize: (bounds: { width: number; height: number; anchorSide?: 'edge' | 'center' }) => Promise<{ ok: boolean }>;
      snapEdge: () => Promise<{ ok: boolean; side?: 'left' | 'right' }>;
      listStudents: () => Promise<Array<{ id: string; name: string; academy: string; sourcePdfPath: string }>>;
      detectActiveStudent: () => Promise<{
        detected: { studentId: string; studentName: string; sourcePdfPath: string; detectedTitle: string } | null;
        foreground?: boolean;
        rawTitle?: string;
      }>;
      openOutputFolder: () => Promise<{ ok: boolean }>;
      loadOrCreateSession: (payload: { studentId?: string; studentName?: string; sourcePdfPath?: string; dateStr?: string }) => Promise<any>;
      addClip: (payload: { sessionKey: string; audioBytes: number[]; ext?: string; startedAt: number; endedAt: number; durationMs: number }) => Promise<any>;
      removeClip: (payload: { sessionKey: string; clipId?: string | null }) => Promise<any>;
      redoClip: (payload: { sessionKey: string }) => Promise<any>;
      updatePin: (payload: { sessionKey: string; clipId: string; pdfPage: number; xPercent: number; yPercent: number }) => Promise<any>;
      matchAnnotations: (payload: { sessionKey: string; sourcePdfPath?: string; autoSave?: boolean }) => Promise<any>;
      renderPages: (payload: { sourcePdfPath: string; pageNumbers: number[]; scale?: number }) => Promise<{ success: boolean; error?: string; images: Record<string, { imageDataUrl: string; width: number; height: number }> }>;
      clipDataUrl: (payload: { sessionKey: string; fileName: string }) => Promise<string>;
      exportSession: (payload: { sessionKey: string; sourcePdfPath?: string; mode: 'web_link' | 'html'; language?: 'ar' | 'en'; autoSave?: boolean }) => Promise<any>;
      onShortcut: (cb: (action: 'toggle-record' | 'undo-last' | 'redo-last' | 'finish-export') => void) => () => void;
    };
  }
}
