import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";

async function run() {
  try {
    const oldDir = '/home/tom/Projects/adapt/adapt_authoring';
    const newDir = '/home/tom/Projects/1_scratch/adapt-authoring';

    const exporter = new Exporter(oldDir);
    await exporter.init();
    await exporter.run();

    const importer = new Importer(exporter.exportPath, newDir);
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
