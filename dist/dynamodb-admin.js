#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const argparse = require('argparse');
const process$1 = require('node:process');
const node_buffer = require('node:buffer');
const path = require('node:path');
const node_url = require('node:url');
const node_util = require('node:util');
const childProcess = require('node:child_process');
const fs$1 = require('node:fs/promises');
const os = require('node:os');
const clc = require('cli-color');
const backend = require('./backend.js');
require('express');
require('@aws-sdk/client-dynamodb');
require('errorhandler');
require('body-parser');
require('lodash.pickby');
require('cookie-parser');
require('@aws-sdk/lib-dynamodb');
require('@aws-sdk/util-dynamodb');

var _documentCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;
let isDockerCached;

function hasDockerEnv() {
	try {
		fs.statSync('/.dockerenv');
		return true;
	} catch {
		return false;
	}
}

function hasDockerCGroup() {
	try {
		return fs.readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
	} catch {
		return false;
	}
}

function isDocker() {
	// TODO: Use `??=` when targeting Node.js 16.
	if (isDockerCached === undefined) {
		isDockerCached = hasDockerEnv() || hasDockerCGroup();
	}

	return isDockerCached;
}

let cachedResult;

// Podman detection
const hasContainerEnv = () => {
	try {
		fs.statSync('/run/.containerenv');
		return true;
	} catch {
		return false;
	}
};

function isInsideContainer() {
	// TODO: Use `??=` when targeting Node.js 16.
	if (cachedResult === undefined) {
		cachedResult = hasContainerEnv() || isDocker();
	}

	return cachedResult;
}

const isWsl = () => {
	if (process$1.platform !== 'linux') {
		return false;
	}

	if (os.release().toLowerCase().includes('microsoft')) {
		if (isInsideContainer()) {
			return false;
		}

		return true;
	}

	try {
		if (fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')) {
			return !isInsideContainer();
		}
	} catch {}

	// Fallback for custom kernels: check WSL-specific paths.
	if (
		fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')
		|| fs.existsSync('/run/WSL')
	) {
		return !isInsideContainer();
	}

	return false;
};

const isWsl$1 = process$1.env.__IS_WSL_TEST__ ? isWsl : isWsl();

const wslDrivesMountPoint = (() => {
	// Default value for "root" param
	// according to https://docs.microsoft.com/en-us/windows/wsl/wsl-config
	const defaultMountPoint = '/mnt/';

	let mountPoint;

	return async function () {
		if (mountPoint) {
			// Return memoized mount point value
			return mountPoint;
		}

		const configFilePath = '/etc/wsl.conf';

		let isConfigFileExists = false;
		try {
			await fs$1.access(configFilePath, fs$1.constants.F_OK);
			isConfigFileExists = true;
		} catch {}

		if (!isConfigFileExists) {
			return defaultMountPoint;
		}

		const configContent = await fs$1.readFile(configFilePath, {encoding: 'utf8'});
		const configMountPoint = /(?<!#.*)root\s*=\s*(?<mountPoint>.*)/g.exec(configContent);

		if (!configMountPoint) {
			return defaultMountPoint;
		}

		mountPoint = configMountPoint.groups.mountPoint.trim();
		mountPoint = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;

		return mountPoint;
	};
})();

const powerShellPathFromWsl = async () => {
	const mountPoint = await wslDrivesMountPoint();
	return `${mountPoint}c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`;
};

const powerShellPath = async () => {
	if (isWsl$1) {
		return powerShellPathFromWsl();
	}

	return `${process$1.env.SYSTEMROOT || process$1.env.windir || String.raw`C:\Windows`}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
};

function defineLazyProperty(object, propertyName, valueGetter) {
	const define = value => Object.defineProperty(object, propertyName, {value, enumerable: true, writable: true});

	Object.defineProperty(object, propertyName, {
		configurable: true,
		enumerable: true,
		get() {
			const result = valueGetter();
			define(result);
			return result;
		},
		set(value) {
			define(value);
		}
	});

	return object;
}

const execFileAsync$3 = node_util.promisify(childProcess.execFile);

async function defaultBrowserId() {
	if (process$1.platform !== 'darwin') {
		throw new Error('macOS only');
	}

	const {stdout} = await execFileAsync$3('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers']);

	// `(?!-)` is to prevent matching `LSHandlerRoleAll = "-";`.
	const match = /LSHandlerRoleAll = "(?!-)(?<id>[^"]+?)";\s+?LSHandlerURLScheme = (?:http|https);/.exec(stdout);

	const browserId = match?.groups.id ?? 'com.apple.Safari';

	// Correct the case for Safari's bundle identifier
	if (browserId === 'com.apple.safari') {
		return 'com.apple.Safari';
	}

	return browserId;
}

const execFileAsync$2 = node_util.promisify(childProcess.execFile);

async function runAppleScript(script, {humanReadableOutput = true, signal} = {}) {
	if (process$1.platform !== 'darwin') {
		throw new Error('macOS only');
	}

	const outputArguments = humanReadableOutput ? [] : ['-ss'];

	const execOptions = {};
	if (signal) {
		execOptions.signal = signal;
	}

	const {stdout} = await execFileAsync$2('osascript', ['-e', script, outputArguments], execOptions);
	return stdout.trim();
}

async function bundleName(bundleId) {
	return runAppleScript(`tell application "Finder" to set app_path to application file id "${bundleId}" as string\ntell application "System Events" to get value of property list item "CFBundleName" of property list file (app_path & ":Contents:Info.plist")`);
}

const execFileAsync$1 = node_util.promisify(childProcess.execFile);

// TODO: Fix the casing of bundle identifiers in the next major version.

// Windows doesn't have browser IDs in the same way macOS/Linux does so we give fake
// ones that look real and match the macOS/Linux versions for cross-platform apps.
const windowsBrowserProgIds = {
	MSEdgeHTM: {name: 'Edge', id: 'com.microsoft.edge'}, // The missing `L` is correct.
	MSEdgeBHTML: {name: 'Edge Beta', id: 'com.microsoft.edge.beta'},
	MSEdgeDHTML: {name: 'Edge Dev', id: 'com.microsoft.edge.dev'},
	AppXq0fevzme2pys62n3e0fbqa7peapykr8v: {name: 'Edge', id: 'com.microsoft.edge.old'},
	ChromeHTML: {name: 'Chrome', id: 'com.google.chrome'},
	ChromeBHTML: {name: 'Chrome Beta', id: 'com.google.chrome.beta'},
	ChromeDHTML: {name: 'Chrome Dev', id: 'com.google.chrome.dev'},
	ChromiumHTM: {name: 'Chromium', id: 'org.chromium.Chromium'},
	BraveHTML: {name: 'Brave', id: 'com.brave.Browser'},
	BraveBHTML: {name: 'Brave Beta', id: 'com.brave.Browser.beta'},
	BraveDHTML: {name: 'Brave Dev', id: 'com.brave.Browser.dev'},
	BraveSSHTM: {name: 'Brave Nightly', id: 'com.brave.Browser.nightly'},
	FirefoxURL: {name: 'Firefox', id: 'org.mozilla.firefox'},
	OperaStable: {name: 'Opera', id: 'com.operasoftware.Opera'},
	VivaldiHTM: {name: 'Vivaldi', id: 'com.vivaldi.Vivaldi'},
	'IE.HTTP': {name: 'Internet Explorer', id: 'com.microsoft.ie'},
};

new Map(Object.entries(windowsBrowserProgIds));

class UnknownBrowserError extends Error {}

async function defaultBrowser$1(_execFileAsync = execFileAsync$1) {
	const {stdout} = await _execFileAsync('reg', [
		'QUERY',
		' HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
		'/v',
		'ProgId',
	]);

	const match = /ProgId\s*REG_SZ\s*(?<id>\S+)/.exec(stdout);
	if (!match) {
		throw new UnknownBrowserError(`Cannot find Windows browser in stdout: ${JSON.stringify(stdout)}`);
	}

	const {id} = match.groups;

	// Windows can append a hash suffix to ProgIds using a dot or hyphen
	// (e.g., `ChromeHTML.ABC123`, `FirefoxURL-6F193CCC56814779`).
	// Try exact match first, then try without the suffix.
	const dotIndex = id.lastIndexOf('.');
	const hyphenIndex = id.lastIndexOf('-');
	const baseIdByDot = dotIndex === -1 ? undefined : id.slice(0, dotIndex);
	const baseIdByHyphen = hyphenIndex === -1 ? undefined : id.slice(0, hyphenIndex);

	return windowsBrowserProgIds[id] ?? windowsBrowserProgIds[baseIdByDot] ?? windowsBrowserProgIds[baseIdByHyphen] ?? {name: id, id};
}

const execFileAsync = node_util.promisify(childProcess.execFile);

// Inlined: https://github.com/sindresorhus/titleize/blob/main/index.js
const titleize = string => string.toLowerCase().replaceAll(/(?:^|\s|-)\S/g, x => x.toUpperCase());

async function defaultBrowser() {
	if (process$1.platform === 'darwin') {
		const id = await defaultBrowserId();
		const name = await bundleName(id);
		return {name, id};
	}

	if (process$1.platform === 'linux') {
		const {stdout} = await execFileAsync('xdg-mime', ['query', 'default', 'x-scheme-handler/http']);
		const id = stdout.trim();
		const name = titleize(id.replace(/.desktop$/, '').replace('-', ' '));
		return {name, id};
	}

	if (process$1.platform === 'win32') {
		return defaultBrowser$1();
	}

	throw new Error('Only macOS, Linux, and Windows are supported');
}

const execFile = node_util.promisify(childProcess.execFile);

// Path to included `xdg-open`.
const __dirname$1 = path.dirname(node_url.fileURLToPath((typeof document === 'undefined' ? require('u' + 'rl').pathToFileURL(__filename).href : (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('dynamodb-admin.js', document.baseURI).href))));
const localXdgOpenPath = path.join(__dirname$1, 'xdg-open');

const {platform, arch} = process$1;

/**
Get the default browser name in Windows from WSL.

@returns {Promise<string>} Browser name.
*/
async function getWindowsDefaultBrowserFromWsl() {
	const powershellPath = await powerShellPath();
	const rawCommand = String.raw`(Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice").ProgId`;
	const encodedCommand = node_buffer.Buffer.from(rawCommand, 'utf16le').toString('base64');

	const {stdout} = await execFile(
		powershellPath,
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			encodedCommand,
		],
		{encoding: 'utf8'},
	);

	const progId = stdout.trim();

	// Map ProgId to browser IDs
	const browserMap = {
		ChromeHTML: 'com.google.chrome',
		BraveHTML: 'com.brave.Browser',
		MSEdgeHTM: 'com.microsoft.edge',
		FirefoxURL: 'org.mozilla.firefox',
	};

	return browserMap[progId] ? {id: browserMap[progId]} : {};
}

const pTryEach = async (array, mapper) => {
	let latestError;

	for (const item of array) {
		try {
			return await mapper(item); // eslint-disable-line no-await-in-loop
		} catch (error) {
			latestError = error;
		}
	}

	throw latestError;
};

// eslint-disable-next-line complexity
const baseOpen = async options => {
	options = {
		wait: false,
		background: false,
		newInstance: false,
		allowNonzeroExitCode: false,
		...options,
	};

	if (Array.isArray(options.app)) {
		return pTryEach(options.app, singleApp => baseOpen({
			...options,
			app: singleApp,
		}));
	}

	let {name: app, arguments: appArguments = []} = options.app ?? {};
	appArguments = [...appArguments];

	if (Array.isArray(app)) {
		return pTryEach(app, appName => baseOpen({
			...options,
			app: {
				name: appName,
				arguments: appArguments,
			},
		}));
	}

	if (app === 'browser' || app === 'browserPrivate') {
		// IDs from default-browser for macOS and windows are the same
		const ids = {
			'com.google.chrome': 'chrome',
			'google-chrome.desktop': 'chrome',
			'com.brave.Browser': 'brave',
			'org.mozilla.firefox': 'firefox',
			'firefox.desktop': 'firefox',
			'com.microsoft.msedge': 'edge',
			'com.microsoft.edge': 'edge',
			'com.microsoft.edgemac': 'edge',
			'microsoft-edge.desktop': 'edge',
		};

		// Incognito flags for each browser in `apps`.
		const flags = {
			chrome: '--incognito',
			brave: '--incognito',
			firefox: '--private-window',
			edge: '--inPrivate',
		};

		const browser = isWsl$1 ? await getWindowsDefaultBrowserFromWsl() : await defaultBrowser();
		if (browser.id in ids) {
			const browserName = ids[browser.id];

			if (app === 'browserPrivate') {
				appArguments.push(flags[browserName]);
			}

			return baseOpen({
				...options,
				app: {
					name: apps[browserName],
					arguments: appArguments,
				},
			});
		}

		throw new Error(`${browser.name} is not supported as a default browser`);
	}

	let command;
	const cliArguments = [];
	const childProcessOptions = {};

	if (platform === 'darwin') {
		command = 'open';

		if (options.wait) {
			cliArguments.push('--wait-apps');
		}

		if (options.background) {
			cliArguments.push('--background');
		}

		if (options.newInstance) {
			cliArguments.push('--new');
		}

		if (app) {
			cliArguments.push('-a', app);
		}
	} else if (platform === 'win32' || (isWsl$1 && !isInsideContainer() && !app)) {
		command = await powerShellPath();

		cliArguments.push(
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
		);

		if (!isWsl$1) {
			childProcessOptions.windowsVerbatimArguments = true;
		}

		const encodedArguments = ['Start'];

		if (options.wait) {
			encodedArguments.push('-Wait');
		}

		if (app) {
			// Double quote with double quotes to ensure the inner quotes are passed through.
			// Inner quotes are delimited for PowerShell interpretation with backticks.
			encodedArguments.push(`"\`"${app}\`""`);
			if (options.target) {
				appArguments.push(options.target);
			}
		} else if (options.target) {
			encodedArguments.push(`"${options.target}"`);
		}

		if (appArguments.length > 0) {
			appArguments = appArguments.map(argument => `"\`"${argument}\`""`);
			encodedArguments.push('-ArgumentList', appArguments.join(','));
		}

		// Using Base64-encoded command, accepted by PowerShell, to allow special characters.
		options.target = node_buffer.Buffer.from(encodedArguments.join(' '), 'utf16le').toString('base64');
	} else {
		if (app) {
			command = app;
		} else {
			// When bundled by Webpack, there's no actual package file path and no local `xdg-open`.
			const isBundled = !__dirname$1 || __dirname$1 === '/';

			// Check if local `xdg-open` exists and is executable.
			let exeLocalXdgOpen = false;
			try {
				await fs$1.access(localXdgOpenPath, fs$1.constants.X_OK);
				exeLocalXdgOpen = true;
			} catch {}

			const useSystemXdgOpen = process$1.versions.electron
				?? (platform === 'android' || isBundled || !exeLocalXdgOpen);
			command = useSystemXdgOpen ? 'xdg-open' : localXdgOpenPath;
		}

		if (appArguments.length > 0) {
			cliArguments.push(...appArguments);
		}

		if (!options.wait) {
			// `xdg-open` will block the process unless stdio is ignored
			// and it's detached from the parent even if it's unref'd.
			childProcessOptions.stdio = 'ignore';
			childProcessOptions.detached = true;
		}
	}

	if (platform === 'darwin' && appArguments.length > 0) {
		cliArguments.push('--args', ...appArguments);
	}

	// This has to come after `--args`.
	if (options.target) {
		cliArguments.push(options.target);
	}

	const subprocess = childProcess.spawn(command, cliArguments, childProcessOptions);

	if (options.wait) {
		return new Promise((resolve, reject) => {
			subprocess.once('error', reject);

			subprocess.once('close', exitCode => {
				if (!options.allowNonzeroExitCode && exitCode > 0) {
					reject(new Error(`Exited with code ${exitCode}`));
					return;
				}

				resolve(subprocess);
			});
		});
	}

	subprocess.unref();

	return subprocess;
};

const open = (target, options) => {
	if (typeof target !== 'string') {
		throw new TypeError('Expected a `target`');
	}

	return baseOpen({
		...options,
		target,
	});
};

function detectArchBinary(binary) {
	if (typeof binary === 'string' || Array.isArray(binary)) {
		return binary;
	}

	const {[arch]: archBinary} = binary;

	if (!archBinary) {
		throw new Error(`${arch} is not supported`);
	}

	return archBinary;
}

function detectPlatformBinary({[platform]: platformBinary}, {wsl}) {
	if (wsl && isWsl$1) {
		return detectArchBinary(wsl);
	}

	if (!platformBinary) {
		throw new Error(`${platform} is not supported`);
	}

	return detectArchBinary(platformBinary);
}

const apps = {};

defineLazyProperty(apps, 'chrome', () => detectPlatformBinary({
	darwin: 'google chrome',
	win32: 'chrome',
	linux: ['google-chrome', 'google-chrome-stable', 'chromium'],
}, {
	wsl: {
		ia32: '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		x64: ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
	},
}));

defineLazyProperty(apps, 'brave', () => detectPlatformBinary({
	darwin: 'brave browser',
	win32: 'brave',
	linux: ['brave-browser', 'brave'],
}, {
	wsl: {
		ia32: '/mnt/c/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
		x64: ['/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe', '/mnt/c/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe'],
	},
}));

defineLazyProperty(apps, 'firefox', () => detectPlatformBinary({
	darwin: 'firefox',
	win32: String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`,
	linux: 'firefox',
}, {
	wsl: '/mnt/c/Program Files/Mozilla Firefox/firefox.exe',
}));

defineLazyProperty(apps, 'edge', () => detectPlatformBinary({
	darwin: 'microsoft edge',
	win32: 'msedge',
	linux: ['microsoft-edge', 'microsoft-edge-dev'],
}, {
	wsl: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
}));

defineLazyProperty(apps, 'browser', () => 'browser');

defineLazyProperty(apps, 'browserPrivate', () => 'browserPrivate');

const { description, version } = JSON.parse(fs.readFileSync(new URL('../package.json', (typeof document === 'undefined' ? require('u' + 'rl').pathToFileURL(__filename).href : (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('dynamodb-admin.js', document.baseURI).href))), { encoding: 'utf8' }));
if (process.env.NODE_ENV === 'production') {
    console.error(clc.red('Do not run this in production!'));
    process.exit(1);
}
const parser = new argparse.ArgumentParser({
    description,
});
parser.add_argument('-v', '--version', {
    action: 'version',
    version,
});
parser.add_argument('-o', '--open', {
    action: 'store_true',
    help: 'Open server URL in default browser on start',
});
parser.add_argument('-H', '--host', {
    type: 'str',
    default: process.env.HOST || undefined,
    help: 'Host to run on (default: undefined)',
});
parser.add_argument('-p', '--port', {
    type: 'int',
    default: process.env.PORT ?? 8001,
    help: 'Port to run on (default: 8001)',
});
parser.add_argument('--dynamo-endpoint', {
    type: 'str',
    default: process.env.DYNAMO_ENDPOINT || 'http://localhost:8000',
    help: 'DynamoDB endpoint to connect to.',
});
parser.add_argument('--skip-default-credentials', {
    action: 'store_true',
    help: 'Skip setting default credentials and region. By default the accessKeyId/secretAccessKey are set to "key" and "secret" and the region is set to "us-east-1". If you specify this argument then you need to ensure that credentials are provided some other way. See https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html for more details on how default credentials provider works.',
});
parser.add_argument('--base-path', {
    type: 'str',
    default: process.env.BASE_PATH || '',
    help: 'Base path for the application (e.g., /dynamo). Useful when running behind a reverse proxy.',
});
const { host, port, open: openUrl, dynamo_endpoint: dynamoEndpoint, skip_default_credentials: skipDefaultCredentials, base_path: basePath } = parser.parse_args();
const app = backend.createServer({ dynamoEndpoint, skipDefaultCredentials, basePath });
const server = app.listen(port, host);
server.on('listening', () => {
    const address = server.address();
    if (!address) {
        throw new Error(`Not able to listen on host and port "${host}:${port}"`);
    }
    let listenAddress;
    let listenPort;
    if (typeof address === 'string') {
        listenAddress = address;
    }
    else {
        listenAddress = address.address;
        listenPort = address.port;
    }
    let url = `http://${listenAddress}${listenPort ? ':' + listenPort : ''}`;
    if (!host && listenAddress !== '0.0.0.0') {
        url += ` (alternatively http://0.0.0.0:${listenPort})`;
    }
    console.info(`  dynamodb-admin listening on ${url}`);
    if (openUrl) {
        open(url);
    }
});
