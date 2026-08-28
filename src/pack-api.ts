import resourceContext, {
	enhancementPackManifest,
} from 'virtual:document-worker-resources';

export const ENHANCEMENT_PACK_REGISTRY_KEY = '__zotflowEnhancementPackV1' as const;

export interface EnhancementPackResource {
	path: string;
	size: number;
	sha256: string;
}

export interface ZotFlowEnhancementPackManifest {
	packApiVersion: number;
	packVersion: string;
	documentWorkerCommit: string;
	documentWorkerArchiveSha256: string;
	resources: EnhancementPackResource[];
}

export interface CompressedEnhancementPackResource {
	encoding: 'gzip-base64';
	data: string;
}

export interface ZotFlowEnhancementPackApi {
	manifest: Readonly<ZotFlowEnhancementPackManifest>;
	getResource(path: string): CompressedEnhancementPackResource | undefined;
}

export function createEnhancementPackApi(): ZotFlowEnhancementPackApi {
	return Object.freeze({
		manifest: Object.freeze(enhancementPackManifest),
		getResource(path: string) {
			const data = resourceContext(path);
			return data === undefined
				? undefined
				: { encoding: 'gzip-base64' as const, data };
		},
	});
}
