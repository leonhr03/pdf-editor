'use strict';

const {
  app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, protocol, shell
} = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { PNG } = require('pngjs');
const UTIF = require('utif');
const heicDecode = require('heic-decode');
const { Updater, WEBSITE } = require('./updater');

const APP_NAME = 'PDF-Editor';
const SCHEME = 'pdfedit';
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const ICON_PATH = path.join(__dirname, 'icon.png');
const PDF_EXT = new Set(['.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.heic', '.heif']);

app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: 'Copyright © 2026 Leon'
});

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

let win = null;
let tray = null;
let pageReady = false;
let lastDir = '';
let quitting = false;
const tabURLs = new Map();
const pickedFiles = new Map();
const pendingPDFs = [];
const pendingImages = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Einstellungen, die der Nutzer im Einstellungsfenster ändern kann
const DEFAULTS = {
  theme: 'system',          // system | light | dark
  autoUpdate: true,         // beim Start nach Updates suchen
  saveShortcut: 'overwrite',// ⌘S: overwrite | as
  fontSize: 11,             // Standard-Schriftgröße für Text und Textfelder
  textColor: '#111111'      // Standard-Textfarbe
};
let settings = { ...DEFAULTS };

function cleanSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (['system', 'light', 'dark'].includes(input.theme)) out.theme = input.theme;
  if (typeof input.autoUpdate === 'boolean') out.autoUpdate = input.autoUpdate;
  if (['overwrite', 'as'].includes(input.saveShortcut)) out.saveShortcut = input.saveShortcut;
  const size = Number(input.fontSize);
  if (Number.isFinite(size) && size >= 6 && size <= 48) out.fontSize = size;
  if (typeof input.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.textColor)) out.textColor = input.textColor;
  return out;
}

function writeSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings, lastDirectory: lastDir }, null, 2));
  } catch (_) {}
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (data && typeof data.lastDirectory === 'string') lastDir = data.lastDirectory;
    settings = { ...DEFAULTS, ...cleanSettings(data) };
  } catch (_) {}
  nativeTheme.themeSource = settings.theme;
}

function rememberDirectory(dir) {
  if (!dir || dir === lastDir) return;
  lastDir = dir;
  writeSettings();
}

const updater = new Updater((state) => {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', state);
});

function fileIcon() {
  try { return nativeImage.createFromBuffer(fs.readFileSync(ICON_PATH)); }
  catch (_) { return nativeImage.createEmpty(); }
}

function runJS(code) {
  if (!win || win.isDestroyed() || !pageReady) return;
  win.webContents.executeJavaScript(code).catch((error) => {
    console.error('Renderer error:', error.message);
  });
}

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: APP_NAME,
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : {}),
    icon: process.platform === 'darwin' ? undefined : ICON_PATH,
    backgroundColor: dark ? '#1b1b1d' : '#ececef',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; pageReady = false; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(SCHEME + '://')) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  win.webContents.on('did-start-loading', () => { pageReady = false; });
  win.webContents.on('did-finish-load', onPageReady);

  win.loadURL(SCHEME + '://app/index.html');
}

function onPageReady() {
  pageReady = true;
  const pdfs = pendingPDFs.splice(0);
  const images = pendingImages.splice(0);
  if (pdfs.length) sendFiles(pdfs, false);
  if (images.length) sendImages(images);
}

function installProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const file = path.resolve(WEB_ROOT, '.' + rel);
      if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      const data = await fsp.readFile(file);
      return new Response(data, {
        headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }
      });
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  });
}

function collectPaths(args, cwd = process.cwd()) {
  const out = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) continue;
    const ext = path.extname(arg).toLowerCase();
    if (!PDF_EXT.has(ext) && !IMAGE_EXT.has(ext)) continue;
    const full = path.resolve(cwd, arg);
    try {
      if (fs.statSync(full).isFile()) out.push(full);
    } catch (_) {}
  }
  return out;
}

function handleIncoming(paths) {
  if (!paths.length) return;
  const pdfs = paths.filter((p) => PDF_EXT.has(path.extname(p).toLowerCase()));
  const images = paths.filter((p) => IMAGE_EXT.has(path.extname(p).toLowerCase()));
  if (!pageReady || !win) {
    pendingPDFs.push(...pdfs);
    pendingImages.push(...images);
    return;
  }
  if (pdfs.length) sendFiles(pdfs, false);
  if (images.length) sendImages(images);
}

function updateLastDirFrom(file) {
  rememberDirectory(path.dirname(file));
}

function sendFiles(paths, append) {
  const files = [];
  for (const file of paths) {
    if (!PDF_EXT.has(path.extname(file).toLowerCase())) continue;
    try {
      const data = fs.readFileSync(file);
      files.push({ name: path.basename(file), b64: data.toString('base64') });
      pickedFiles.set(path.basename(file), file);
    } catch (error) {
      dialog.showMessageBox(win, {
        type: 'error',
        message: 'Datei konnte nicht gelesen werden',
        detail: path.basename(file) + '\n' + error.message
      });
    }
  }
  if (!files.length) return;
  updateLastDirFrom(paths[0]);
  runJS('window.__openFiles(' + JSON.stringify({ append: !!append, files }) + ')');
}

function encodePng(width, height, rgba) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png);
}

async function loadImage(file) {
  const direct = nativeImage.createFromPath(file);
  if (!direct.isEmpty()) return direct;

  const ext = path.extname(file).toLowerCase();
  const buffer = await fsp.readFile(file);

  try {
    if (ext === '.heic' || ext === '.heif') {
      const decoded = await heicDecode({ buffer });
      return nativeImage.createFromBuffer(encodePng(decoded.width, decoded.height, decoded.data));
    }

    if (ext === '.tif' || ext === '.tiff') {
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const pages = UTIF.decode(arrayBuffer);
      if (!pages.length) return null;
      UTIF.decodeImage(arrayBuffer, pages[0]);
      const width = pages[0].width;
      const height = pages[0].height;
      const rgba = UTIF.toRGBA8(pages[0]);
      return nativeImage.createFromBuffer(encodePng(width, height, rgba));
    }
  } catch (error) {
    console.error('Bilddekodierung fehlgeschlagen:', error.message);
  }

  return null;
}

async function pngItemFromImage(file) {
  const original = await loadImage(file);
  if (!original || original.isEmpty()) return null;
  const size = original.getSize();
  if (!size.width || !size.height) return null;
  const scale = Math.min(1, 2000 / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const image = scale < 1 ? original.resize({ width, height, quality: 'best' }) : original;
  const png = image.toPNG();
  if (!png.length) return null;
  return {
    name: path.basename(file, path.extname(file)) + '.pdf',
    b64: png.toString('base64'),
    w: width,
    h: height
  };
}

async function sendImages(paths) {
  const items = [];
  for (const file of paths) {
    try {
      const item = await pngItemFromImage(file);
      if (item) items.push(item);
    } catch (error) {
      console.error('Bild konnte nicht gelesen werden:', file, error.message);
    }
  }
  if (!items.length) {
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'Bild konnte nicht gelesen werden',
      detail: 'Unterstützt werden PNG, JPEG, HEIC, TIFF, WebP, GIF und BMP.'
    });
    return;
  }
  updateLastDirFrom(paths[0]);
  runJS('window.__imageFiles(' + JSON.stringify(items) + ')');
}

function defaultSavePath(filename) {
  const name = filename || 'Unbenannt.pdf';
  if (lastDir) return path.join(lastDir, name);
  return path.join(app.getPath('downloads'), name);
}

function quote(value) {
  return JSON.stringify(String(value || ''));
}

// Freien Dateinamen finden: „Name (2).pdf“, „Name (3).pdf“, …
function uniquePath(file) {
  const dir = path.dirname(file);
  const ext = path.extname(file) || '.pdf';
  const base = path.basename(file, path.extname(file)).replace(/ \(\d+\)$/, '');
  for (let n = 2; n < 10000; n++) {
    const candidate = path.join(dir, base + ' (' + n + ')' + ext);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, base + ' (' + Date.now() + ')' + ext);
}

async function saveToFile(file, data) {
  await fsp.writeFile(file, data);
}


function registerIpc() {

  ipcMain.handle('settings-get', () => ({
    ...settings,
    version: app.getVersion(),
    platform: process.platform,
    website: WEBSITE,
    update: updater.state
  }));

  ipcMain.handle('settings-set', (_event, patch) => {
    settings = { ...settings, ...cleanSettings(patch) };
    nativeTheme.themeSource = settings.theme;
    writeSettings();
    return settings;
  });

  ipcMain.handle('update-check', () => updater.check());
  ipcMain.handle('update-download', () => updater.download());
  ipcMain.handle('update-install', () => updater.install());
  ipcMain.handle('open-website', () => shell.openExternal(WEBSITE));

  ipcMain.on('save', async (_event, body) => {
    if (!body || typeof body !== 'object') return;
    const id = body.id;
    const tab = body.tab || '';
    const filename = body.filename || 'Unbenannt.pdf';
    // overwrite = in die geöffnete Datei, new = Kopie daneben, as = Dialog
    const mode = ['overwrite', 'new', 'as'].includes(body.mode) ? body.mode : 'overwrite';
    if (!id) return;

    const reply = (ok, error, file) => {
      runJS('window.__saveDone(' + quote(id) + ',' + (ok ? 'true' : 'false') + ',' + quote(error) + ',' + quote(file ? path.basename(file) : '') + ')');
    };

    let data;
    try {
      data = Buffer.from(body.b64 || '', 'base64');
    } catch (_) {
      reply(false, 'Die PDF-Daten konnten nicht gelesen werden.');
      return;
    }

    const current = tab && tabURLs.has(tab) ? tabURLs.get(tab) : '';

    if (mode === 'overwrite' && current) {
      try {
        await saveToFile(current, data);
        updateLastDirFrom(current);
        reply(true, '', current);
      } catch (error) {
        reply(false, error.message);
      }
      return;
    }

    if (mode === 'new') {
      const file = current ? uniquePath(current) : (fs.existsSync(defaultSavePath(filename)) ? uniquePath(defaultSavePath(filename)) : defaultSavePath(filename));
      try {
        await saveToFile(file, data);
        if (tab) tabURLs.set(tab, file);
        updateLastDirFrom(file);
        reply(true, '', file);
      } catch (error) {
        reply(false, error.message);
      }
      return;
    }

    if (!win) {
      reply(false, 'Kein Fenster');
      return;
    }

    let result;
    try {
      result = await dialog.showSaveDialog(win, {
        title: mode === 'as' ? 'PDF speichern unter' : 'PDF speichern',
        defaultPath: current || defaultSavePath(filename),
        buttonLabel: 'Speichern',
        filters: [{ name: 'PDF-Dokument', extensions: ['pdf'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });
    } catch (error) {
      reply(false, error.message);
      return;
    }

    if (result.canceled || !result.filePath) {
      reply(false, 'declined');
      return;
    }

    let file = result.filePath;
    if (!path.extname(file)) file += '.pdf';

    try {
      await saveToFile(file, data);
      if (tab) tabURLs.set(tab, file);
      updateLastDirFrom(file);
      reply(true, '', file);
    } catch (error) {
      reply(false, error.message);
    }
  });

  ipcMain.on('opened', (_event, body) => {
    if (!body || typeof body !== 'object') return;
    const filename = body.name || '';
    const tab = body.tab || '';
    const append = !!body.append;
    if (!tab) return;
    if (!append) {
      if (pickedFiles.has(filename)) {
        tabURLs.set(tab, pickedFiles.get(filename));
        pickedFiles.delete(filename);
      } else {
        tabURLs.delete(tab);
      }
    } else if (!tabURLs.has(tab) && pickedFiles.has(filename)) {
      tabURLs.set(tab, pickedFiles.get(filename));
      pickedFiles.delete(filename);
    }
    if (tabURLs.has(tab)) updateLastDirFrom(tabURLs.get(tab));
  });

  ipcMain.on('tabclosed', (_event, body) => {
    if (body && body.tab) tabURLs.delete(body.tab);
  });

  ipcMain.on('pick', (_event, body) => {
    chooseFiles({ append: !!(body && body.append), images: false });
  });

  ipcMain.on('pickimages', () => {
    chooseFiles({ append: false, images: true });
  });
}

async function chooseFiles({ append, images }) {
  if (!win) showWindow();
  if (!win) return;

  const options = {
    title: images ? 'Bild zu PDF' : (append ? 'PDF anhängen' : 'PDF öffnen'),
    buttonLabel: images ? 'Umwandeln' : (append ? 'Anhängen' : 'Öffnen'),
    defaultPath: lastDir || app.getPath('downloads'),
    properties: ['openFile', 'multiSelections'],
    filters: images
      ? [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif'] }]
      : [{ name: 'PDF-Dokumente', extensions: ['pdf'] }]
  };

  let result;
  try {
    result = await dialog.showOpenDialog(win, options);
  } catch (_) {
    return;
  }
  if (result.canceled || !result.filePaths.length) return;

  if (images) {
    sendImages(result.filePaths);
  } else {
    const pdfs = result.filePaths.filter((p) => PDF_EXT.has(path.extname(p).toLowerCase()));
    sendFiles(pdfs, append);
  }
}

function docAction(code) {
  return () => {
    if (!win) {
      createWindow();
      return;
    }
    showWindow();
    runJS(code);
  };
}

function aboutDialog() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Über PDF-Editor',
    message: 'PDF-Editor',
    detail: 'Version ' + app.getVersion() + '\nPDFs ausfüllen, unterschreiben, markieren und verwalten.'
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];

  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { label: 'Über PDF-Editor', role: 'about' },
        { label: 'Nach Updates suchen …', click: docAction("openSettings('updates',true)") },
        { type: 'separator' },
        { label: 'Einstellungen …', accelerator: 'Cmd+,', click: docAction('openSettings()') },
        { type: 'separator' },
        { label: 'PDF-Editor ausblenden', role: 'hide' },
        { label: 'Andere ausblenden', role: 'hideOthers' },
        { label: 'Alle einblenden', role: 'unhide' },
        { type: 'separator' },
        { label: 'PDF-Editor beenden', role: 'quit' }
      ]
    });
  }

  template.push({
    label: 'Ablage',
    submenu: [
      { label: 'PDF öffnen …', accelerator: 'CmdOrCtrl+O', click: () => chooseFiles({ append: false, images: false }) },
      { label: 'PDF anhängen …', accelerator: 'CmdOrCtrl+Shift+O', click: () => chooseFiles({ append: true, images: false }) },
      { label: 'Neue leere PDF', accelerator: 'CmdOrCtrl+N', click: docAction('newDocument(false)') },
      { label: 'Liniertes Blatt', accelerator: 'CmdOrCtrl+Shift+N', click: docAction('newDocument(true)') },
      { label: 'Bild zu PDF …', click: () => chooseFiles({ append: false, images: true }) },
      { type: 'separator' },
      { label: 'Neuer Tab', accelerator: 'CmdOrCtrl+T', click: docAction('newTab()') },
      { label: 'Speichern', accelerator: 'CmdOrCtrl+S', click: docAction("savePDF('primary')") },
      { label: 'Als neue Datei speichern', accelerator: 'CmdOrCtrl+Alt+S', click: docAction("savePDF('new')") },
      { label: 'Speichern unter …', accelerator: 'CmdOrCtrl+Shift+S', click: docAction("savePDF('as')") },
      { type: 'separator' },
      { label: 'Tab schließen', accelerator: 'CmdOrCtrl+W', click: docAction('closeActiveTab()') },
      { label: 'Fenster schließen', accelerator: 'CmdOrCtrl+Shift+W', click: () => { if (win) win.close(); } },
      ...(isMac ? [] : [{ type: 'separator' }, { label: 'PDF-Editor beenden', accelerator: 'Ctrl+Q', click: () => app.quit() }])
    ]
  });

  template.push({
    label: 'Bearbeiten',
    submenu: [
      { label: 'Ausschneiden', role: 'cut' },
      { label: 'Kopieren', role: 'copy' },
      { label: 'Einsetzen', role: 'paste' },
      { label: 'Alles auswählen', role: 'selectAll' },
      ...(isMac ? [] : [{ type: 'separator' }, { label: 'Einstellungen …', accelerator: 'Ctrl+,', click: docAction('openSettings()') }])
    ]
  });

  template.push({
    label: 'Darstellung',
    submenu: [
      { label: 'Vergrößern', accelerator: 'CmdOrCtrl+=', click: docAction("document.getElementById('zi').click()") },
      { label: 'Verkleinern', accelerator: 'CmdOrCtrl+-', click: docAction("document.getElementById('zo').click()") },
      { label: 'Einpassen', accelerator: 'CmdOrCtrl+0', click: docAction('fit()') },
      { type: 'separator' },
      { label: 'Vollbild', role: 'togglefullscreen' }
    ]
  });

  if (isMac) {
    template.push({
      label: 'Fenster',
      submenu: [
        { label: 'Minimieren', role: 'minimize' },
        { label: 'Zoomen', role: 'zoom' },
        { type: 'separator' },
        { label: 'Alle Fenster in den Vordergrund', role: 'front' }
      ]
    });
  } else {
    template.push({
      label: 'Fenster',
      submenu: [
        { label: 'Minimieren', role: 'minimize' },
        { label: 'Fenster schließen', click: () => { if (win) win.close(); } }
      ]
    });
    template.push({
      label: 'Hilfe',
      submenu: [
        { label: 'Nach Updates suchen …', click: docAction("openSettings('updates',true)") },
        { label: 'Website öffnen', click: () => shell.openExternal(WEBSITE) },
        { type: 'separator' },
        { label: 'Über PDF-Editor', click: aboutDialog }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  try {
    const source = fileIcon();
    if (source.isEmpty()) return;
    const size = process.platform === 'darwin' ? 18 : 20;
    const icon = source.resize({ width: size, height: size, quality: 'best' });
    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Fenster anzeigen', click: showWindow },
      { type: 'separator' },
      { label: 'Neue leere PDF', click: docAction('newDocument(false)') },
      { label: 'Liniertes Blatt', click: docAction('newDocument(true)') },
      { label: 'Bild zu PDF …', click: () => chooseFiles({ append: false, images: true }) },
      { label: 'Neuer Tab', click: docAction('newTab()') },
      { type: 'separator' },
      { label: 'PDF öffnen …', click: () => chooseFiles({ append: false, images: false }) },
      { label: 'PDF anhängen …', click: () => chooseFiles({ append: true, images: false }) },
      { type: 'separator' },
      { label: 'Einstellungen …', click: docAction('openSettings()') },
      { label: 'PDF-Editor beenden', click: () => app.quit() }
    ]));
  } catch (error) {
    console.warn('Tray konnte nicht erstellt werden:', error.message);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const paths = collectPaths(argv.slice(1), workingDirectory || process.cwd());
    if (!win) createWindow();
    showWindow();
    if (paths.length) handleIncoming(paths);
  });

  app.on('open-file', (event, file) => {
    event.preventDefault();
    handleIncoming([file]);
  });

  app.whenReady().then(() => {
    installProtocol();
    loadSettings();
    registerIpc();
    createWindow();
    buildMenu();
    setupTray();
    const initial = collectPaths(process.argv.slice(1));
    if (initial.length) handleIncoming(initial);
    if (settings.autoUpdate && app.isPackaged) setTimeout(() => updater.check(), 4000);
  });

  app.on('activate', () => {
    if (!win) createWindow();
    else showWindow();
  });

  app.on('window-all-closed', () => {
    if (!quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
  });
}
