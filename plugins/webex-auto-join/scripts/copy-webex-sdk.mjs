import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(path.dirname(require.resolve('webex')));
const source = path.join(packageRoot, 'umd', 'webex.min.js');
const destination = fileURLToPath(new URL('../dist/webex.min.js', import.meta.url));
const licenseDestination = fileURLToPath(new URL('../dist/WEBEX-SDK-LICENSE', import.meta.url));

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
await copyFile(path.join(packageRoot, 'LICENSE'), licenseDestination);
