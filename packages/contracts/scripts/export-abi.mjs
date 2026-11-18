import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = path.join(root, 'out', 'MemOceanMarketplace.sol', 'MemOceanMarketplace.json');
const destination = path.join(root, 'abi', 'MemOceanMarketplace.json');
const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
if (!Array.isArray(artifact.abi)) throw new Error(`ABI missing from ${artifactPath}`);
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact.abi, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, destination)}`);
