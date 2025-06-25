const fs = require('fs/promises');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const prompts = require('prompts');
const Utils = require('./Utils.cjs');

const EXPORT_LIMIT = 100;

class Exporter {
  constructor(options) {
    this.sourcePath = options.sourcePath;
    this.exportPath = path.join(this.sourcePath, 'at-migrate');
    this.exportData = {}
  }
  async init() {
    this.config = await Utils.loadJson(path.join(this.sourcePath, 'conf', 'config.json'));
    try {
      const exports = await fs.readdir(this.exportPath);
      if(exports.length) {
        const incompleteExports = exports.filter(e => {
          try {
            const meta = Utils.loadJsonSync(path.join(this.exportPath, e, 'export.json'));
            return meta.status?.success?.length !== meta.courses?.length
          } catch {
            return true
          }
        });
        const { action } = await prompts({
          type: 'select',
          name: 'exportPath',
          message: `There are incomplete exports, what would you like to do?`,
          choices: [
            { title: 'Continue existing', value: 'continue' },
            { title: 'Restart', value: 'restart' }
          ]
        });
        if(action === 'continue') {
          const { exportId } = await prompts({
            type: 'select',
            name: 'exportPath',
            message: `Choose an export to continue`,
            choices: incompleteExports.map(f => Object.create({ title: f }))
          });
          this.exportPath = path.join(this.exportPath, exportId);
          this.metadata = await Utils.loadJson(path.join(this.exportPath, 'export.json'));
        }
      } else {
        console.log('\nNo existing exports found, starting afresh.\n');
        throw new Error('No existing exports')
      }
    } catch(e) {
      this.exportPath = path.join(this.exportPath, Date.now().toString())
    }
    if(!this.metadata) {
      const { forceRebuild } = await prompts([{
        type: 'toggle',
        name: 'forceRebuild',
        message: `Do you want to run a full rebuild of each course before exporting?`,
        initial: false
      }]);
      this.metadata = {
        forceRebuild,
        status: { success: [], error: [] }
      }
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
    this.metadata.roles = (await this.db.collection('roles').find().toArray()).map(r => {
      return { _id: r._id, name: r.name }
    });
    console.log(`Exported ${this.metadata.roles.length} roles`);
  }
  
  async exportUsers() {
    this.metadata.users = (await this.db.collection('users').find().toArray()).map(u => {
      return { 
        _id: u._id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        roleNames: u.roles.map(ur => this.metadata.roles.find(r => r._id.toString() === ur.toString()).name),
        _tenantId: u._tenantId
      };
    });
  }
  
  async exportCourses() {
    this.metadata.courses = (await this.db.collection('courses').find().toArray()).map(c => {
      return {
        _id: c._id,
        title: c.title,
        heroImage: c.heroImage || undefined,
        _isShared: c._isShared || undefined,
        _shareWithUsers: (c._shareWithUsers !== undefined && c._shareWithUsers.length > 0) ? c._shareWithUsers : undefined,
        createdBy: c.createdBy
      }
    });
    console.log(`Attempting to export ${this.metadata.courses.length} courses`);

    return new Promise((resolve, reject) => {
      this.app.outputmanager.getOutputPlugin('adapt', async (error, adapt) => {
        if(error) {
          return reject(error);
        }
        this.adapt = adapt;
        let done = 0;
        for (let i = 0; i < this.metadata.courses.length; i++) {
          const course = this.metadata.courses[i];
          if(EXPORT_LIMIT !== undefined && done === EXPORT_LIMIT) break;
          if(this.metadata.status.success.includes(course._id)) continue;
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
          done++;
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
        try {
          course.createdBy = (this.metadata.users.find(u => u._id.toString() === course.createdBy.toString())).email
        } catch(e) {
          console.log(e);
          course.createdBy = undefined;
        }
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