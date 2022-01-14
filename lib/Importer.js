import fs from 'fs/promises';
import prompts from 'prompts';

export default class Importer {
  constructor(exportPath, importPath) {
    this.exportPath = exportPath;
    this.importPath = importPath;
    this.outputDir;
  }
  async init() {
    if(!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
    // force mute of all logger logs
    process.env.ADAPT_AUTHORING_LOGGER__mute = 'true';
    const { App } = await import(`${this.importPath}/node_modules/adapt-authoring-core/index.js`);
    this.app = await App.instance.onReady();
    this.outputDir = `${this.app.rootDir}temp/migration/${Date.now()}`;
    await fs.mkdir(this.outputDir, { recursive: true });
  }
  async run() {
    const exports = await fs.readdir(this.exportPath);
    console.log(`Attempting to import ${exports.length} courses`);
    // const exports = [(await fs.readdir(this.exportPath))[0]];  
    const success = {};
    const fail = {};
    const [adapt, users] = await this.app.waitForModule('adaptframework', 'users');
    const { userId } = await prompts([{
      type: 'select',
      name: 'userId',
      message: 'Choose the owner for the imported courses',
      choices: (await users.find()).map(u => Object.create({ title: u.email, value: u._id.toString() }))
    }]);
    await Promise.allSettled(exports.map(async zipName => {
      try {
        const outputPath = `${this.outputDir}/${zipName}`;
        await fs.copyFile(`${this.exportPath}/${zipName}`, outputPath);
        const course = await adapt.importCourse(outputPath, userId);
        console.log(`Imported ${course._id} ${course.title}`);
        console.log(course);
        success[zipName] = course;
      } catch(e) {
        fail[zipName] = e;
      }
    }));
    return { success, fail }
  }
  async cleanUp() {
    if(this.outputDir) await fs.rm(this.outputDir, { recursive: true }).catch(console.log);
  }
}