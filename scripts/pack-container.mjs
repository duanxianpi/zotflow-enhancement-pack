import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const sha256 = (bytes) =>
	createHash('sha256').update(bytes).digest('hex');
export const componentId = 'document-worker.sdt';
export const protocol = { major: 2, minor: 0 };
export const comparePaths = (a, b) =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
export function mediaType(file) {
	if (file.endsWith('.js')) return 'text/javascript';
	if (file.endsWith('.json')) return 'application/json';
	if (file.endsWith('.wasm')) return 'application/wasm';
	return 'application/octet-stream';
}
export function createTrailer(lock, directory) {
	if (JSON.stringify(lock.protocol) !== JSON.stringify(protocol)) {
		throw new Error('Unsupported Pack container');
	}
	let offset = 0;
	const payloads = [];
	const resources = [...lock.resources].sort(comparePaths).map((resource) => {
		if (
			!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(resource.path) ||
			resource.path.split('/').some((p) => p === '.' || p === '..')
		) {
			throw new Error('Invalid resource path');
		}
		const raw = readFileSync(path.join(directory, resource.path));
		if (raw.length !== resource.size)
			throw new Error(`Resource mismatch: ${resource.path}`);
		const encoded = gzipSync(raw, { level: 9 }).toString('base64');
		payloads.push(encoded);
		const entry = {
			component: componentId,
			path: resource.path,
			mediaType: mediaType(resource.path),
			encoding: 'gzip-base64',
			offset,
			length: encoded.length,
			decodedSize: raw.length,
			sha256: resource.sha256,
		};
		offset += encoded.length;
		return entry;
	});
	const manifest = {
		schemaVersion: 1,
		protocol,
		pack: { id: 'zotflow-enhancement-pack', version: lock.packVersion },
		components: [
			{
				id: componentId,
				source: {
					documentWorkerCommit: lock.documentWorker.commit,
				},
				sdt: lock.sdt,
				resourcePaths: resources.map((r) => r.path),
			},
		],
		resources,
	};
	const json = Buffer.from(JSON.stringify(manifest));
	const encodedManifest = json.toString('base64');
	const footer = `\nZFEP2|${offset.toString(16).padStart(16, '0')}|${encodedManifest.length.toString(16).padStart(16, '0')}|${sha256(json)}|END*/\n`;
	return Buffer.from(
		`\n/*ZFEP2\n${payloads.join('')}${encodedManifest}${footer}`,
	);
}

/** Independent build-time round trip. The plugin entry is never evaluated. */
export function verifyBundle(bytes, lock) {
	const footer = bytes.subarray(-112).toString('ascii');
	const match =
		/^\nZFEP2\|([0-9a-f]{16})\|([0-9a-f]{16})\|([0-9a-f]{64})\|END\*\/\n$/.exec(
			footer,
		);
	if (!match) throw new Error('Invalid v2 footer');
	const p = Number.parseInt(match[1], 16),
		m = Number.parseInt(match[2], 16);
	if (
		!Number.isSafeInteger(p) ||
		!Number.isSafeInteger(m) ||
		p <= 0 ||
		m <= 0 ||
		p + m + 121 > bytes.length
	)
		throw new Error('Invalid footer bounds');
	const manifestStart = bytes.length - 112 - m,
		payloadStart = manifestStart - p;
	if (
		bytes.subarray(payloadStart - 9, payloadStart).toString() !==
		'\n/*ZFEP2\n'
	)
		throw new Error('Invalid OPEN');
	const encoded = bytes.subarray(manifestStart, manifestStart + m).toString();
	const json = Buffer.from(encoded, 'base64');
	if (json.toString('base64') !== encoded || sha256(json) !== match[3])
		throw new Error('Invalid manifest hash');
	const manifest = JSON.parse(json.toString('utf8'));
	if (
		manifest.pack.version !== lock.packVersion ||
		manifest.pack.id !== 'zotflow-enhancement-pack' ||
		JSON.stringify(manifest.protocol) !== JSON.stringify(protocol) ||
		manifest.components.length !== 1 ||
		manifest.components[0].source.documentWorkerCommit !==
			lock.documentWorker.commit ||
		JSON.stringify(manifest.components[0].sdt) !== JSON.stringify(lock.sdt)
	)
		throw new Error('Incompatible build manifest');
	if (manifest.resources.length !== lock.resources.length)
		throw new Error('Resource count mismatch');
	let end = 0;
	const expected = [...lock.resources].sort(comparePaths);
	for (const [index, r] of manifest.resources.entries()) {
		const e = expected[index];
		if (
			r.offset !== end ||
			r.length <= 0 ||
			end + r.length > p ||
			r.component !== componentId ||
			r.path !== e.path ||
			r.sha256 !== e.sha256 ||
			r.decodedSize !== e.size ||
			r.mediaType !== mediaType(r.path) ||
			r.encoding !== 'gzip-base64'
		)
			throw new Error('Invalid resource index');
		const base64 = bytes
			.subarray(
				payloadStart + r.offset,
				payloadStart + r.offset + r.length,
			)
			.toString();
		const gzip = Buffer.from(base64, 'base64');
		if (gzip.toString('base64') !== base64)
			throw new Error('Invalid resource base64');
		const raw = gunzipSync(gzip, { maxOutputLength: Math.max(1, e.size) });
		if (raw.length !== e.size || sha256(raw) !== e.sha256)
			throw new Error('Resource round-trip mismatch');
		end += r.length;
	}
	if (end !== p) throw new Error('Unindexed payload bytes');
	return manifest;
}
