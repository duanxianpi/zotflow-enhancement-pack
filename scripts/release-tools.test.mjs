import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getContractFingerprint } from './contract-fingerprint.mjs';
import { prepareBetaVersion, verifyBetaVersion } from './release-version.mjs';

function sourceLock(resourceHash = 'b'.repeat(64)) {
	return {
		schemaVersion: 1,
		documentWorker: {
			commit: 'a'.repeat(40),
			archiveSize: 123,
			archiveSha256: 'c'.repeat(64),
		},
		enhancementPack: {
			protocol: { major: 2, minor: 0 },
			include: ['metadata.json', 'onnx/'],
			sdt: { packVersion: 1, schemaMajorVersion: 1 },
			resources: [
				{ path: 'metadata.json', size: 10, sha256: resourceHash },
			],
		},
	};
}

async function createFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'zotflow-pack-release-'));
	const files = {
		'package.json': { name: 'zotflow-enhancement-pack', version: '2.1.0' },
		'package-lock.json': {
			name: 'zotflow-enhancement-pack',
			version: '2.1.0',
			lockfileVersion: 3,
			packages: {
				'': { name: 'zotflow-enhancement-pack', version: '2.1.0' },
			},
		},
		'manifest.json': {
			id: 'zotflow-enhancement-pack',
			version: '2.1.0',
			minAppVersion: '1.11.4',
		},
		'versions.json': { '2.1.0': '1.11.4' },
		'document-worker.lock.json': {
			...sourceLock(),
			packVersion: '2.1.0',
		},
	};
	await Promise.all(
		Object.entries(files).map(([name, value]) =>
			writeFile(
				path.join(root, name),
				`${JSON.stringify(value, null, '\t')}\n`,
				'utf8',
			),
		),
	);
	return root;
}

test('contract fingerprint ignores object and list ordering', () => {
	const left = sourceLock();
	const right = sourceLock();
	right.enhancementPack.include.reverse();
	assert.equal(getContractFingerprint(left), getContractFingerprint(right));
});

test('contract fingerprint changes with resource contents', () => {
	assert.notEqual(
		getContractFingerprint(sourceLock()),
		getContractFingerprint(sourceLock('d'.repeat(64))),
	);
});

test('prepares and verifies every Pack beta version field', async () => {
	const root = await createFixture();
	try {
		await prepareBetaVersion({ root, version: '2.1.0-beta.1' });
		await verifyBetaVersion({ root, version: '2.1.0-beta.1' });
		const lock = JSON.parse(
			await readFile(
				path.join(root, 'document-worker.lock.json'),
				'utf8',
			),
		);
		assert.equal(lock.packVersion, '2.1.0-beta.1');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects a non-beta Pack version', async () => {
	const root = await createFixture();
	try {
		await assert.rejects(
			prepareBetaVersion({ root, version: '2.1.0' }),
			/Invalid Pack beta version/u,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
