import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";
import prompts from 'prompts';

async function run() {
  console.log('##\n## at-migrate\n##\n');
  
  const { sourcePath } = await prompts([{
    type: 'text',
    name: 'sourcePath',
    message: `Please specify the path to the legacy app source`,
    initial: process.cwd()
  }]);

  const [action] = process.argv.slice(2);
  const errors = [];
  try {
    switch(action) {
      case 'export':
        await runExport({ sourcePath });
        break;
      case 'import':
        await runImport({ sourcePath, apiUrl: 'http://localhost:5678/api' });
        break;
      default:
        throw new Error('Invalid action');
    }
  } catch(e) {
    errors.push(e);
  }
  errors.forEach(e => console.log(e, '\n', JSON.stringify(e?.data, null, 2)));  
  process.exit();
}

async function runExport(options) {
  const exporter = new Exporter(options);
  await exporter.init();
  return exporter.run();
}

async function runImport(options) {
  const importer = new Importer(options);
  await importer.init();
  const { success, fail } = await importer.run();
  if(success.length) console.log(success);
  if(fail.length) console.log(fail);
}

export default run();