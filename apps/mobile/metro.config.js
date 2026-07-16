const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, '../..');
const workspaceNodeModules = path.join(workspaceRoot, 'node_modules');
const appNodeModules = path.join(__dirname, 'node_modules');
const sharedArrayBufferPolyfill = path.join(__dirname, 'src/polyfills/sharedArrayBuffer.js');

config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [appNodeModules, workspaceNodeModules];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@cindy/device-link-protocol': path.join(
    workspaceRoot,
    'cindy-protocol/packages/device-link-protocol',
  ),
  react: path.join(appNodeModules, 'react'),
  'react-native': path.join(workspaceNodeModules, 'react-native'),
  'react-dom': path.join(appNodeModules, 'react-dom'),
};

const defaultGetPolyfills = config.serializer.getPolyfills;
config.serializer.getPolyfills = (ctx) => [
  sharedArrayBufferPolyfill,
  ...defaultGetPolyfills(ctx),
];

const defaultResolveRequest = config.resolver.resolveRequest;
const workspaceTsSourcePackages = [
  'auth-client',
  'device-link',
  'maker-shared',
  'model-providers',
];
const rnDevToolsSettingsManager = '../../src/private/devsupport/rndevtools/ReactDevToolsSettingsManager';

function isWorkspaceTsSourcePackage(originModulePath) {
  return workspaceTsSourcePackages.some((packageName) => (
    originModulePath.includes(`${path.sep}packages${path.sep}${packageName}${path.sep}`)
  ));
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === rnDevToolsSettingsManager) {
    const nativePlatform = platform === 'android' ? 'android' : 'ios';
    return context.resolveRequest(context, `${moduleName}.${nativePlatform}.js`, platform);
  }

  if (moduleName.endsWith('.js') && isWorkspaceTsSourcePackage(context.originModulePath)) {
    try {
      return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Fall through to Metro's normal resolver so genuine .js files still work.
    }
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
