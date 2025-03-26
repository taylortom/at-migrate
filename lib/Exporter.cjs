const fs = require('fs/promises');
const { MongoClient } = require('mongodb');
const path = require('path');
const prompts = require('prompts');
const Utils = require('./Utils.cjs');

class Exporter {
  constructor(options) {
    this.sourcePath = options.sourcePath;
  }
  async init() {
    const { forceRebuild } = await prompts([{
      type: 'toggle',
      name: 'forceRebuild',
      message: `Whether a full rebuild should be forced`,
      initial: true
    }]);
    this.forceRebuild = forceRebuild;
    this.config = await Utils.loadJson(path.join(this.sourcePath, 'conf', 'config.json'));
    this.newExportsDir = path.join(this.sourcePath, 'at-migrate', Date.now().toString());
    this.status = {
      success: [],
      errors: []
    }
    const dbclient = new MongoClient(this.config.dbConnectionUri);
    await dbclient.connect();
    this.db = dbclient.db();

    this.tenants = await this.db.collection('tenants').find().toArray();
  }
  
  run() {
    return new Promise(async (resolve, reject) => {
      await fs.mkdir(this.newExportsDir, { recursive: true });
      
      await this.startApp();
      await this.exportRoles();
      await this.exportUsers();
      await this.exportCourses();
      await this.stopApp();
      await this.saveMetadata();
    });
  }
  
  startApp() {
    console.log('Starting legacy app');
    this.app = require(path.resolve(this.sourcePath, 'lib/application'))();
    this.app.run({ skipDependencyCheck: true });
    this.app.logger.level('console', 'error');
    return new Promise(resolve => {
      this.app.on('serverStarted', async () => {
        console.log(' - App started');
        this.app.usermanager.getCurrentUser = this.getSuperUser.bind(this);
        resolve();
      });
    });
  }
  
  stopApp() {
    return new Promise((resolve, reject) => {
      this.app._httpServer.close();
      this.app._httpServer.once('close', async () => resolve());
    });
  }
  
  async exportRoles() {
    this.roles = await this.db.collection('roles').find().toArray();
    console.log(`Exported ${this.roles.length} roles`);
  }
  
  async exportUsers() {
    this.users = (await this.db.collection('users').find().toArray()).map(u => {
      const roleNames = u.roles.map(ur => this.roles.find(r => r._id.toString() === ur.toString()).name);
      return { ...u, roleNames };
    });
  }
  
  async exportCourses() {
    const courses = await this.db.collection('courses').find().toArray();
    console.log(`Attempting to export ${courses.length} courses`);

    this.app.outputmanager.getOutputPlugin('adapt', async (error, adapt) => {
      if(error) {
        return reject(error);
      }
      this.adapt = adapt;
      for (const course of courses) {
        console.log(`Exporting ${course._id} ${course.title}`);
        try {
          const meta = await this.exportCourse(course);
          this.status.success.push(meta);
          console.log(`  Exported ${course._id} ${course.title}`);
        } catch(e) {
          e.course = course;
          this.status.errors.push(e);
        }
      }
      console.log(`${this.status.success.length} courses exported successfully`);
      if(this.status.errors.length) {
        console.error('Some courses failed to export', this.status.errors.map(e => `${e.course._id} ${e.course.title}, ${e}`));
      }
    });
  }
  
  exportCourse(course) {
    return new Promise((resolve, reject) => {
      this.adapt.export(course._id.toString(), undefined, undefined, async (error) => {
        if(error) {
          return reject(e);
        }
        course.createdBy = (this.users.find(u => u._id.toString() === course.createdBy.toString())).email
        course.path = path.join(this.newExportsDir, `${course._id}.zip`);
        await fs.rename(path.join(this.sourcePath, 'temp', this.config.masterTenantID, 'exports', `${this.app.usermanager.getCurrentUser()._id}.zip`), course.path);

        resolve(course);
      }, { forceRebuild: this.forceRebuild });
    });
  }
  
  saveMetadata() {
    return Utils.writeJson(path.join(this.newExportsDir, 'export.json'), { 
      courses: this.status,
      users: this.users,
      roles: this.roles,
      exportPath: this.newExportsDir
    });
  }
  
  getSuperUser() {
    if(!this.superUser) {
      this.superUser = this.users.find(u => u.roleNames.includes('Super Admin'));
      
      if(!this.superUser) {
        throw new Error('Could not determine super user');
      }
      this.superUser.tenant = this.tenants.find(t => t. _id.toString() === this.superUser._tenantId.toString());
      this.superUser = JSON.parse(JSON.stringify(this.superUser));
    }
    return this.superUser;
  }
  
  async cleanUp() {
    // @todo
  }
}

module.exports = Exporter;