import { Plugin } from 'obsidian';
import {
	ENHANCEMENT_PACK_REGISTRY_KEY,
	createEnhancementPackApi,
	type ZotFlowEnhancementPackApi,
} from './pack-api';

type EnhancementPackWindow = typeof window & {
	[ENHANCEMENT_PACK_REGISTRY_KEY]?: ZotFlowEnhancementPackApi;
};

export default class ZotFlowEnhancementPackPlugin extends Plugin {
	private api: ZotFlowEnhancementPackApi | undefined;

	onload() {
		const registry = window as EnhancementPackWindow;
		this.api = createEnhancementPackApi();
		registry[ENHANCEMENT_PACK_REGISTRY_KEY] = this.api;
	}

	onunload() {
		const registry = window as EnhancementPackWindow;
		if (registry[ENHANCEMENT_PACK_REGISTRY_KEY] === this.api) {
			delete registry[ENHANCEMENT_PACK_REGISTRY_KEY];
		}
		this.api = undefined;
	}
}
