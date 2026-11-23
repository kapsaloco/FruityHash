import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const check=process.argv.includes('--check');
const target=process.argv.find(arg=>arg.startsWith('--target='))?.slice(9) ?? 'x86_64-pc-windows-msvc';
const read=file=>fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n').trim();
const fallback=JSON.parse(read(path.join(root,'licenses/upstream/sources.json')));
const metadata=JSON.parse(execFileSync(process.env.CARGO || 'cargo',[
  'metadata','--manifest-path',path.join(root,'src-tauri/Cargo.toml'),
  '--format-version','1','--locked','--offline','--filter-platform',target,
],{encoding:'utf8',maxBuffer:32*1024*1024}));
const resolved=new Set(metadata.resolve.nodes.map(node=>node.id));
const crates=metadata.packages.filter(pkg=>resolved.has(pkg.id)&&pkg.source)
  .sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
const texts=new Map(), entries=[];
function addText(text) {
  const hash=crypto.createHash('sha256').update(text).digest('hex');
  if(!texts.has(hash)) texts.set(hash,{id:`L${String(texts.size+1).padStart(3,'0')}`,text});
  return texts.get(hash).id;
}
for(const pkg of crates) {
  if(!pkg.license) throw new Error(`Missing license declaration: ${pkg.name}@${pkg.version}`);
  const directory=path.dirname(pkg.manifest_path);
  const files=fs.readdirSync(directory).filter(name=>/^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:$|[._-])/i.test(name))
    .map(name=>path.join(directory,name)).filter(file=>fs.statSync(file).isFile());
  if(pkg.license_file && fs.existsSync(pkg.license_file) && !files.includes(pkg.license_file)) files.push(pkg.license_file);
  const attachments=files.sort().map(file=>`${path.basename(file)}: ${addText(read(file))}`);
  const supplement=fallback[`${pkg.name}@${pkg.version}`];
  if(!attachments.length) {
    if(!supplement) throw new Error(`No upstream license text: ${pkg.name}@${pkg.version}`);
    attachments.push(`upstream license: ${addText(read(path.join(root,'licenses/upstream',supplement.file)))}`);
  }
  entries.push([
    `${pkg.name} ${pkg.version}`,
    `License declaration: ${pkg.license}`,
    `Source: https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`,
    `License texts: ${attachments.join('; ')}`,
    ...(supplement?[`Supplement origin: ${supplement.source}`]:[]),
    ...(pkg.license.includes('MPL-2.0')?['The unmodified source for this component is available at the Source URL above under MPL-2.0.']:[]),
  ].join('\n'));
}

// Only production npm modules are embedded into the desktop frontend.
const lock=JSON.parse(read(path.join(root,'package-lock.json')));
for(const [location,locked] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))) {
  if(!location || locked.dev || locked.devOptional) continue;
  const directory=path.join(root,location);
  const pkg=JSON.parse(read(path.join(directory,'package.json')));
  if(pkg.version!==locked.version) throw new Error(`Installed npm version differs from lockfile: ${pkg.name}`);
  const files=fs.readdirSync(directory).filter(name=>/^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:$|[._-])/i.test(name))
    .filter(name=>fs.statSync(path.join(directory,name)).isFile());
  if(!pkg.license || !files.length) throw new Error(`Missing npm license information: ${pkg.name}`);
  entries.push([
    `${pkg.name} ${pkg.version} (npm)`,
    `License declaration: ${pkg.license}`,
    `Source: https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
    `License texts: ${files.sort().map(file=>`${file}: ${addText(read(path.join(directory,file)))}`).join('; ')}`,
  ].join('\n'));
}
const result=[
  'FruityHash v1.0 - Third-party notices',
  `Dependency target: ${target}`,
  '',
  'FruityHash and FruityUI use the MIT License in LICENSE. Third-party components',
  'retain their upstream copyright notices and license terms reproduced below.',
  'This inventory includes the resolved Rust build dependencies as well as runtime',
  'dependencies, so not every listed component is embedded in the executable.',
  'Development-only npm tooling is not distributed with the app and is excluded.',
  'Dual-license declarations indicate alternatives; inclusion of multiple texts',
  'does not change the upstream choice of licenses. Source archive links identify',
  'the exact crate versions. MPL-covered sources are unmodified by this project.',
  'The separately installed Microsoft WebView2 runtime is provided by Microsoft',
  'under its own terms; its runtime binaries are not included in this inventory.',
  '',
  'COMPONENTS',
  '==========',
  entries.join('\n\n'),
  '',
  'LICENSE AND NOTICE TEXTS',
  '=======================',
  [...texts.values()].map(({id,text})=>`\n[${id}]\n${'-'.repeat(72)}\n${text}\n`).join('\n'),
].join('\n')+'\n';
const output=path.join(root,'THIRD_PARTY_NOTICES.txt');
if(check) {
  if(fs.readFileSync(output,'utf8')!==result) throw new Error('Third-party notices are stale. Run npm run licenses:generate.');
} else fs.writeFileSync(output,result);
if(read(path.join(root,'LICENSE'))!==read(path.join(root,'src/styles/fruity/LICENSE'))) throw new Error('FruityUI LICENSE differs from the project license.');
console.log(`${check?'Checked':'Generated'} notices for ${entries.length} components; ${texts.size} distinct upstream license/notice texts.`);
