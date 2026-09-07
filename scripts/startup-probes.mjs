import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const RESOURCE_TRAILER_PREFIX = Buffer.from(
	'\n/*ZFEP2\n',
);
const PROBE_PREFIX = Buffer.from('\n/*__ZOTFLOW_STARTUP_PROBE_V1__\n');
const PROBE_SUFFIX = Buffer.from('\n__END_ZOTFLOW_STARTUP_PROBE_V1__*/\n');
const PROBE_SIZES_MIB = [0, 4, 8, 16];

function parseOptions(args) {
	const options = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (!name?.startsWith('--') || value === undefined) {
			throw new Error(`Invalid argument: ${name ?? ''}`);
		}
		options.set(name.slice(2), value);
	}
	return options;
}

function sha256(contents) {
	return createHash('sha256').update(contents).digest('hex');
}

const options = parseOptions(process.argv.slice(2));
const outputOption = options.get('output');
const activateOption = options.get('activate');
if (!outputOption) {
	throw new Error('startup-probes requires --output <plugin-directory>');
}

const activeSize = activateOption === undefined ? undefined : Number(activateOption);
if (
	activeSize !== undefined &&
	(!Number.isInteger(activeSize) || !PROBE_SIZES_MIB.includes(activeSize))
) {
	throw new Error('--activate must be one of: 0, 4, 8, 16');
}

const bundle = await readFile(path.resolve('main.js'));
const trailerOffset = bundle.lastIndexOf(RESOURCE_TRAILER_PREFIX);
if (trailerOffset < 0) {
	throw new Error('Enhancement Pack resource trailer was not found in main.js');
}
const executable = bundle.subarray(0, trailerOffset);
const outputDirectory = path.resolve(outputOption);
const results = [];

for (const sizeMiB of PROBE_SIZES_MIB) {
	const filler = Buffer.alloc(sizeMiB * 1024 * 1024, 65);
	const probe =
		sizeMiB === 0
			? executable
			: Buffer.concat([executable, PROBE_PREFIX, filler, PROBE_SUFFIX]);
	const name = `main.probe-${sizeMiB}mib.js`;
	await writeFile(path.join(outputDirectory, name), probe);
	results.push({
		name,
		payloadMiB: sizeMiB,
		bytes: probe.byteLength,
		sha256: sha256(probe),
	});

	if (activeSize === sizeMiB) {
		await writeFile(path.join(outputDirectory, 'main.js'), probe);
	}
}

await writeFile(
	path.join(outputDirectory, 'startup-probes.json'),
	`${JSON.stringify({ activeSizeMiB: activeSize ?? null, files: results }, null, 2)}\n`,
	'utf8',
);

console.table(results);
if (activeSize !== undefined) {
	console.log(`Activated ${activeSize} MiB startup probe`);
}
