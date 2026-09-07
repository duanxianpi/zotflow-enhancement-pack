import { Notice, Plugin } from 'obsidian';

/** Distribution shell only. ZotFlow reads the offline trailer without enabling us. */
export default class ZotFlowEnhancementPackPlugin extends Plugin {
	onload() {
		new Notice(
			'ZotFlow Enhancement Pack: Only installation is required. You can keep this enhancement pack disabled.',
			0,
		);
	}
}
