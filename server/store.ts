import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Tiny JSON-file key/value store — enough to remember the learner's last
// scenario/level/voice between sessions without a database.
export class JsonStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  read<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.file(key), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  write(key: string, value: unknown): void {
    writeFileSync(this.file(key), JSON.stringify(value, null, 2));
  }
}
