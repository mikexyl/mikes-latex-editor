// electron-builder afterPack hook: ad-hoc sign the macOS app ourselves.
//
// Apple Silicon only runs signed code, but electron-builder's signer (osx-sign) opens every file in
// the app at once to find binaries and runs out of file descriptors on the bundled TeX Live
// (~15,000 files). `codesign --deep` signs the app with its frameworks and helpers, inside out, and
// seals the resources by hashing them one at a time. TeX Live's own macOS binaries come signed.
// Not notarized: without an Apple Developer ID, users clear the quarantine flag once.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing  ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
