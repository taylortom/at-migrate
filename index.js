import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";
import path from 'path';
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
        await runImport({ sourcePath });
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
  const { success, error, skip } = await importer.run();
  console.log(``);
  console.log(`## Import completed.`);
  console.log(`## Success: ${success.length}`);
  console.log(`## Error: ${error.length}`);
  console.log(`## Skipped: ${skip.length}`);
  console.log(`## See ${path.join(options.sourcePath, 'at-migrate', 'export.json')} for full details.`);
}

export default run();