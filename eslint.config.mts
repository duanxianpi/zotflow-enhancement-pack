import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'.cache',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 12,
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'scripts/*.mjs',
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['scripts/**/*.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'no-restricted-globals': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
			'obsidianmd/rule-custom-message': 'off',
		},
	},
);
