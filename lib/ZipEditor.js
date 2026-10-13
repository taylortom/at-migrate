import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);
// course zips can run to gigabytes of media, so listings and reads get a generous buffer
const MAX_BUFFER = 512 * 1024 * 1024;
// zip's exit code when a delete pattern matches nothing
const ZIP_NOTHING_TO_DO = 12;

/**
 * Edits entries in a copy of a zip in place, using the system zip/unzip tools so that
 * large media in the archive is never decompressed or held in memory
 */
export default class ZipEditor {
  /**
   * Copies a zip to a new location for editing
   * @param {String} source
   * @param {String} dest
   * @return {Promise<ZipEditor>}
   */
  static async copy(source, dest) {
    await fs.copyFile(source, dest);
    const editor = new ZipEditor(dest);
    editor.stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'at-migrate-stage-'));
    return editor;
  }

  constructor(zipPath) {
    this.path = zipPath;
  }

  /** @return {Promise<Array<String>>} Every entry name in the archive */
  async list() {
    const { stdout } = await run('unzip', ['-Z1', this.path], { maxBuffer: MAX_BUFFER });
    return stdout.split('\n').filter(Boolean);
  }

  async readJson(entry) {
    const { stdout } = await run('unzip', ['-p', this.path, entry], { maxBuffer: MAX_BUFFER });
    return JSON.parse(stdout);
  }

  async writeJson(entry, data) {
    await this.stage(entry, f => fs.writeFile(f, JSON.stringify(data, null, 2)));
  }

  async writeFile(entry, sourcePath) {
    await this.stage(entry, f => fs.copyFile(sourcePath, f));
  }

  // zip stores paths relative to its working directory, so mirror the entry name under a staging dir
  async stage(entry, write) {
    const staged = path.join(this.stageDir, entry);
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await write(staged);
    await run('zip', ['-q', this.path, entry], { cwd: this.stageDir });
  }

  /**
   * @param {String} pattern A zip wildcard, e.g. `src/extensions/foo/*`
   * @return {Promise<Boolean>} Whether anything was removed
   */
  async delete(pattern) {
    try {
      await run('zip', ['-q', '-d', this.path, pattern]);
      return true;
    } catch(e) {
      if(e.code === ZIP_NOTHING_TO_DO) return false;
      throw e;
    }
  }

  async cleanUp() {
    await fs.rm(this.stageDir, { recursive: true, force: true });
    await fs.rm(this.path, { force: true });
  }
}
