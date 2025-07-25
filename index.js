#!/usr/bin/env node
import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";
import path from 'path';
import prompts from 'prompts';

async function run() {
  const [action, ...flags] = process.argv.slice(2);
  
  const IS_DEBUG = flags.includes('--debug');
  const LIMIT = flags.find(f => f.startsWith('--limit='))?.replace('--limit=', '');
  
  console.log(`##`);
  console.log(`## at-migrate`);
  if(IS_DEBUG ?? LIMIT) console.log(`##`);
  if(IS_DEBUG) console.log(`## !! IS_DEBUG enabled`);
  if(LIMIT) console.log(`## !! LIMIT set to ${LIMIT}`);
  console.log(`##`);
  

  const { sourcePath } = await prompts([{
    type: 'text',
    name: 'sourcePath',
    message: `Please specify the path to the legacy app source`,
    initial: process.cwd()
  }]);

  const errors = [];
  try {
    switch(action) {
      case 'export':
        await runExport({ sourcePath, IS_DEBUG, LIMIT, exportCourses: !flags.includes('--no-courses') });
        break;
      case 'import':
        await runImport({ sourcePath, IS_DEBUG, LIMIT });
        break;
      default:
        throw new Error('Invalid action');
    }
  } catch(e) {
    errors.push(e);
  }
  errors.forEach(e => {
    console.log(e, '\n', JSON.stringify(e?.data, null, 2));
    if(IS_DEBUG) console.log(e.stack);
  });
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
  console.log(`##`);
  console.log(`## Import completed.`);
  console.log(`##`);
  console.log(`## Success: ${success.length}`);
  console.log(`## Error: ${error.length}`);
  console.log(`## Skipped: ${skip.length}`);
  console.log(`## See ${path.join(options.sourcePath, 'at-migrate', 'export.json')} for full details.`);
  console.log(`##`);
}

export default run();
