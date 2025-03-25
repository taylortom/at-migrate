import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import Utils from './Utils.cjs';

export default class Importer {
  constructor(options) {
    this.sourcePath = options.sourcePath;
    this.exportData = {};
    this.exportPath = '';
    this.importData = {};
    this.apiUrl = `${options.apiUrl}`;
    this.maps = {
      roleNames: {
        "Authenticated User": "authuser",
        "Course Creator": "contentcreator",
        "Super Admin": "superuser"
      }, 
      roleIds: {},
      userIds: {}
    };
    this.roleIdMap = {};
    this.userIdMap = {};
  }
  async init() {
    const migratePath = path.join(this.sourcePath, 'at-migrate');
    const { exportPath } = await prompts({
      type: 'select',
      name: 'exportPath',
      message: `Choose an export to restore`,
      choices: fs.readdirSync(migratePath).map(f => Object.create({ title: f, value: path.join(migratePath, f) }))
    });
    this.exportPath = exportPath
    
    this.exportData = await Utils.loadJson(path.join(this.exportPath, 'export.json'));
    try {
      this.importData = await Utils.loadJson(path.join(this.exportPath, 'import.json'));
    } catch {
      this.importData = {};
    }
    if(!this.importData.authToken) {
      const { authToken } = await prompts({
        type: 'text',
        name: 'authToken',
        message: `An auth token is required to import the data, please enter it now`
      });
      this.importData.authToken = authToken;
    }
  }
  async run() {
    await this.importUsers();
    return this.importCourses();
  }

  async importUsers() {
    const { data: existingRoles } = await Utils.request('roles');
    const { data: existingUsers } = await Utils.request('users');
    const rolesChoices = existingRoles.map(r => {
      return { title: r.displayName, value: r._id };
    });
    console.log('You will now be prompted to map the old roles to the new ones.');

    const promptData = await prompts(this.exportData.roles.map(r => {
      const initial = existingRoles.reduce((initial, nr, i) => {
        if(nr.shortName === this.maps.roleNames[r.name]) initial = i;
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
      this.roleIdMap[this.exportData.roles.find(r => r.name === oldName)._id] = newId.toString();
    });
    // import users
    console.log(`Attempting to import ${this.exportData.users.length} users`);
    
    await Promise.all(this.exportData.users.map(async userData => {
      const existingUser = existingUsers.find(u => u.email === userData.email);
      if(existingUser) {
        console.log(`- User ${userData.email} already exists, skipping`);
        this.userIdMap[userData._id] = existingUser._id;
        return;
      }
      const { data: { _id } } = await Utils.request('users', { method: 'POST', body: {
        email: userData.email,
        password: userData.password,
        firstName: userData.firstName,
        lastName: userData.lastName,
        roles: userData.roles.map(r => this.roleIdMap[r.toString()])
      }});
      console.log(`- Imported ${userData.email}`);
      this.userIdMap[userData._id] = _id;
    }));
  }

  async importCourses() {
    console.log(`Attempting to import ${Object.keys(this.exportData.courses.success).length} courses`);
    const success = {};
    const fail = {};
    await Promise.all(this.exportData.courses.success.map(async course => {
      try {
        console.log(` - Importing ${course._id} ${course.title}`);
        await this.importCourse(course.path);
        success[course._id] = course;
        console.log(`  + Import successful`);
      } catch(e) {
        console.log(`  x Import failed, ${e.message}`);
        course.error = e
        fail[course._id] = course;
      }
    }));
    return { success, fail };
  }

  async importCourse(zipPath) {
    const res = await Utils.submitForm(
      'adapt/import', 
      { course: fs.createReadStream(zipPath) }, 
      { headers: { 'Content-Length': fs.statSync(zipPath).size } }
    );
    console.log(res);

    if(!res.ok) throw new Error(`${res.message} (${res.statusCode})`);
  }
}