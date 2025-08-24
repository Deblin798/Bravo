const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('convai', {
  openMain: () => ipcRenderer.invoke('open-main'),
  // Browser Agent controls
  startBrowserAgent: () => ipcRenderer.invoke('start-browser-agent'),
  sendToBrowserAgent: (message) => ipcRenderer.invoke('send-to-browser-agent', message),
  stopBrowserAgent: () => ipcRenderer.invoke('stop-browser-agent'),
  // Browser Agent events
  onBrowserAgentOutput: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('browser-agent-output', handler);
    return () => ipcRenderer.off('browser-agent-output', handler);
  },
  onBrowserAgentError: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('browser-agent-error', handler);
    return () => ipcRenderer.off('browser-agent-error', handler);
  },
  onBrowserAgentClosed: (callback) => {
    const handler = (event, code) => callback(code);
    ipcRenderer.on('browser-agent-closed', handler);
    return () => ipcRenderer.off('browser-agent-closed', handler);
  },
  // Delegate voice to Python agent only
  startVoiceMode: () => ipcRenderer.invoke('start-voice-mode'),
  stopVoiceMode: () => ipcRenderer.invoke('stop-voice-mode')
});


