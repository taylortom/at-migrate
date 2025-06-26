import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import Utils from './Utils.cjs';
import zipper from 'zipper';

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
        roleNames: {
          "Authenticated User": "authuser",
          "Course Creator": "contentcreator",
          "Product Manager": "contentcreator",
          "Super Admin": "superuser",
          "Tenant Admin": "superuser"
        }, 
        roleIds: {},
        userIds: {}
      }
    };
    this.status = { success: [], error: [], skip: [] };
    this.pluginBlacklist = {
      extensions: ['adapt-notepad']
    }
  }
  async init() {
    let migratePath = this.importData.sourcePath;
    try {
      const nestedPath = path.join(migratePath, 'at-migrate');
      if(fs.statSync(nestedPath, { throwIfNoEntry: false })) migratePath = nestedPath
    } catch {}
    const { exportId } = await prompts({
      type: 'select',
      name: 'exportId',
      message: `Choose an export to restore`,
      choices: fs.readdirSync(migratePath).map(f => Object.create({ title: f, value: f }))
    });
    this.importData.exportId = exportId
    this.importData.exportPath = path.join(migratePath, exportId)
    
    this.exportData = await Utils.loadJson(path.join(this.importData.exportPath, 'export.json'));
    try {
      this.importData = Object.assign(this.importData, await Utils.loadJson(path.join(this.importData.exportPath, 'import.json')));
      const completed = this.status.success.length + this.status.error.length;
      const total = this.exportData.courses.length
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
        this.status = { success: [], error: [], skip: [] };
      }
      if(action === 'Exit') {
        console.log('Import cancelled');
        process.exit();
      }
    } catch {}
    if(!this.importData.apiUrl) {
      const { apiUrl } = await prompts({
        type: 'text',
        name: 'apiUrl',
        message: `URL to the API`
      });
      this.importData.apiUrl = apiUrl;
    }
    if(!this.importData.authToken) {
      const { authToken } = await prompts({
        type: 'text',
        name: 'authToken',
        message: `An auth token is required to import the data, please enter it now`
      });
      this.importData.authToken = authToken;
    }
    await this.saveMetadata();
  }
  async run() {
    await this.checkAuth();
    await this.importUsers();
    await this.saveMetadata();
    await this.importCourses();
    await this.saveMetadata();
    return this.status;
  }

  async checkAuth() {
    try {
      const res = await Utils.request('auth/check', this.importData);
      if(res.status === 200) console.log(`✔  Successfully authenticated as ${res.data.user.email} [${res.data.scopes}]`);
    } catch(e) {
      console.log('✘ Auth check failed', e);
      process.exit()
    }
    console.log('');
  }

  async importUsers() {
    const { data: existingRoles } = await Utils.request('roles', this.importData);
    const { data: existingUsers } = await Utils.request('users', this.importData);

    if(!Object.keys(this.importData.maps.roleIds).length) {
      const rolesChoices = existingRoles.map(r => {
        return { title: r.displayName, value: r._id };
      });
      console.log('You will now be prompted to map the old roles to the new ones.');
  
      const promptData = await prompts(this.exportData.roles.map(r => {
        const initial = existingRoles.reduce((initial, nr, i) => {
          if(nr.shortName === this.importData.maps.roleNames[r.name]) initial = i;
          return initial;
        }, 0);
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
    
    await Promise.all(this.exportData.users.map(async userData => {
      const existingUser = existingUsers.find(u => u.email.toLowerCase() === userData.email.toLowerCase());
      if(existingUser) {
        console.log(`  - User ${userData.email} already exists, skipping`);
        this.importData.maps.userIds[userData._id] = existingUser._id;
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
          roles: userData.roleNames.map(r => {
            const oldId = this.exportData.roles.find(r2 => r2.name === r)._id
            return this.importData.maps.roleIds[oldId]
          })
        }),
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`  ✔  Imported ${userData.email}`);
      this.importData.maps.userIds[userData._id] = _id;
    }));
    console.log('');
  }

  async importCourses() {
    const courses = this.exportData.courses.filter(c => this.exportData.status.success.includes(c._id))
    console.log(`Attempting to import ${Object.keys(courses).length} courses`);
    let done = 0;
    for (const course of this.exportData.courses) {
      if(LIMIT !== undefined && done === LIMIT) break;
      try {
        if(this.importData?.status?.success?.includes(course._id) || this.importData?.status?.skip?.includes(course._id)) {
          this.status.skip.push(course._id);
          console.log(`  - Course ${course._id} already imported, skipping`);
          continue;
        }
        console.log(`  - Importing ${course._id} ${course.title}`);

        await this.importCourse(course);
        this.status.success.push(course._id);
        console.log(`    ✔  Import successful`);
      } catch(e) {
        console.log(`    ✘ Import failed, ${e.message}`);
        e.courseId = course._id;
        this.status.error.push(e);
      }
      done++;
    }
    Object.entries(this.status).forEach(([key, value]) => {
      this.status[key] = [...new Set([...value, ...this.status[key]])];
    });
    console.log('');
  }

  async importCourse(course) {
    const zipPath = path.resolve(this.importData.exportPath, path.basename(course.path));
    if(!fs.statSync(zipPath, { throwIfNoEntry: false })) {
      throw new Error(`No zip found for course ${course._id} at ${zipPath}`);
    }
    const unzipPath = await zipper.unzip(zipPath);
    const courseJsonPath = path.join(unzipPath, 'src', 'course', 'en', 'course.json');
    const courseJson = await Utils.loadJson(courseJsonPath);
    
    if(course._shareWithUsers?.length > 0 || course._isShared === true || course.heroImage) {
      // add course attributes not included in export
      if(course.heroImage) {
        const relHeroDest = `course/en/assets/${path.basename(course.heroImage)}`;
        debug('hero src:', path.join(this.importData.exportPath, course.heroImage), fs.statSync(path.join(this.importData.exportPath, course.heroImage), { throwIfNoEntry: false }))
        debug('hero dest:', path.join(unzipPath, 'src', relHeroDest), fs.statSync(path.join(unzipPath, 'src', 'course', 'en', 'assets'), { throwIfNoEntry: false }))
        fs.copyFileSync(path.join(this.importData.exportPath, course.heroImage), path.join(unzipPath, 'src', relHeroDest))
        courseJson.heroImage = relHeroDest
      }
      // rewrite course.json with extra export data
      fs.writeFileSync(courseJsonPath, JSON.stringify(courseJson, null, 2))
    }
    // remove blacklisted plugins
    Object.entries(this.pluginBlacklist).forEach(([t, plugins]) => {
      plugins.forEach(async p => {
        try {
          fs.rmSync(path.join(unzipPath, 'src', t, p), { recursive: true })
        } catch(e) {
          if(e.code !== 'ENOENT') throw e
        }
      })
    })
    debug(JSON.stringify({ unzipPath }));
    debug('statSync:', fs.statSync(unzipPath, { throwIfNoEntry: false }));
    
    // call the API
    const res = await Utils.request('adapt/import', {
      ...this.importData,
      method: 'POST',
      body: JSON.stringify({ unzipPath }),
      headers: { 'Content-Type': 'application/json' }
    });
    if(!res.ok) throw new Error(`${res.message} (${res.statusCode})`);
  }

  async saveMetadata() {
    return Utils.writeJson(path.join(this.importData.exportPath, 'import.json'), { ...this.importData, status: this.status });
  }
}

function debug(...args) {
  if(IS_DEBUG) console.log('DEBUG::', ...args);
}