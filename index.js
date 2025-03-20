import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";
import prompts from 'prompts';

function getArgs() {
  const [
    action
  ] = process.argv.slice(2);
  return {
    action
  };
}

async function run() {
  const {  
    action
  } = getArgs();
  const errors = [];
  let app;
  try {
    console.log(action);
    const options = await getInput();
    
    switch(action) {
      case 'export':
        await runExport(options);
        break;
      case 'import':
        await runImport(options);
        break;
      default:
        throw new Error('Invalid action');
    }
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

async function runExport(options) {
  const exporter = new Exporter(options);
  await exporter.init();
  return exporter.run();
}

async function runImport(options) {
  const importer = new Importer({
    ...options,
    courses: courses,
    oldRoles: roles,
    oldUsers: users,
    exportPath: exportPath
  });
  await importer.init();
  app = importer.app;
  const { success, fail } = await importer.run();
  if(fail) errors.push(...(fail instanceof Error ? [fail] : Object.values(fail)));
}

async function getInput() {
  return {
    oldToolPath: process.cwd(),
    newToolPath: process.cwd(),
    forceRebuild: true
  };
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