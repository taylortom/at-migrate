import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";
import prompts from 'prompts';

async function run() {
  const errors = [];
  let app;
  try {
    const options = await getInput();
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
    if(e.data) console.log(e.data);
  });  
  // @todo cleanup
  process.exit();
}

async function getInput() {
  try {
    return await prompts([{
      type: 'text',
      name: 'oldToolPath',
      message: 'Enter the directory of the legacy authoring tool'
    }, {
      type: 'text',
      name: 'newToolPath',
      message: 'Enter the directory of the new authoring tool'
    }, {
      type: 'confirm',
      name: 'forceRebuild',
      message: 'Do you want to force a rebuild of each course prior to export? (this will greatly increase export time)'
    }]);
  } catch(e) {
    console.log(e);
  }
}

export default run();