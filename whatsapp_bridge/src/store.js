import fsp from 'node:fs/promises';

/**
 * Tiny debounced, atomic JSON store. The bridge state is small (a few hundred
 * chats), so a single JSON file is plenty and survives restarts.
 */
export class JsonStore {
  constructor(file, { logger, debounceMs = 750 } = {}) {
    this.file = file;
    this.logger = logger;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.pending = null;
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      return JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger?.warn({ err }, 'could not read state file');
      }
      return null;
    }
  }

  save(data) {
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) =>
        this.logger?.warn({ err }, 'could not write state file'),
      );
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async flush() {
    if (!this.pending) return;
    const data = this.pending;
    this.pending = null;
    const tmp = `${this.file}.tmp`;
    this.writing = this.writing.then(async () => {
      await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    });
    await this.writing;
  }

  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
