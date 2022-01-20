import fs from 'fs/promises';
import path from 'path';
import prompts from 'prompts';

const ROLE_MAP = {
  "Authenticated User": "authuser",
  "Course Creator": "contentcreator",
  "Super Admin": "superuser"
};
export default class Importer {
  constructor(options) {
    this.exportPath = options.exportPath;
    this.newToolPath = options.newToolPath;
    this.oldRoles = options.oldRoles;
    this.oldUsers = options.oldUsers;
    this.courses = options.courses;
    this.outputDir;
    this.roleIdMap = {};
    this.userIdMap = {};
  }
  async init() {
    if(!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
    // force mute of all logger logs
    process.env.ADAPT_AUTHORING_LOGGER__mute = 'true';
    const { App } = await import(`${this.newToolPath}/node_modules/adapt-authoring-core/index.js`);
    this.app = await App.instance.onReady();
    this.outputDir = path.resolve(this.exportPath, '../imports');
    await fs.mkdir(this.outputDir, { recursive: true });
  }
  async run() {
    console.log(`Attempting to import ${Object.keys(this.courses).length} courses`);
    const success = {};
    const fail = {};
    const adapt = await this.app.waitForModule('adaptframework');
    
    try {
      await this.importUsers();
    } catch(e) {
      return { fail: e };
    }
    await Promise.allSettled(Object.values(this.courses).map(async course => {
      try {
        const result = await adapt.importCourse(course.path, this.userIdMap[course.createdBy.toString()]);
        console.log(`Imported ${result._id} ${result.title}`);
        success[course.path] = result;
      } catch(e) {
        fail[course.path] = e;
      }
    }));
    return { success, fail };
  }
  async importUsers() {
    const roles = await this.app.waitForModule('roles');
    const newRoles = await roles.find();
    const rolesChoices = newRoles.map(r => {
      return { title: r.displayName, value: r._id };
    });
    console.log('You will now be prompted to map the old roles to the new ones.');

    const promptData = await prompts(this.oldRoles.map(r => {
      const initial = newRoles.reduce((initial, nr, i) => {
        if(nr.shortName === ROLE_MAP[r.name]) initial = i;
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
      this.roleIdMap[this.oldRoles.find(r => r.name === oldName)._id] = newId.toString();
    });
    // import users
    await Promise.all(this.oldUsers.map(async userData => {
      const users = await this.app.waitForModule('users');
      const { _id } = await users.insert({
        email: userData.email,
        password: userData.password,
        firstName: userData.firstName,
        lastName: userData.lastName,
        roles: userData.roles.map(r => this.roleIdMap[r.toString()])
      });
      this.userIdMap[userData._id] = _id;
    }));
  }
  async cleanUp() {
    if(this.outputDir) await fs.rm(this.outputDir, { recursive: true }).catch(console.log);
  }
}