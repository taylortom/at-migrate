import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import prompts from 'prompts';
import Utils from './Utils.cjs';
import ZipEditor from './ZipEditor.js';

let LIMIT;
let IS_DEBUG;
export default class Importer {
  constructor(options) {
    IS_DEBUG = options.IS_DEBUG;
    LIMIT = options.LIMIT;
    this.exportData = {};
    this.importData = {
      sourcePath: options.sourcePath,
      exportPath: undefined,
      apiUrl: undefined,
      authToken: undefined,
      maps: {
        // legacy role name -> preferred v1 role shortName(s), in order; the first that exists in the
        // target is used to pre-select the mapping. later entries are the current v1 role names
        roleNames: {
          "Authenticated User": ["authuser", "reviewer"],
          "Course Creator": ["contentcreator", "author"],
          "Product Manager": ["contentcreator", "author"],
          "Super Admin": ["admin", "superuser", "siteadmin"],
          "Tenant Admin": ["admin", "superuser", "siteadmin"]
        },
        roleIds: {},
        userIds: {},
        presetIds: {}
      }
    };
    this.status = { success: [], error: [], skip: [], warn: [] };
    this.pluginBlacklist = {
      extensions: ['adapt-notepad']
    }
  }
  async init() {
    debug('init', this.importData.sourcePath);    
    let migratePath = this.importData.sourcePath;
    try {
      const nestedPath = path.join(migratePath, 'at-migrate'); // look for a nested at-migrate folder in case specified an AAT src
      if(fs.statSync(nestedPath, { throwIfNoEntry: false })) migratePath = nestedPath
    } catch {}
    debug('migratePath', migratePath);
    debug('readdirSync', fs.readdirSync(migratePath));
    const { exportId } = await prompts({
      type: 'select',
      name: 'exportId',
      message: `Choose an export to restore`,
      choices: fs.readdirSync(migratePath).map(f => Object.create({ title: f, value: f }))
    });
    this.importData.exportId = exportId
    this.importData.exportPath = path.join(migratePath, exportId)
    
    this.exportData = await Utils.loadJson(path.join(this.importData.exportPath, 'export.json'));

    // no import.json on a first run, so a failure here just means there's nothing to resume from
    try {
      this.importData = Object.assign(this.importData, await Utils.loadJson(path.join(this.importData.exportPath, 'import.json')));
    } catch(e) {
      debug('no existing import.json', e.message);
    }

    if(!this.importData.apiUrl) {
      const { apiUrl } = await prompts({
        type: 'text',
        name: 'apiUrl',
        message: `URL to the API`
      });
      this.importData.apiUrl = apiUrl;
    }
    if(!this.importData.apiUrl) {
      throw new Error('An API URL is required to import the data');
    }
    await this.checkAuth();

    try {
      const courses = (await Utils.requestAll('content/query', {
        ...this.importData, 
        method: 'POST', 
        body: JSON.stringify({ _type: 'course' }),
        headers: { 'Content-Type': 'application/json' }
      })).data;
      console.log(`Found ${courses.length} existing courses in the DB`);
      const titleMap = c => c.title.toString()
      const existingTitles = new Set(courses.map(titleMap));
      const exportedTitles = new Set(this.exportData.courses.map(titleMap));
      this.unImportedCourseTitles = Array.from(exportedTitles.difference(existingTitles));

      debug('DB course titles:', Array.from(existingTitles).sort());
      debug('Existing title count:', existingTitles.size);
      debug('Exported title count:', exportedTitles.size);
      debug('Un-imported course titles:', Array.from(this.unImportedCourseTitles).sort(), this.unImportedCourseTitles.length);

      const total = this.exportData.courses.length
      const completed = total - this.unImportedCourseTitles.length;
      const choices = []
      if(completed < total) {
        choices.push({ title: 'Continue', value: 'Continue' })
      }
      choices.push({ title: 'Restart', value: 'Restart' }, { title: 'Exit', value: 'Exit' })

      const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: `Existing import data found (${completed}/${total} courses imported), how do you want to proceed?`,
        choices
      });
      if(action === 'Restart') {
        console.log('Existing import data will be cleared');
        this.status = { success: [], error: [], skip: [], warn: [] };
        this.unImportedCourseTitles = this.exportData.courses.slice().map(c => c.title);
      }
      if(action === 'Exit') {
        console.log('Import cancelled');
        process.exit();
      }
    } catch(e) {
      // couldn't work out what's already there, so fall back to attempting every course
      log('fail', 0, `Couldn't check for existing courses, all courses will be attempted: ${e.message}`);
      debug(e.stack);
    }
    if(!this.unImportedCourseTitles) {
      this.unImportedCourseTitles = this.exportData.courses.map(c => c.title);
    }

    await this.saveMetadata();
  }
  async run() {
    try {
      await this.importUsers();
      await this.saveMetadata();
      try {
        await this.importThemePresets();
      } catch(e) {
        this.warn(null, `Theme preset import failed, courses will still be imported: ${e.message}`);
      }
      await this.saveMetadata();
      await this.importCourses();
      await this.saveMetadata();
      return this.status;
    } catch(e) {
      log('error', 0, e);
      process.exit();
    }
  }

  async checkAuth() {
    try {
      if(!this.importData.authToken) {
        throw new Error('AUTH_TOKEN_MISSING: Authentication token missing');
      }
      const res = await Utils.request('auth/check', this.importData);
      if(res.status === 200) log('success', 0, `Successfully authenticated as ${res.data.user.email} [${res.data.scopes}]`);
    } catch(e) {
      log('fail', 0, `Auth check failed, ${e}`)
      if(!e.message.includes('AUTH_TOKEN_MISSING') && !e.message.includes('AUTH_TOKEN_EXPIRED')) {
        return process.exit()
      }
      const { authToken } = await prompts({
        type: 'text',
        name: 'authToken',
        message: `An auth token is required to import the data, please enter it now`
      });
      this.importData.authToken = authToken;
      await this.saveMetadata();
    }
  }

  async importUsers() {
    if(!this.exportData.users.length) {
      return console.log('No users to import');
    }
    const { data: existingRoles } = await Utils.requestAll('roles', this.importData);
    const { data: existingUsers } = await Utils.requestAll('users', this.importData);

    if(!Object.keys(this.importData.maps.roleIds).length) {
      // a system role is assigned by v1 itself and can't be given to anyone, not even by a super user
      const assignableRoles = existingRoles.filter(r => !r.isSystem);
      const rolesChoices = assignableRoles.map(r => {
        return { title: r.displayName, value: r._id };
      });
      console.log('You will now be prompted to map the old roles to the new ones.');
  
      const promptData = await prompts(this.exportData.roles.map(r => {
        // pre-select the first preferred role (by shortName) that exists in the target, else the first choice
        const preferred = (this.importData.maps.roleNames[r.name] || []).find(shortName => assignableRoles.some(nr => nr.shortName === shortName));
        const initial = Math.max(0, assignableRoles.findIndex(nr => nr.shortName === preferred));
        return {
          type: 'select',
          name: r.name,
          message: `Choose a new role for all '${r.name}' users`,
          choices: rolesChoices,
          initial
        }
      }));
      Object.entries(promptData).forEach(([oldName, newId]) => {
        this.importData.maps.roleIds[this.exportData.roles.find(r => r.name === oldName)._id] = newId.toString();
      });
    }
    // import users
    console.log(`Attempting to import ${this.exportData.users.length} users`);
    
    // legacy installs before 0.11 didn't lower-case emails, so one person can have several records;
    // v1 emails are unique, so each group becomes one user with every legacy id mapped to it
    const usersByEmail = new Map();
    for(const u of this.exportData.users) {
      const key = u.email.toLowerCase();
      usersByEmail.set(key, [...(usersByEmail.get(key) ?? []), u]);
    }
    for(const [email, group] of usersByEmail) {
      if(group.length > 1) this.warn(null, `${group.length} legacy users share the email ${email}, merging them into one user`);
    }
    const total = usersByEmail.size;
    await Promise.all([...usersByEmail.values()].map(async (group, i) => {
      const [userData] = group;
      const progressStr = `${(i+1).toString().padStart(total.toString().length, '0')}/${total}`;
      const existingUser = existingUsers.find(u => u.email.toLowerCase() === userData.email.toLowerCase());
      if(existingUser) {
        log('skip', 1, `${progressStr} User '${userData.email} already exists, skipping`);
        group.forEach(u => { this.importData.maps.userIds[u._id] = existingUser._id; });
        return;
      }
      const { data: { _id } } = await Utils.request('auth/local/register', {
        ...this.importData,
        method: 'POST',
        body: JSON.stringify({
          email: userData.email,
          password: crypto.randomBytes(16).toString('hex'),
          firstName: userData.firstName,
          lastName: userData.lastName,
          // a v1 user holds a single role; left unset, it defaults to the most basic one
          role: this.getRoleId(group)
        }),
        headers: { 'Content-Type': 'application/json' }
      });
      log('success', 1, `${progressStr} Imported ${userData.email}`);
      group.forEach(u => { this.importData.maps.userIds[u._id] = _id; });
    }));
    console.log('');
  }

  /**
   * Picks the one role a v1 user can hold from every role its legacy records had, preferring the most senior
   * @param {Array<Object>} group Legacy users sharing an email
   * @return {String|undefined} The mapped v1 role id
   */
  getRoleId(group) {
    const names = [...new Set(group.flatMap(u => u.roleNames ?? []))]
      .sort((a, b) => rolePriority(a) - rolePriority(b));
    for(const name of names) {
      // an export can name a role that no longer exists in it, or one left unmapped by the prompt
      const oldRole = this.exportData.roles.find(r => r.name === name);
      const newId = oldRole && this.importData.maps.roleIds[oldRole._id];
      if(newId) return newId;
      this.warn(null, `Could not map role '${name}' for ${group[0].email}, skipping it`);
    }
  }

  async importThemePresets() {
    const presets = this.exportData.themePresets || [];
    // map of old preset id -> properties, used to apply theme variables to courses (see importCourse)
    this.presetPropsById = new Map(presets.map(p => [p._id, p.properties || {}]));
    if(!presets.length) {
      return console.log('No theme presets to import');
    }
    // theme presets are now rows in the shared presets collection, keyed by title and theme
    const { data: existing } = await Utils.requestAll('presets', this.importData);
    const { data: plugins } = await Utils.requestAll('contentplugins', this.importData);
    const themes = plugins.filter(p => p.type === 'theme');
    const key = (title, parentTheme) => `${title}::${parentTheme}`;
    const existingByKey = new Map(existing.filter(p => p._type === 'themepreset').map(p => [key(p.title, p.parentTheme), p._id]));
    console.log(`Attempting to import ${presets.length} theme presets`);

    for(const preset of presets) {
      const title = decodeEntities(preset.displayName ?? '').slice(0, 60);
      const parentTheme = this.getThemeName(preset.parentTheme, themes);
      if(!parentTheme) {
        this.warn(null, `Theme preset '${title}' is for a theme that isn't installed (${preset.parentTheme}), skipping`);
        continue;
      }
      const existingId = existingByKey.get(key(title, parentTheme));
      if(existingId) {
        this.importData.maps.presetIds[preset._id] = existingId;
        log('skip', 1, `Theme preset '${title}' already exists, skipping`);
        continue;
      }
      try {
        const { data } = await Utils.request('presets', {
          ...this.importData,
          method: 'POST',
          // legacy presets were visible to everyone, where a v1 preset starts private to its creator;
          // sharing one with everyone needs the write:sitepresets scope
          body: JSON.stringify({ _type: 'themepreset', title, parentTheme, properties: preset.properties || {}, _access: { public: true } }),
          headers: { 'Content-Type': 'application/json' }
        });
        this.importData.maps.presetIds[preset._id] = data._id;
        existingByKey.set(key(title, parentTheme), data._id);
        log('success', 1, `Imported theme preset '${title}'`);
      } catch(e) {
        this.warn(null, `Theme preset '${title}' could not be imported, ${e.message}`);
      }
    }
    console.log('');
  }

  // legacy presets name the theme by its short key (e.g. 'vanilla'), v1 by its plugin name
  getThemeName(parentTheme, themes) {
    const theme = themes.find(t => t.name === parentTheme) ??
      themes.find(t => t.targetAttribute === `_${parentTheme}` || t.theme === parentTheme);
    return theme?.name;
  }

  async importCourses() {
    const toImportTotal = this.unImportedCourseTitles.length;
    if(!toImportTotal) {
      return console.log('No courses to import');
    }
    console.log(`Attempting to import ${toImportTotal} courses`);
    
    let done = 0;
    for (const course of this.exportData.courses) {
      if(LIMIT !== undefined && done === LIMIT) break;
      const progressStr = `${(done+1).toString().padStart(toImportTotal.toString().length, '0')}/${toImportTotal}`;
      try {
        if(!this.unImportedCourseTitles.includes(course.title)) {
          this.status.skip.push(course._id);
          log('skip', 1, `${progressStr} Course '${course.title}' (${course._id}) found, skipping`);
          continue;
        }
        console.log(`  - ${progressStr} Importing ${course._id} ${course.title}`);

        await this.importCourse(course);
        this.status.success.push(course._id);
        log('success', 2, 'Import successful');
      } catch(e) {
        log('fail', 2, `Import failed, ${e.message}`);
        debug(e.stack);
        e.courseId = course._id;
        this.status.error.push(e);
      }
      await this.saveMetadata();
      done++;
    }
    Object.entries(this.status).forEach(([key, value]) => {
      this.status[key] = [...new Set([...value, ...this.status[key]])];
    });
    console.log('');
  }

  /**
   * Records a non-fatal problem and logs it. Warnings are for data we couldn't migrate faithfully
   * but which didn't stop the import (dropped shares, unrestored owners): the inline log alone is
   * easy to miss in a long run, so they're also collected into the summary and saved to import.json.
   */
  warn(course, message) {
    this.status.warn.push({ courseId: course?._id, courseTitle: course?.title, message });
    log('warn', course ? 2 : 0, message);
  }

  async importCourse(course) {
    const zipPath = path.resolve(this.importData.exportPath, `${course._id}.zip`);
    if(!fs.statSync(zipPath, { throwIfNoEntry: false })) {
      throw new Error(`No zip found for course ${course._id} at ${zipPath}`);
    }
    // the course is uploaded, so the target needn't share a disk with this machine; edits go into
    // a copy of the zip rather than an unpacked tree, so its media is never decompressed
    const zip = await ZipEditor.copy(zipPath, path.join(os.tmpdir(), `at-migrate-${course._id}-${Date.now()}.zip`));
    try {
      const entries = await zip.list();
      const langDir = getLangDir(entries);
      const courseEntry = `${langDir}/course.json`;
      const courseJson = await zip.readJson(courseEntry);

      // add course attributes not included in export
      if(course.heroImage) {
        const filename = path.basename(course.heroImage);
        await zip.writeFile(`${langDir}/assets/${filename}`, path.join(this.importData.exportPath, course.heroImage));
        await this.addToAssetsJson(zip, entries, `${langDir}/assets.json`, filename);
        // the value written to course.json must be a forward-slash, src-relative Adapt asset path
        courseJson.heroImage = `course/en/assets/${filename}`;
      }
      // fall back to the course's theme preset by setting its variables directly on the course, so they
      // persist on insert (equivalent to the coursetheme apply route, which only sets themeVariables).
      // a course's own variables win: applying a preset copies it onto the course, so they hold any
      // changes made since. requires the preset's parentTheme to be installed in the target, else the
      // import will strip them.
      const themeVariables = !hasValues(courseJson.themeVariables) && course.themePreset && this.presetPropsById?.get(course.themePreset);
      if(themeVariables) {
        debug('theme preset:', course.themePreset, themeVariables);
        courseJson.themeVariables = themeVariables;
      }
      courseJson._access = this.getCourseAccess(course);
      await zip.writeJson(courseEntry, courseJson);
      await this.removeBlacklistedPlugins(zip, entries, path.posix.dirname(langDir));

      const data = await this.uploadCourse(zip.path);
      await this.restoreCourseOwner(course, data?.courseId);
    } finally {
      await zip.cleanUp();
    }
  }

  async uploadCourse(zipPath) {
    const form = new FormData();
    // openAsBlob streams from disk; older Node falls back to reading the zip into memory
    const file = fs.openAsBlob ? await fs.openAsBlob(zipPath) : new Blob([fs.readFileSync(zipPath)]);
    form.append('course', file, path.basename(zipPath));
    if(this.exportData.remote) {
      // remote bundles only carry a bower.json stub per plugin, which must never be installed: plugins
      // are expected to be on the target already, and any still missing are quarantined
      form.append('importPlugins', 'false');
      form.append('onMissingPlugins', 'quarantine');
    }
    const res = await Utils.request('adapt/import', { ...this.importData, method: 'POST', body: form });
    return res.data;
  }

  /**
   * Maps the legacy sharing fields onto the v1 course _access object:
   * _isShared -> _access.public, _shareWithUsers -> _access.users (see the v1
   * 4.0.0-data-backfill-course-access migration, which uses the same mapping).
   * Always returns a value, even for an unshared course: the course schema defaults
   * _access.public to true, so a course imported without _access is visible to everyone —
   * the opposite of the legacy default. The legacy fields themselves are deliberately not
   * sent; they're in no v1 schema, so the import sanitises them away.
   */
  getCourseAccess(course) {
    const shared = course._shareWithUsers ?? [];
    const users = shared.reduce((mapped, oldId) => {
      const newId = this.importData.maps.userIds[oldId.toString()];
      if(newId) mapped.push(newId.toString());
      else debug('dropping share with unknown user', oldId);
      return mapped;
    }, []);
    const dropped = shared.length - users.length;
    if(dropped) this.warn(course, `${dropped} of ${shared.length} shared user(s) couldn't be mapped and were dropped`);
    const access = { public: course._isShared === true, users };
    debug('access:', access);
    return access;
  }

  /**
   * Restores a course's original owner. The import API forces createdBy to the authenticated
   * user, so it can only be corrected with a follow-up patch (createdBy is honoured on write,
   * it's only defaulted when absent). Failure is logged rather than thrown: the course itself
   * has imported successfully by this point, and throwing would mark it for re-import.
   */
  async restoreCourseOwner(course, newCourseId) {
    if(!course.createdBy) {
      return debug('no createdBy exported for course', course._id);
    }
    if(!newCourseId) {
      return this.warn(course, `No course id returned by the API, owner '${course.createdBy}' not restored`);
    }
    // createdBy is exported as an email, but falls back to the raw user id if the export
    // couldn't resolve it (e.g. metadata written by a --no-courses run)
    const oldId = course.createdBy.includes('@')
      ? this.exportData.users.find(u => u.email.toLowerCase() === course.createdBy.toLowerCase())?._id
      : course.createdBy;
    const userId = oldId !== undefined && this.importData.maps.userIds[oldId.toString()];
    if(!userId) {
      return this.warn(course, `Couldn't map owner '${course.createdBy}', course will be owned by the importing user`);
    }
    try {
      await Utils.request(`content/${newCourseId}`, {
        ...this.importData,
        method: 'PATCH',
        body: JSON.stringify({ createdBy: userId.toString() }),
        headers: { 'Content-Type': 'application/json' }
      });
      log('success', 2, `Set owner to ${course.createdBy}`);
    } catch(e) {
      this.warn(course, `Failed to set owner to ${course.createdBy}, ${e.message}`);
    }
  }

  // v1 only imports the files an assets.json lists, so a hero that isn't also a course asset would be dropped
  async addToAssetsJson(zip, entries, entry, filename) {
    if(!entries.includes(entry)) return;
    const assetsJson = await zip.readJson(entry);
    if(assetsJson[filename]) return;
    assetsJson[filename] = { title: filename, description: filename };
    await zip.writeJson(entry, assetsJson);
  }

  async removeBlacklistedPlugins(zip, entries, courseDir) {
    const srcDir = path.posix.dirname(courseDir);
    const removed = [];
    for(const [type, plugins] of Object.entries(this.pluginBlacklist)) {
      for(const plugin of plugins) {
        if(await zip.delete(`${srcDir}/${type}/${plugin}/*`)) removed.push(plugin);
      }
    }
    if(!removed.length) return;
    // a plugin left in _enabledPlugins but present in neither the import nor the target
    // fails the whole import with FW_IMPORT_MISSING_PLUGINS
    const configEntry = `${courseDir}/config.json`;
    if(!entries.includes(configEntry)) return;
    const config = await zip.readJson(configEntry);
    if(!Array.isArray(config._enabledPlugins)) return;
    const enabledPlugins = config._enabledPlugins.filter(p => !removed.includes(p));
    if(enabledPlugins.length === config._enabledPlugins.length) return;
    await zip.writeJson(configEntry, { ...config, _enabledPlugins: enabledPlugins });
    debug('de-listed blacklisted plugins from config._enabledPlugins', removed);
  }

  async saveMetadata() {
    return Utils.writeJson(path.join(this.importData.exportPath, 'import.json'), { ...this.importData, status: this.status });
  }
}

function log(type, indentLevel, message) {
  let icon = '';
  switch(type) {
    case 'success':
      icon = chalk.green('√');
      break;
    case 'fail':
      icon = chalk.red('×');
      break;
    case 'skip':
      icon = chalk.blue('~');
      break;
    case 'warn':
      icon = chalk.yellow('!');
      break;
    case 'error':
      icon = chalk.red('!');
      message = chalk.red(message);
  }
  console.log(`${' '.repeat(2*indentLevel)}${icon} ${message}`);
}

// the course's language folder, wherever the zip roots the framework (exports may nest it one level down)
function getLangDir(entries) {
  const entry = entries.find(e => /(^|\/)src\/course\/en\/course\.json$/.test(e));
  if(!entry) throw new Error('No src/course/en/course.json found in the course zip');
  return path.posix.dirname(entry);
}

// legacy roles, most senior first; anything unlisted ranks below them
const ROLE_PRIORITY = ['Super Admin', 'Tenant Admin', 'Product Manager', 'Course Creator', 'Authenticated User'];

function rolePriority(name) {
  const i = ROLE_PRIORITY.indexOf(name);
  return i === -1 ? ROLE_PRIORITY.length : i;
}

// legacy stored preset names HTML-escaped
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
}

function hasValues(value) {
  if(value && typeof value === 'object') return Object.values(value).some(hasValues);
  return value !== undefined && value !== null && value !== '';
}

function debug(...args) {
  if(IS_DEBUG) console.log('DEBUG::', ...args);
}