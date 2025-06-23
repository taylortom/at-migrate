const fs = require('fs/promises');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const prompts = require('prompts');
const Utils = require('./Utils.cjs');

class Exporter {
  constructor(options) {
    this.sourcePath = options.sourcePath;
    this.exportPath = path.join(this.sourcePath, 'at-migrate', Date.now().toString())
  }
  async init() {
    const { forceRebuild } = await prompts([{
      type: 'toggle',
      name: 'forceRebuild',
      message: `Whether a full rebuild should be forced`,
      initial: false
    }]);
    this.config = await Utils.loadJson(path.join(this.sourcePath, 'conf', 'config.json'));
    this.metadata = {
      forceRebuild,
      status: { success: [], error: [] }
    }
    const dbclient = new MongoClient(this.config.dbConnectionUri);
    await dbclient.connect();
    this.db = dbclient.db();

    this.tenants = await this.db.collection('tenants').find().toArray();
  }
  
  async run() {
    await fs.mkdir(path.join(this.exportPath, 'heroes'), { recursive: true });
    await this.startApp();
    
    await this.exportRoles();
    await this.exportUsers();
    await this.exportCourses();
    
    await this.stopApp();
    await this.saveMetadata();
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
    this.metadata.roles = await this.db.collection('roles').find().toArray();
    console.log(`Exported ${this.metadata.roles.length} roles`);
  }
  
  async exportUsers() {
    this.metadata.users = (await this.db.collection('users').find().toArray()).map(u => {
      const roleNames = u.roles.map(ur => this.metadata.roles.find(r => r._id.toString() === ur.toString()).name);
      return { ...u, roleNames };
    });
  }
  
  async exportCourses() {
    this.metadata.courses = await this.db.collection('courses').find().toArray();
    console.log(`Attempting to export ${this.metadata.courses.length} courses`);

    return new Promise((resolve, reject) => {
      this.app.outputmanager.getOutputPlugin('adapt', async (error, adapt) => {
        if(error) {
          return reject(error);
        }
        this.adapt = adapt;
        for (const course of this.metadata.courses) {
          console.log(`Exporting ${course._id} ${course.title}`);
          try {
            if(course.heroImage) {
              const [assetData] = await this.db.collection('assets').find({ _id: new ObjectId(course.heroImage) }).toArray();
              await fs.cp(path.join(this.sourcePath, 'data', this.app.configuration.getConfig('masterTenantName'), assetData.path.slice(1)), path.join(this.exportPath, 'heroes', assetData.filename));
              course.heroImage = 'heroes/' + assetData.filename;
            }
            await this.exportCourse(course);
            this.metadata.status.success.push(course._id);
            console.log(`  Exported ${course._id} ${course.title}`);
          } catch(e) {
            e._courseId = course._id;
            this.metadata.status.error.push(e);
          }
        }
        console.log(`${this.metadata.status.success.length} courses exported successfully`);
        if(this.metadata.status.error.length) {
          console.error('Some courses failed to export', this.metadata.status.error.map(e => `${e._courseId}, ${e}`));
        }
        resolve();
      });
    });
  }
  
  exportCourse(course) {
    return new Promise((resolve, reject) => {
      this.adapt.export(course._id.toString(), undefined, undefined, async (error) => {
        if(error) {
          return reject(error);
        }
        course.createdBy = (this.metadata.users.find(u => u._id.toString() === course.createdBy.toString())).email
        course.path = `${course._id}.zip`;
        await fs.rename(path.join(this.sourcePath, 'temp', this.config.masterTenantID, 'exports', `${this.app.usermanager.getCurrentUser()._id}.zip`), path.join(this.exportPath, course.path));

        resolve(course);
      }, { forceRebuild: this.metadata.forceRebuild });
    });
  }
  
  saveMetadata() {
    return Utils.writeJson(path.join(this.exportPath, 'export.json'), this.metadata);
  }
  
  getSuperUser() {
    if(!this.superUser) {
      this.superUser = this.metadata.users.find(u => u.roleNames.includes('Super Admin'));
      
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