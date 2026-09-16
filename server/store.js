import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Tiny JSON-file key/value store — enough to remember the learner's last
// scenario/level/voice between sessions without a database.
export class JsonStore {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  _file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  read(key, fallback = null) {
    try {
      return JSON.parse(readFileSync(this._file(key), 'utf8'));
    } catch {
      return fallback;
    }
  }

  write(key, value) {
    writeFileSync(this._file(key), JSON.stringify(value, null, 2));
  }
}
