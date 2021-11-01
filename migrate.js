const fs = require('fs/promises');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

class Migrate {
  constructor(options) {
    this.options = options;
    console.log('Migrate#constructor', this);
    this.init().catch(e => {
      console.log(e);
      process.exit(1);
    });
  }
  async init() {
    if(!this.options.root) {
      throw new Error('Must provide installation directory');
    }
    await this.loadConfiguration();
    await this.connectToDatabase();

    await this.migrateCourses();
  }
  async loadConfiguration() {
    try { this.config = JSON.parse(await fs.readFile(`${this.options.root}/conf/config.json`)); } 
    catch { throw new Error('No config.json found'); }
    
    try { this.package = JSON.parse(await fs.readFile(`${this.options.root}/package.json`)); } 
    catch { throw new Error('No package.json found'); }
  }
  async connectToDatabase() {
    if(!this.config.useConnectionUri) {
      throw new Error('Must specify a dbConnectionUri in config');
    }
    this.client = new MongoClient(this.config.dbConnectionUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    await this.client.connect();
    console.log('Successfully connected to MongoDB database');
  }
  async migrateCourses() {
    for await (const c of this.getContentJson('course')) {
      const data = [c, ...await this.getCourseJson(c._courseId)];
      if(data?.length) console.log(c._id, data.map(d => `${d._type} ${d._id}`));
    }
  }
  async getCourseJson(_courseId) {
    const content = [];
    await Promise.all(Object.entries({
      config: 'config.json',
      contentobject: 'contentObjects.json',
      article: 'articles.json',
      block: 'blocks.json',
      component: 'components.json'
    }).map(async ([type, filename]) => content.push(...await this.getContentJson(type, _courseId).toArray())));
    return content;
  }
  getContentJson(type, _courseId) {
    const query = {};
    if(_courseId) {
      _courseId = new ObjectId(_courseId);
      type === 'course' ? query._id = _courseId : query._courseId = _courseId;
    }
    const options = { operators: { sort: { _sortOrder: 1 } } };
    return this.client.db().collection(`${type}s`).find(query, options);
  }
}

const [dir] = process.argv.slice(2);
module.export = new Migrate({ root: dir ? path.resolve(dir) : undefined });
