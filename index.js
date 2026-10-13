#!/usr/bin/env node
import Exporter from "./lib/Exporter.cjs";
import Importer from "./lib/Importer.js";
import RemoteExporter from "./lib/RemoteExporter.js";
import { createRequire } from 'module';
import fs from 'fs/promises';
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
  

  if(action === 'export-remote') {
    try {
      await runRemoteExport({ flags, IS_DEBUG, LIMIT });
    } catch(e) {
      console.log(e.message);
      if(IS_DEBUG) console.log(e.stack);
      process.exitCode = 1;
    }
    process.exit();
  }

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
  const { status, warnings } = await exporter.run();
  console.log(``);
  console.log(`##`);
  console.log(`## Export completed.`);
  console.log(`##`);
  console.log(`## Success: ${status.success.length}`);
  console.log(`## Error: ${status.error.length}`);
  console.log(`## Warnings: ${warnings.length}`);
  if(warnings.length) {
    // dirty legacy data is dropped rather than fatal now, so surface it: a warning buried in
    // the log of a long run is easy to miss
    console.log(`##`);
    warnings.forEach(w => console.log(`## ! ${w}`));
  }
  console.log(`## See ${path.join(exporter.exportPath, 'export.json')} for full details.`);
  console.log(`##`);
}

async function runRemoteExport({ flags, IS_DEBUG, LIMIT }) {
  const flag = name => flags.find(f => f.startsWith(`--${name}=`))?.replace(`--${name}=`, '');
  const credentialsFile = flag('credentials');
  const fileCredentials = credentialsFile ? JSON.parse(await fs.readFile(credentialsFile)) : {};
  const answers = await prompts([
    { type: flag('url') ? null : 'text', name: 'siteUrl', message: 'Legacy site URL' },
    { type: (fileCredentials.email || process.env.AT_MIGRATE_EMAIL) ? null : 'text', name: 'email', message: 'Super Admin email' },
    { type: (fileCredentials.password || process.env.AT_MIGRATE_PASSWORD) ? null : 'password', name: 'password', message: 'Password' }
  ]);
  const exporter = new RemoteExporter({
    siteUrl: flag('url') ?? answers.siteUrl,
    email: fileCredentials.email ?? process.env.AT_MIGRATE_EMAIL ?? answers.email,
    password: fileCredentials.password ?? process.env.AT_MIGRATE_PASSWORD ?? answers.password,
    outputPath: path.resolve(flag('out') ?? path.join(process.cwd(), 'at-migrate')),
    courseIds: flag('courses')?.split(',').filter(Boolean),
    IS_DEBUG,
    LIMIT
  });
  const { status, warnings } = await exporter.run();
  console.log(``);
  console.log(`##`);
  console.log(`## Remote export completed.`);
  console.log(`##`);
  console.log(`## Success: ${status.success.length}`);
  console.log(`## Error: ${status.error.length}`);
  console.log(`## Warnings: ${warnings.length}`);
  if(warnings.length) {
    console.log(`##`);
    warnings.forEach(w => console.log(`## ! ${w}`));
  }
  console.log(`## See ${path.join(exporter.exportPath, 'export.json')} for full details.`);
  console.log(`##`);
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
