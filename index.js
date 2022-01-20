import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";

async function run() {
  const errors = [];
  let app;
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
    app = importer.app;
    const { success, fail } = await importer.run();

    if(fail) errors.push(...(fail instanceof Error ? [fail] : Object.values(fail)));
  } catch(e) {
    errors.push(e);
  }
  errors.forEach(e => {
    let msg = app?.lang.translate('en', e.code, e.data);
    console.log(msg ?? e);
  });  
  // @todo cleanup
  process.exit();
}

export default run();