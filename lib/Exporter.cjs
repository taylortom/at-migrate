const fs = require('fs/promises');
const { MongoClient } = require('mongodb');
const path = require('path');
const prompts = require('prompts');
const Utils = require('./Utils.cjs');

class Exporter {
  constructor(options) {
  }
  async init() {
    this.config = {};
    this.status = {
      success: [],
      errors: []
    }
    const { path, forceRebuild } = await prompts([{
      type: 'text',
      name: 'path',
      message: `Please specify the path to the legacy app source`,
      initial: process.cwd()
    },  {
      type: 'toggle',
      name: 'forceRebuild',
      message: `Whether a full rebuild should be forced`,
      initial: true
    }]);

    this.sourcePath = path;
    this.forceRebuild = forceRebuild;

    this.config = await Utils.loadJson(path.resolve(this.sourcePath, 'config.json'));
    await this.startApp();
    /**
     * Connect to the DB
     */
    const dbclient = new MongoClient(this.config.dbConnectionUri);
    await dbclient.connect();
    this.db = dbclient.db();
    /**
     * Create a shim for UserManager#getCurrentUser
     */
    this.roles = await this.db.collection('roles').find().toArray();
    console.log(`Exported ${this.roles.length} roles`);
    this.users = (await this.db.collection('users').find().toArray()).map(u => {
      const roleNames = u.roles.map(ur => this.roles.find(r => r._id.toString() === ur.toString()).name);
      return { ...u, roleNames };
    });
    let superUser = this.users.find(u => u.roleNames.includes('Super Admin'));
    
    if(!superUser) {
      throw new Error('Could not determine super user');
    }
    superUser.tenant = (await this.db.collection('tenants').find({ _id: superUser._tenantId }).toArray())[0];
    superUser = JSON.parse(JSON.stringify(superUser));
    
    this.app.usermanager.getCurrentUser = () => superUser;
    
    console.log(`Exported ${this.users.length} users`);
  }
  run() {
    return new Promise(async (resolve, reject) => {
      const meId = this.app.usermanager.getCurrentUser()._id;
      const oldExportsDir = path.join(this.sourcePath, 'temp', this.config.masterTenantID, 'exports');
      const newExportsDir = path.join(this.sourcePath, 'export', Date.now().toString());
      
      await fs.mkdir(newExportsDir, { recursive: true });
      
      const courses = await this.db.collection('courses').find().toArray();
      
      console.log(`Attempting to export ${courses.length} courses`);
      console.log(courses.map(c => ` - ${c._id} ${c.title}`).join('\n'));

      this.app.outputmanager.getOutputPlugin('adapt', async (error, adapt) => {
        if(error) {
          return reject(error);
        }
        function doExport() {
          const course = courses.shift();
          console.log(`Exporting ${course._id} ${course.title}`);
          
          adapt.export(course._id.toString(), undefined, undefined, async (error) => {
            if(error) {
              this.status.errors.push(Object.assign(course, { error }))
              return;
            }
            const zipPath = `${newExportsDir}/${course._id}.zip`;
            course.path = zipPath;
            await fs.rename(`${oldExportsDir}/${meId}.zip`, zipPath);
            
            console.log(`  Exported ${course._id} ${course.title}`);
            this.status.success.push({
              _id: course._id,
              title: course.title,
              displayTitle: course.displayTitle,
              createdBy: (this.users.find(u => u._id.toString() === course.createdBy.toString())).email,
              path: zipPath
            });
            
            if(courses.length) { // recurse
              doExport.call(this);
            } else {
              console.log(`${this.status.success.length} courses exported successfully`);
              if(this.status.errors.length) {
                console.error('Some courses failed to export', this.status.errors.map(c => `${c._id} ${c.title}, ${c.error}`));
              }
              this.exportPath = newExportsDir;
              // stop the old app listening in case of port clashes
              this.app._httpServer.close();
              this.app._httpServer.once('close', async () => {
                const meta = { 
                  courses: this.status,
                  users: this.users,
                  roles: this.roles,
                  exportPath: this.exportPath
                };
                await fs.writeFile(path.join(this.exportPath, 'export.json'), JSON.stringify(meta, null, 2));
                resolve(meta);
              });
            }
          }, { forceRebuild: this.forceRebuild });
        }
        doExport.call(this);
      });
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
        resolve();
      });
    });
  }
  exportCourses() {
  
  }
  exportCourse() {
  
  }
  async cleanUp() {
    // @todo
  }
}

module.exports = Exporter;