import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import Utils from './Utils.cjs';
import zipper from 'zipper';

export default class Importer {
  constructor(options) {
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
          "Super Admin": "superuser"
        }, 
        roleIds: {},
        userIds: {}
      }
    };
    this.status = { success: [], error: [], skip: [] }
  }
  async init() {
    let migratePath = this.importData.sourcePath;
    try {
      const nestedPath = path.join(migratePath, 'at-migrate');
      if(fs.statSync(nestedPath, { throwIfNoEntry: false })) migratePath = nestedPath
    } catch {}
    const { exportPath } = await prompts({
      type: 'select',
      name: 'exportPath',
      message: `Choose an export to restore`,
      choices: fs.readdirSync(migratePath).map(f => Object.create({ title: f, value: path.join(migratePath, f) }))
    });
    this.importData.exportPath = exportPath
    
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
      if(res.status === 200) console.log('✔ Auth check successful', res.data);
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
      const existingUser = existingUsers.find(u => u.email === userData.email);
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
          roles: userData.roles.map(r => this.importData.maps.roleIds[r.toString()])
        }),
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`  ✔ Imported ${userData.email}`);
      this.importData.maps.userIds[userData._id] = _id;
    }));
    console.log('');
  }

  async importCourses() {
    console.log(`Attempting to import ${Object.keys(this.exportData.status.success).length} courses`);
    for (const courseId of this.exportData.status.success) {
      let course;
      try {
        course = this.exportData.courses.find(c => c._id === courseId);
        if(this.status.success.includes(course._id)) {
          this.status.skip.push(course._id);
          return console.log(`  - Course ${course._id} already imported, skipping`);
        }
        console.log(`  - Importing ${course._id} ${course.title}`);

        await this.importCourse(path.resolve(this.importData.exportPath, course.path));
        this.status.success.push(course._id);
        console.log(`    ✔ Import successful`);
      } catch(e) {
        console.log(`    ✘ Import failed, ${e.message}`);
        e.courseId = course._id;
        this.status.error.push(e);
      }
    }
    Object.entries(this.status).forEach(([key, value]) => {
      this.status[key] = [...new Set([...value, ...this.status[key]])];
    });
    console.log('');
  }

  async importCourse(zipPath) {
    const unzipPath = await zipper.unzip(zipPath);
    const res = await Utils.request('adapt/import', {
      ...this.importData,
      method: 'POST',
      body: JSON.stringify({ unzipPath }),
      headers: { 'Content-Type': 'application/json' }
    });
    if(!res.ok) throw new Error(`${res.message} (${res.statusCode})`);
  }

  async saveMetadata() {
    return Utils.writeJson(path.join(this.importData.exportPath, 'import.json'), this.importData);
  }
}