import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const [target, root = '.'] = process.argv.slice(2);
const platforms = {
  'x86_64-pc-windows-msvc': ['windows_x86_64', ['.msi', '.exe']],
  'x86_64-unknown-linux-gnu': ['linux_x86_64', ['.deb', '.rpm']],
  'universal-apple-darwin': ['macos_universal', ['.dmg']],
};
if (!platforms[target]) throw new Error(`Unsupported release target: ${target}`);
const [platform, extensions] = platforms[target];
const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) throw new Error('Missing application version');
const bundle = join(root, 'src-tauri/target', target, 'release/bundle');
const packages = readdirSync(bundle, { recursive: true })
  .filter(file => extensions.includes(extname(file)));
// Fail before uploading a partial set or silently replacing a localized installer.
for (const extension of extensions) {
  const matches = packages.filter(file => extname(file) === extension);
  if (matches.length !== 1) throw new Error(`Expected one ${extension} installer, found ${matches.length}`);
}
const output = join(root, 'installers');
mkdirSync(output, { recursive: true });
for (const file of packages) {
  const extension = extname(file);
  const suffix = extension === '.exe' ? '-setup' : '';
  const destination = join(output, `ReaLingo_${version}_${platform}${suffix}${extension}`);
  if (existsSync(destination)) throw new Error(`Installer already exists: ${basename(destination)}`);
  copyFileSync(join(bundle, file), destination);
  console.log(destination);
}
