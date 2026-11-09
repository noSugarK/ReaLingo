// Use Tauri's own density/adaptive-icon generator without rewriting desktop assets.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'realingo-icons-'));
try {
  execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
    'icon', join(root, 'brand/app-icon.png'), '--output', output], { stdio: 'inherit' });
  // CLI 2.11.4 emits 49px legacy hdpi icons; Android's 1.5x density requires 72px.
  // Resize the generated 192px versions with the same native tool.
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    const resized = join(output, name);
    execFileSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      'icon', join(output, `android/mipmap-xxxhdpi/${name}.png`), '--png', '72', '--output', resized], { stdio: 'inherit' });
    cpSync(join(resized, '72x72.png'), join(output, `android/mipmap-hdpi/${name}.png`));
  }
  cpSync(join(output, 'android/mipmap-anydpi-v26/ic_launcher.xml'),
    join(output, 'android/mipmap-anydpi-v26/ic_launcher_round.xml'));
  cpSync(join(output, 'android'), join(root, 'src-tauri/icons/android'), { recursive: true });
} finally {
  rmSync(output, { recursive: true, force: true });
}
