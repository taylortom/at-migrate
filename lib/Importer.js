import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import Utils from './Utils.cjs';

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
      },
      status: { success: [], error: [] }
    };
  }
  async init() {
    const migratePath = path.join(this.importData.sourcePath, 'at-migrate')
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
    await this.importUsers();
    await this.saveMetadata();
    await this.importCourses();
    await this.saveMetadata();
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
        console.log(`- User ${userData.email} already exists, skipping`);
        this.importData.maps.userIds[userData._id] = existingUser._id;
        return;
      }
      const { data: { _id } } = await Utils.request('users', { 
        ...this.importData,
        method: 'POST', 
        body: {
          email: userData.email,
          password: userData.password,
          firstName: userData.firstName,
          lastName: userData.lastName,
          roles: userData.roles.map(r => this.importData.maps.roleIds[r.toString()])
        }
      });
      console.log(`- Imported ${userData.email}`);
      this.importData.maps.userIds[userData._id] = _id;
    }));
  }

  async importCourses() {
    console.log(`Attempting to import ${Object.keys(this.exportData.status.success).length} courses`);
    for (const courseId of this.exportData.status.success) {
      let course;
      try {
        course = this.exportData.courses.find(c => c._id === courseId);
        console.log(` - Importing ${course._id} ${course.title}`);
        await this.importCourse(course.path);
        this.importData.status.success.push(course._id);
        console.log(`  + Import successful`);
      } catch(e) {
        console.log(`  x Import failed, ${e.message}`);
        e.course = course;
        this.importData.status.error.push(e);
      }
    }
  }

  async importCourse(zipPath) {
    const res = await Utils.submitForm(
      'adapt/import',
      { course: fs.createReadStream(zipPath) }, 
      { ...this.importData, headers: { 'Content-Length': fs.statSync(zipPath).size } }
    );
    console.log(res);

    if(!res.ok) throw new Error(`${res.message} (${res.statusCode})`);
  }

  async saveMetadata() {
    return Utils.writeJson(path.join(this.importData.exportPath, 'import.json'), this.importData);
  }
}