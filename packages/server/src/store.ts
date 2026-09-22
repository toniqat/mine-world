import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Session, type SessionSave } from '@mine/core';

/** Sessions on disk: one JSON file per session in `dir`, written through a temp file so a crash never leaves half a save. */
export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  loadAll(): Session[] {
    const out: Session[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(Session.fromSave(JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as SessionSave));
      } catch (e) {
        console.warn(`skipping unreadable session ${f}:`, e);
      }
    }
    return out;
  }

  save(s: Session): void {
    const file = join(this.dir, `${s.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(s.toSave()));
    renameSync(`${file}.tmp`, file);
  }

  remove(id: string): void {
    rmSync(join(this.dir, `${id}.json`), { force: true });
  }
}
