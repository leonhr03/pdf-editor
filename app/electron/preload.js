const { ipcRenderer } = require('electron');

const pendingSaves = new Map();

window.__saveDone = (id, ok, err, file) => {
  const cb = pendingSaves.get(id);
  if (!cb) return;
  pendingSaves.delete(id);
  if (ok) {
    cb.resolve(file || '');
  } else {
    const error = new Error(err || 'cancelled');
    error.code = 'declined';
    cb.reject(error);
  }
};

window.claude = {
  use: () => Promise.resolve({
    save(opts) {
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2) + Date.now();
        pendingSaves.set(id, { resolve, reject });
        try {
          const bytes = Buffer.from(opts.data);
          ipcRenderer.send('save', {
            id,
            filename: opts.filename || 'dokument.pdf',
            mode: opts.mode || 'overwrite',
            b64: bytes.toString('base64'),
            tab: window.__activeTabId ? window.__activeTabId() : ''
          });
        } catch (error) {
          pendingSaves.delete(id);
          reject(error);
        }
      });
    }
  })
};

// Einstellungen und Updates
const updateListeners = new Set();
ipcRenderer.on('update-status', (_event, state) => {
  updateListeners.forEach((fn) => { try { fn(state); } catch (_) {} });
});
window.pdfApp = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch || {}),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  openWebsite: () => ipcRenderer.invoke('open-website'),
  onUpdate: (fn) => { updateListeners.add(fn); return () => updateListeners.delete(fn); }
};

const post = (channel) => (payload) => ipcRenderer.send(channel, payload);

window.webkit = {
  messageHandlers: {
    save: { postMessage: post('save') },
    opened: { postMessage: post('opened') },
    tabclosed: { postMessage: post('tabclosed') },
    pick: { postMessage: post('pick') },
    pickimages: { postMessage: post('pickimages') }
  }
};
