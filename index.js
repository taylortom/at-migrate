#!/usr/bin/env node
import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";
import { createRequire } from 'module';
import path from 'path';
import prompts from 'prompts';

// read via createRequire rather than a JSON import so this still works on the Node 16 the
// export phase may be stuck with, and resolves against this file rather than the cwd
const { version } = createRequire(import.meta.url)('./package.json');

async function run() {
  const [action, ...flags] = process.argv.slice(2);
  
  const IS_DEBUG = flags.includes('--debug');
  const LIMIT = flags.find(f => f.startsWith('--limit='))?.replace('--limit=', '');
  
  console.log(`##`);
  console.log(`## at-migrate v${version}`);
  if(IS_DEBUG || LIMIT) console.log(`##`);
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
  const { success, error, skip, warn } = await importer.run();
  console.log(``);
  console.log(`##`);
  console.log(`## Import completed.`);
  console.log(`##`);
  console.log(`## Success: ${success.length}`);
  console.log(`## Error: ${error.length}`);
  console.log(`## Skipped: ${skip.length}`);
  console.log(`## Warnings: ${warn.length}`);
  if(warn.length) {
    // these courses imported, but with something dropped along the way, so list them out:
    // a warning buried in the log of a long run is easy to miss
    console.log(`##`);
    warn.forEach(w => console.log(`## ! ${w.courseTitle ? `${w.courseTitle}: ` : ''}${w.message}`));
  }
  console.log(`## See ${path.join(importer.importData.exportPath, 'import.json')} for full details.`);
  console.log(`##`);
}

export default run();
