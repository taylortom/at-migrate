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
    await exporter.run();

    options.exportPath = exporter.exportPath;

    const importer = new Importer(options);
    await importer.init();
    const importData = await importer.run();

    if(importData.fail) {
      console.log(importData.fail);
    }
  } catch(e) {
    console.log(e);
  }
  // @todo cleanup
  process.exit();
}

export default run();
