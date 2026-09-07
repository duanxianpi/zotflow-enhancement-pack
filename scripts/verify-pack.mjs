import { readFileSync } from 'node:fs';
import { verifyBundle } from './pack-container.mjs';

const lock = JSON.parse(readFileSync('document-worker.lock.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const bytes = readFileSync('main.js');
if (
	manifest.version !== lock.packVersion ||
	packageJson.version !== lock.packVersion
)
	throw new Error('Release versions disagree');
verifyBundle(bytes, lock);
const entry = bytes
	.subarray(0, bytes.indexOf(Buffer.from('\n/*ZFEP2\n')))
	.toString();
if (
	/__zotflowEnhancementPack|createEnhancementPackApi|virtual:document-worker-resources/.test(
		entry,
	)
)
	throw new Error('Runtime resource API in plugin entry');
console.log(
	`Verified offline Pack v2: ${lock.resources.length} resources, ${bytes.length} bytes`,
);
