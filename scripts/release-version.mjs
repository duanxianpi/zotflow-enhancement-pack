import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BETA_VERSION_PATTERN = /^\d+\.\d+\.\d+-beta\.\d+$/u;

function parseOptions(args) {
	const options = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (
			!['--version', '--root'].includes(name) ||
			value === undefined ||
			options.has(name.slice(2))
		) {
			throw new Error(`Invalid argument: ${name ?? ''}`);
		}
		options.set(name.slice(2), value);
	}
	return options;
}

async function readJson(filePath) {
	const contents = await readFile(filePath, 'utf8');
	return { contents, value: JSON.parse(contents) };
}

function serializeJson(value, original) {
	const indent = original.match(/\n([\t ]+)"/u)?.[1] ?? '\t';
	const newline = original.endsWith('\n') ? '\n' : '';
	return `${JSON.stringify(value, null, indent)}${newline}`;
}

function resolveFiles(root) {
	return {
		packageJson: path.join(root, 'package.json'),
		packageLock: path.join(root, 'package-lock.json'),
		manifest: path.join(root, 'manifest.json'),
		versions: path.join(root, 'versions.json'),
		lock: path.join(root, 'document-worker.lock.json'),
	};
}

function assertBetaVersion(version) {
	if (!BETA_VERSION_PATTERN.test(version)) {
		throw new Error(`Invalid Pack beta version: ${version}`);
	}
}

export async function prepareBetaVersion({ root = process.cwd(), version }) {
	assertBetaVersion(version);
	const files = resolveFiles(root);
	const [packageJson, packageLock, manifest, versions, lock] =
		await Promise.all([
			readJson(files.packageJson),
			readJson(files.packageLock),
			readJson(files.manifest),
			readJson(files.versions),
			readJson(files.lock),
		]);
	if (!packageLock.value.packages?.['']) {
		throw new Error('package-lock.json does not contain the root package');
	}

	packageJson.value.version = version;
	packageLock.value.version = version;
	packageLock.value.packages[''].version = version;
	manifest.value.version = version;
	versions.value[version] = manifest.value.minAppVersion;
	lock.value.packVersion = version;

	await Promise.all([
		writeFile(
			files.packageJson,
			serializeJson(packageJson.value, packageJson.contents),
			'utf8',
		),
		writeFile(
			files.packageLock,
			serializeJson(packageLock.value, packageLock.contents),
			'utf8',
		),
		writeFile(
			files.manifest,
			serializeJson(manifest.value, manifest.contents),
			'utf8',
		),
		writeFile(
			files.versions,
			serializeJson(versions.value, versions.contents),
			'utf8',
		),
		writeFile(files.lock, serializeJson(lock.value, lock.contents), 'utf8'),
	]);
}

export async function verifyBetaVersion({ root = process.cwd(), version }) {
	assertBetaVersion(version);
	const files = resolveFiles(root);
	const [packageJson, packageLock, manifest, versions, lock] =
		await Promise.all([
			readJson(files.packageJson),
			readJson(files.packageLock),
			readJson(files.manifest),
			readJson(files.versions),
			readJson(files.lock),
		]);
	const values = [
		['package.json', packageJson.value.version],
		['package-lock.json', packageLock.value.version],
		[
			'package-lock root package',
			packageLock.value.packages?.['']?.version,
		],
		['manifest.json', manifest.value.version],
		['document-worker.lock.json', lock.value.packVersion],
	];
	for (const [label, actual] of values) {
		if (actual !== version) {
			throw new Error(
				`${label} version is ${actual ?? 'missing'}, not ${version}`,
			);
		}
	}
	if (versions.value[version] !== manifest.value.minAppVersion) {
		throw new Error(
			`versions.json does not map ${version} to ${manifest.value.minAppVersion}`,
		);
	}
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (!['prepare', 'verify'].includes(command)) {
		throw new Error(
			'Usage: release-version.mjs <prepare|verify> --version <x.y.z-beta.N> [--root <path>]',
		);
	}
	const options = parseOptions(args);
	const version = options.get('version');
	if (!version) throw new Error('--version is required');
	const operation =
		command === 'prepare' ? prepareBetaVersion : verifyBetaVersion;
	await operation({
		root: path.resolve(options.get('root') ?? process.cwd()),
		version,
	});
	process.stdout.write(`${JSON.stringify({ channel: 'beta', version })}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
	await main();
}
