import { createHash } from 'node:crypto';
import { stat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';
import { protocol } from './pack-container.mjs';

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
		if (
			!['--zotflow-lock', '--zotflow-commit', '--bump'].includes(name) ||
			value === undefined ||
			options.has(name.slice(2))
		) {
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
	if (
		JSON.stringify(lock.enhancementPack?.protocol) !==
		JSON.stringify(protocol)
	) {
		throw new Error('Unsupported resource protocol');
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
		JSON.stringify(lock.protocol) !== JSON.stringify(protocol) ||
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

	const currentLock = JSON.parse(await readFile(PACK_LOCK_PATH, 'utf8'));
	validatePackLock(currentLock);
	const alreadyCurrent =
		JSON.stringify(currentLock.protocol) === JSON.stringify(protocol) &&
		JSON.stringify(currentLock.sdt) ===
			JSON.stringify(sourceLock.enhancementPack.sdt) &&
		JSON.stringify(currentLock.resources) ===
			JSON.stringify(sourceLock.enhancementPack.resources) &&
		currentLock.documentWorker?.commit ===
			sourceLock.documentWorker.commit &&
		currentLock.documentWorker?.archiveSha256 ===
			sourceLock.documentWorker.archiveSha256 &&
		currentLock.documentWorker?.archiveSize ===
			sourceLock.documentWorker.archiveSize &&
		JSON.stringify(currentLock.source?.include) ===
			JSON.stringify(sourceLock.enhancementPack.include);
	if (alreadyCurrent) {
		console.log('Enhancement Pack already matches the ZotFlow lock');
		return;
	}

	const archive = await readCachedArchive(sourceLock.documentWorker);
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

	const expected = new Map(
		sourceLock.enhancementPack.resources.map((r) => [r.path, r]),
	);
	if (
		resources.length !== expected.size ||
		resources.some((r) => {
			const pinned = expected.get(r.path);
			return (
				!pinned || pinned.size !== r.size || pinned.sha256 !== r.sha256
			);
		})
	)
		throw new Error('ZotFlow resource metadata mismatch');
	const metadata = JSON.parse(
		await zip.file('metadata.json').async('string'),
	);
	const sdt = {
		packVersion: metadata.SDT_PACK_VERSION,
		schemaMajorVersion: Number(metadata.SDT_SCHEMA_VERSION.split('.')[0]),
	};
	if (JSON.stringify(sdt) !== JSON.stringify(sourceLock.enhancementPack.sdt))
		throw new Error('SDT metadata mismatch');
	const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
	const nextVersion =
		bump === 'minor' ? bumpMinor(packageJson.version) : packageJson.version;
	const nextLock = {
		schemaVersion: 1,
		source: {
			repository: 'duanxianpi/zotflow',
			zotflowCommit,
			include: sourceLock.enhancementPack.include,
		},
		protocol,
		sdt,
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

async function hasExtractedResources(directory, resources) {
	try {
		for (const resource of resources) {
			const info = await stat(path.join(directory, resource.path));
			if (!info.isFile() || info.size !== resource.size) {
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
	if (await hasExtractedResources(targetDirectory, lock.resources)) {
		console.log(
			'Document Worker resources are cached; final build verifies contents',
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
			if (contents.byteLength !== resource.size) {
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

	console.log(
		`Cached ${lock.resources.length} resources; final build verifies contents`,
	);
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
