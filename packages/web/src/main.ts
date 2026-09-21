import { App } from './app';
import { loadSave } from './storage';

async function boot(): Promise<void> {
  const saved = await loadSave();
  const app = new App(saved);
  await app.start();
  (window as unknown as { mineWorld: App }).mineWorld = app;
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:16px;color:#f14c4c">${String(e?.stack ?? e)}</pre>`;
});
