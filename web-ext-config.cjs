module.exports = {
	ignoreFiles: [
		'docs',
		'node_modules',
		'package.json',
		'package-lock.json',
		'web-ext-config.cjs',
		'web-ext-artifacts',
		'.gitignore',
		'.eslintrc*',
		'.prettierrc*',
		'snoozz-*.zip',
	],
	build: {
		overwriteDest: true,
	},
};
