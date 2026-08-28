import { createHash } from 'node:crypto';
import {
	access,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';

const PACK_LOCK_PATH = path.resolve('document-worker.lock.json');
const CACHE_ROOT = path.resolve('.cache', 'document-worker');
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function sha256(contents) {
	return createHash('sha256').update(contents).digest('hex');
}

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

async function readInput(input) {
	if (/^https?:\/\//u.test(input)) {
		const response = await fetch(input);
		if (!response.ok) {
			throw new Error(
				`Failed to read ${input}: ${response.status} ${response.statusText}`,
			);
		}
		return Buffer.from(await response.arrayBuffer());
	}
	return readFile(path.resolve(input));
}

function validateSourceLock(lock) {
	if (lock.schemaVersion !== 1) {
		throw new Error(
			`Unsupported ZotFlow lock schema: ${lock.schemaVersion}`,
		);
	}
	const worker = lock.documentWorker;
	if (!worker || !COMMIT_PATTERN.test(worker.commit)) {
		throw new Error(
			'ZotFlow lock contains an invalid Document Worker commit',
		);
	}
	if (!SHA256_PATTERN.test(worker.archiveSha256)) {
		throw new Error('ZotFlow lock contains an invalid archive SHA-256');
	}
	if (!Number.isSafeInteger(worker.archiveSize) || worker.archiveSize <= 0) {
		throw new Error('ZotFlow lock contains an invalid archive size');
	}
	if (!Array.isArray(lock.enhancementPack?.include)) {
		throw new Error(
			'ZotFlow lock does not declare Enhancement Pack resources',
		);
	}
}

function validatePackLock(lock) {
	if (
		lock.schemaVersion !== 1 ||
		!COMMIT_PATTERN.test(lock.documentWorker?.commit)
	) {
		throw new Error('Invalid Enhancement Pack Document Worker lock');
	}
	if (!SHA256_PATTERN.test(lock.documentWorker.archiveSha256)) {
		throw new Error('Invalid Enhancement Pack archive SHA-256');
	}
	if (!Array.isArray(lock.resources) || lock.resources.length === 0) {
		throw new Error('Enhancement Pack lock contains no resources');
	}
}

async function downloadArchive(worker) {
	const response = await fetch(worker.archiveUrl);
	if (!response.ok) {
		throw new Error(
			`Document Worker download failed: ${response.status} ${response.statusText}`,
		);
	}
	const archive = Buffer.from(await response.arrayBuffer());
	if (archive.byteLength !== worker.archiveSize) {
		throw new Error(
			`Document Worker archive size mismatch: expected ${worker.archiveSize}, got ${archive.byteLength}`,
		);
	}
	const actualSha256 = sha256(archive);
	if (actualSha256 !== worker.archiveSha256) {
		throw new Error(
			`Document Worker archive SHA-256 mismatch: expected ${worker.archiveSha256}, got ${actualSha256}`,
		);
	}
	return archive;
}

function isSafeResourcePath(resourcePath) {
	return (
		!path.isAbsolute(resourcePath) &&
		!resourcePath.split('/').includes('..') &&
		!resourcePath.includes('\\')
	);
}

function selectResources(zip, includes) {
	const files = Object.values(zip.files).filter((entry) => !entry.dir);
	for (const include of includes) {
		const matched = include.endsWith('/')
			? files.some((entry) => entry.name.startsWith(include))
			: files.some((entry) => entry.name === include);
		if (!matched) {
			throw new Error(
				`Document Worker archive does not contain ${include}`,
			);
		}
	}

	return files
		.filter((entry) =>
			includes.some((include) =>
				include.endsWith('/')
					? entry.name.startsWith(include)
					: entry.name === include,
			),
		)
		.map((entry) => {
			if (!isSafeResourcePath(entry.name)) {
				throw new Error(
					`Unsafe resource path in archive: ${entry.name}`,
				);
			}
			return entry;
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

function bumpMinor(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
	if (!match) {
		throw new Error(`Cannot bump invalid version: ${version}`);
	}
	return `${match[1]}.${Number(match[2]) + 1}.0`;
}

async function writeJson(filePath, value) {
	await writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

async function updatePackVersion(version) {
	const packagePath = path.resolve('package.json');
	const manifestPath = path.resolve('manifest.json');
	const versionsPath = path.resolve('versions.json');
	const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	const versions = JSON.parse(await readFile(versionsPath, 'utf8'));

	packageJson.version = version;
	manifest.version = version;
	versions[version] = manifest.minAppVersion;

	await Promise.all([
		writeJson(packagePath, packageJson),
		writeJson(manifestPath, manifest),
		writeJson(versionsPath, versions),
	]);
}

async function sync(options) {
	const sourceInput = options.get('zotflow-lock');
	const zotflowCommit = options.get('zotflow-commit');
	const bump = options.get('bump') ?? 'none';
	if (!sourceInput || !zotflowCommit) {
		throw new Error(
			'sync requires --zotflow-lock <path-or-url> and --zotflow-commit <commit>',
		);
	}
	if (bump !== 'none' && bump !== 'minor') {
		throw new Error('--bump must be none or minor');
	}

	const sourceBytes = await readInput(sourceInput);
	const sourceLock = JSON.parse(sourceBytes.toString('utf8'));
	validateSourceLock(sourceLock);
	const sourceLockSha256 = sha256(sourceBytes);

	let currentLock;
	try {
		currentLock = JSON.parse(await readFile(PACK_LOCK_PATH, 'utf8'));
	} catch {
		currentLock = undefined;
	}
	if (
		currentLock !== undefined &&
		currentLock.packApiVersion !== sourceLock.enhancementPack.apiVersion
	) {
		throw new Error(
			`Enhancement Pack API migration required: Pack uses v${currentLock.packApiVersion}, ZotFlow requires v${sourceLock.enhancementPack.apiVersion}. Update the Pack interface and perform a manual major release.`,
		);
	}
	const alreadyCurrent =
		currentLock?.documentWorker?.commit ===
			sourceLock.documentWorker.commit &&
		currentLock?.documentWorker?.archiveSha256 ===
			sourceLock.documentWorker.archiveSha256 &&
		currentLock?.documentWorker?.archiveSize ===
			sourceLock.documentWorker.archiveSize &&
		JSON.stringify(currentLock?.source?.include) ===
			JSON.stringify(sourceLock.enhancementPack.include);
	if (alreadyCurrent) {
		console.log('Enhancement Pack already matches the ZotFlow lock');
		return;
	}

	const archive = await downloadArchive(sourceLock.documentWorker);
	const zip = await JSZip.loadAsync(archive);
	const selected = selectResources(zip, sourceLock.enhancementPack.include);
	const resources = [];
	for (const entry of selected) {
		const contents = Buffer.from(await entry.async('uint8array'));
		resources.push({
			path: entry.name,
			size: contents.byteLength,
			sha256: sha256(contents),
		});
	}

	const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
	const nextVersion =
		bump === 'minor' ? bumpMinor(packageJson.version) : packageJson.version;
	const nextLock = {
		schemaVersion: 1,
		source: {
			repository: 'duanxianpi/zotflow',
			zotflowCommit,
			lockSha256: sourceLockSha256,
			include: sourceLock.enhancementPack.include,
		},
		packApiVersion: sourceLock.enhancementPack.apiVersion,
		packVersion: nextVersion,
		documentWorker: sourceLock.documentWorker,
		resources,
	};

	await writeJson(PACK_LOCK_PATH, nextLock);
	if (bump === 'minor') {
		await updatePackVersion(nextVersion);
	}
	console.log(
		`Synchronized ${resources.length} resources for Document Worker ${sourceLock.documentWorker.commit}`,
	);
}

async function readCachedArchive(worker) {
	await mkdir(CACHE_ROOT, { recursive: true });
	const archivePath = path.join(CACHE_ROOT, `${worker.commit}.zip`);
	try {
		const cached = await readFile(archivePath);
		if (
			cached.byteLength === worker.archiveSize &&
			sha256(cached) === worker.archiveSha256
		) {
			return cached;
		}
	} catch {
		// A missing or invalid cache is replaced below.
	}

	const archive = await downloadArchive(worker);
	const temporaryPath = `${archivePath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, archive);
	await rm(archivePath, { force: true });
	await rename(temporaryPath, archivePath);
	return archive;
}

async function hasValidExtractedResources(directory, resources) {
	try {
		await access(directory);
		for (const resource of resources) {
			const contents = await readFile(
				path.join(directory, resource.path),
			);
			if (
				contents.byteLength !== resource.size ||
				sha256(contents) !== resource.sha256
			) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

async function fetchResources() {
	const lock = JSON.parse(await readFile(PACK_LOCK_PATH, 'utf8'));
	validatePackLock(lock);
	const targetDirectory = path.join(
		CACHE_ROOT,
		lock.documentWorker.commit,
		'resources',
	);
	if (await hasValidExtractedResources(targetDirectory, lock.resources)) {
		console.log(
			'Document Worker resources are already cached and verified',
		);
		return;
	}

	const archive = await readCachedArchive(lock.documentWorker);
	const zip = await JSZip.loadAsync(archive);
	const stagingDirectory = path.join(
		CACHE_ROOT,
		`.staging-${lock.documentWorker.commit}-${process.pid}`,
	);
	await rm(stagingDirectory, { recursive: true, force: true });
	await mkdir(stagingDirectory, { recursive: true });

	try {
		for (const resource of lock.resources) {
			if (!isSafeResourcePath(resource.path)) {
				throw new Error(
					`Unsafe resource path in lock: ${resource.path}`,
				);
			}
			const entry = zip.file(resource.path);
			if (!entry) {
				throw new Error(
					`Resource missing from archive: ${resource.path}`,
				);
			}
			const contents = Buffer.from(await entry.async('uint8array'));
			if (
				contents.byteLength !== resource.size ||
				sha256(contents) !== resource.sha256
			) {
				throw new Error(
					`Resource verification failed: ${resource.path}`,
				);
			}
			const outputPath = path.join(stagingDirectory, resource.path);
			await mkdir(path.dirname(outputPath), { recursive: true });
			await writeFile(outputPath, contents);
		}

		await mkdir(path.dirname(targetDirectory), { recursive: true });
		await rm(targetDirectory, { recursive: true, force: true });
		await rename(stagingDirectory, targetDirectory);
	} catch (error) {
		await rm(stagingDirectory, { recursive: true, force: true });
		throw error;
	}

	console.log(`Cached and verified ${lock.resources.length} resources`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'sync') {
	await sync(parseOptions(args));
} else if (command === 'fetch') {
	if (args.length > 0) {
		throw new Error('fetch does not accept arguments');
	}
	await fetchResources();
} else {
	throw new Error(
		'Usage: document-worker-resources.mjs <sync|fetch> [options]',
	);
}
