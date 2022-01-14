import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";

async function run() {
  try {
    const options = {
      oldToolPath: '/home/tom/Projects/adapt/adapt_authoring',
      newToolPath: '/home/tom/Projects/1_scratch/adapt-authoring'
    };
    const exporter = new Exporter(options);
    await exporter.init();
    const { courses, roles, users, exportPath } = await exporter.run();

    options.courses = courses;
    options.oldRoles = roles;
    options.oldUsers = users;
    options.exportPath = exportPath;

    const importer = new Importer(options);
    await importer.init();
    const importData = await importer.run();

    if(importData.fail) {
      console.log('failed');
      // console.log(importData.fail);
    } else {
      console.log('Success');
    }
  } catch(e) {
    console.log(e);
  }
  // @todo cleanup
  process.exit();
}

export default run();
