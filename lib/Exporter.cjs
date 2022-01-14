const fs = require('fs/promises');
const { MongoClient } = require('mongodb');

class Exporter {
  constructor(options) {
    this.oldToolPath = options.oldToolPath;
    this.newToolPath = options.newToolPath;
    this.config = require(`${this.oldToolPath}/conf/config.json`);
    this.app = require(`${this.oldToolPath}/lib/application`)();
    this.app.run();
    this.app.logger.level('console', 'error');
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
          this.users = await this.db.collection('users').find().toArray();
          const { _id: adminRoleId } = this.roles.find(r => r.name === "Super Admin");

          let superUser = this.users.find(u => u.roles.toString() === adminRoleId.toString());
          
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
      const meId = this.app.usermanager.getCurrentUser()._id;
      const oldExportsDir = `${this.oldToolPath}/temp/${this.config.masterTenantID}/exports`;
      const newExportsDir = `${this.newToolPath}/temp/migrations/${Date.now()}/exports`;
      const successData = {};
      
      await fs.mkdir(newExportsDir, { recursive: true });
      
      const courses = await this.db.collection('courses').find().toArray();
      
      console.log(`Attempting to export ${courses.length} courses`);

      this.app.outputmanager.getOutputPlugin('adapt', async (error, adapt) => {
        if(error) {
          return reject(error);
        }
        function doExport() {
          const course = courses.shift();
          adapt.export(course._id.toString(), undefined, undefined, async (error) => {
            if(error) {
              return reject(error);
            }
            const zipPath = `${newExportsDir}/${course._id}.zip`;
            course.path = zipPath;
            await fs.rename(`${oldExportsDir}/${meId}.zip`, zipPath);
            
            console.log(`Exported ${course._id} ${course.title}`);
            successData[course._id] = course;
            
            if(courses.length) { // recurse
              doExport.call(this);
            } else {
              console.log('All courses exported successfully');
              this.exportPath = newExportsDir;
              // stop the old app listening in case of port clashes
              this.app._httpServer.close();
              this.app._httpServer.once('close', () => resolve({ 
                courses: successData,
                users: this.users,
                roles: this.roles,
                exportPath: this.exportPath
              }));
            }
          });
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