import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createTrailer,
	verifyBundle,
	sha256,
	protocol,
} from './pack-container.mjs';

test('deterministic v2 artifact round trip without executing the entry', () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'zfep-test-'));
	try {
		const raw = Buffer.from('test model');
		writeFileSync(path.join(directory, 'model.onnx'), raw);
		const resources = [
			{ path: 'model.onnx', size: raw.length, sha256: sha256(raw) },
		];
		const lock = {
			protocol,
			packVersion: '2.0.0',
			sdt: { packVersion: 1, schemaMajorVersion: 1 },
			documentWorker: {
				commit: 'a'.repeat(40),
			},
			resources,
		};
		const trailer = createTrailer(lock, directory);
		assert.deepEqual(trailer, createTrailer(lock, directory));
		const bytes = Buffer.concat([
			Buffer.from('throw new Error("must not execute");'),
			trailer,
		]);
		assert.equal(verifyBundle(bytes, lock).resources.length, 1);
		assert.throws(() =>
			verifyBundle(Buffer.concat([bytes, Buffer.from('\n')]), lock),
		);
		assert.throws(() => verifyBundle(bytes.subarray(0, -1), lock));
		const corrupt = Buffer.from(bytes);
		corrupt[bytes.indexOf(Buffer.from('\n/*ZFEP2\n')) + 9] = 33;
		assert.throws(() => verifyBundle(corrupt, lock));
		assert.throws(() =>
			createTrailer(
				{ ...lock, protocol: { major: 3, minor: 0 } },
				directory,
			),
		);
		// Packaging does not rescan cached contents; the final gate must catch
		// even same-size corruption, before the file can be released.
		writeFileSync(
			path.join(directory, 'model.onnx'),
			Buffer.alloc(raw.length, 65),
		);
		const damaged = createTrailer(lock, directory);
		assert.throws(
			() => verifyBundle(damaged, lock),
			/Resource round-trip mismatch/,
		);
	} finally {
		assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
		rmSync(directory, { recursive: true, force: true });
	}
});

test('release entry is a minimal plugin without resource exports', () => {
	const entry = readFileSync('src/main.ts', 'utf8');
	assert.doesNotMatch(
		entry,
		/pack-api|registry|readBinary|createObjectURL|new Worker/,
	);
});
