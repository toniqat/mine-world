import { BrowserWindow, app, nativeTheme, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Standalone shell for the web build. Development: loads the Vite dev server
 * (VITE_DEV_SERVER_URL). Otherwise loads packages/web/dist/index.html.
 * Game state lives in the renderer's IndexedDB, exactly as in the browser.
 *
 * Dev-only flags (used by automated visual checks):
 *   --exec=<file.js>        run the script in the page after load
 *   --screenshot=<file.png> capture the window ~2.5 s after load, then quit
 */
const here = __dirname;

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    title: 'Mine World',
    show: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) {
    void win.loadURL(dev);
    if (!arg('screenshot')) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(here, '..', '..', 'web', 'dist', 'index.html'));
  }

  const exec = arg('exec');
  const shot = arg('screenshot');
  if (exec || shot) {
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((r) => setTimeout(r, 1200));
        if (exec) await win.webContents.executeJavaScript(readFileSync(exec, 'utf8'));
        if (shot) {
          await new Promise((r) => setTimeout(r, 1500));
          const img = await win.webContents.capturePage();
          writeFileSync(shot, img.toPNG());
          app.quit();
        }
      } catch (e) {
        console.error('dev flag failed', e);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
