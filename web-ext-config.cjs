module.exports = {
	ignoreFiles: [
		'build.py',
		'safari.sh',
		'instructions_safari.txt',
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
