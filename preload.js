const { contextBridge, ipcRenderer } = require('electron');

const modeArg = process.argv.find(a => a.startsWith('--hud-mode='));
const initialMode = modeArg && modeArg.split('=')[1] === 'pill' ? 'pill' : 'bar';

contextBridge.exposeInMainWorld('correctorAPI', {
    platform: process.platform,
    initialMode,
    resize: (bounds) => ipcRenderer.invoke('hud:resize', bounds),
    snapEdge: () => ipcRenderer.invoke('hud:snap-edge'),
    getHudState: () => ipcRenderer.invoke('hud:get-state'),
    showContextMenu: () => ipcRenderer.invoke('hud:show-context-menu'),
    hideToTray: () => ipcRenderer.invoke('hud:hide-to-tray'),
    saveMic: (payload) => ipcRenderer.invoke('hud:save-mic', payload),
    listStudents: () => ipcRenderer.invoke('hud:list-students'),
    detectActiveStudent: () => ipcRenderer.invoke('hud:detect-active-student'),
    openOutputFolder: () => ipcRenderer.invoke('hud:open-output-folder'),
    loadOrCreateSession: (payload) => ipcRenderer.invoke('session:load-or-create', payload),
    addClip: (payload) => ipcRenderer.invoke('session:add-clip', payload),
    removeClip: (payload) => ipcRenderer.invoke('session:remove-clip', payload),
    redoClip: (payload) => ipcRenderer.invoke('session:redo-clip', payload),
    updatePin: (payload) => ipcRenderer.invoke('session:update-pin', payload),
    matchAnnotations: (payload) => ipcRenderer.invoke('session:match-annotations', payload),
    renderPages: (payload) => ipcRenderer.invoke('session:render-pages', payload),
    clipDataUrl: (payload) => ipcRenderer.invoke('session:clip-data-url', payload),
    exportSession: (payload) => ipcRenderer.invoke('session:export', payload),
    onShortcut: (cb) => {
        const handler = (_event, action) => cb(action);
        ipcRenderer.on('hud-shortcut', handler);
        return () => ipcRenderer.removeListener('hud-shortcut', handler);
    },
});
