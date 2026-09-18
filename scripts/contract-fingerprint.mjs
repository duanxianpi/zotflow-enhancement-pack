import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

export function getContract(lock) {
	const worker = lock.documentWorker;
	const pack = lock.enhancementPack;
	if (
		lock.schemaVersion !== 1 ||
		!COMMIT_PATTERN.test(worker?.commit ?? '') ||
		!SHA256_PATTERN.test(worker?.archiveSha256 ?? '') ||
		!Number.isSafeInteger(worker?.archiveSize) ||
		worker.archiveSize <= 0 ||
		!pack ||
		!Array.isArray(pack.include) ||
		!Array.isArray(pack.resources)
	) {
		throw new Error('Invalid ZotFlow Enhancement Pack contract');
	}

	return canonicalize({
		documentWorker: {
			archiveSha256: worker.archiveSha256,
			archiveSize: worker.archiveSize,
			commit: worker.commit,
		},
		include: [...pack.include].sort(),
		protocol: pack.protocol,
		resources: [...pack.resources].sort((left, right) =>
			left.path.localeCompare(right.path),
		),
		sdt: pack.sdt,
	});
}

export function getContractFingerprint(lock) {
	return createHash('sha256')
		.update(JSON.stringify(getContract(lock)))
		.digest('hex');
}

async function main() {
	const [input] = process.argv.slice(2);
	if (!input) {
		throw new Error('Usage: contract-fingerprint.mjs <zotflow-lock.json>');
	}
	const lock = JSON.parse(await readFile(path.resolve(input), 'utf8'));
	process.stdout.write(`${getContractFingerprint(lock)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
	await main();
}
