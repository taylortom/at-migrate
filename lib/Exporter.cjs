const fs = require('fs/promises');
const { MongoClient } = require('mongodb');
const path = require('path');

class Exporter {
  constructor(options) {
    this.oldToolPath = options.oldToolPath;
    this.newToolPath = options.newToolPath;
    this.forceRebuild = options.forceRebuild;
    this.config = require(path.resolve(this.oldToolPath, 'conf/config.json'));
    this.app = require(path.resolve(this.oldToolPath, 'lib/application'))();
    this.app.run({ skipDependencyCheck: true });
    this.app.logger.level('console', 'error');
    this.status = {
      success: [],
      errors: []
    }
  }
  init() {
    return new Promise((resolve, reject) => {
      this.app.on('serverStarted', async () => {
        try {
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
          resolve();
        } catch(e) {
          reject(e);
        }
      });
    });
  }
  run() {
    return new Promise(async (resolve, reject) => {
      const getDir = dir => path.join(this.oldToolPath, 'temp', dir, 'exports');
      
      const meId = this.app.usermanager.getCurrentUser()._id;
      const oldExportsDir = getDir(this.config.masterTenantID);
      const newExportsDir = getDir(path.join('migrations', Date.now().toString()));
      
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
                await fs.writeFile(path.join(this.exportPath, 'metadata.json'), JSON.stringify(meta, null, 2));
                resolve(meta);
              });
            }
          }, { forceRebuild: this.forceRebuild });
        }
        doExport.call(this);
      });
    });
  }
  async cleanUp() {
    // @todo
  }
}

module.exports = Exporter;