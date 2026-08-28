declare module 'virtual:document-worker-resources' {
	interface EnhancementPackResource {
		path: string;
		size: number;
		sha256: string;
	}

	interface EnhancementPackManifest {
		packApiVersion: number;
		packVersion: string;
		documentWorkerCommit: string;
		documentWorkerArchiveSha256: string;
		resources: EnhancementPackResource[];
	}

	export const enhancementPackManifest: EnhancementPackManifest;
	export default function resourceContext(
		path: string,
	): string | undefined;
}
