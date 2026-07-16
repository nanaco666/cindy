#!/usr/bin/env node
import {
  addBetaDeveloperProfile,
  assertEasLoggedIn,
  buildBetaChannelLinkCommands,
  formatCommandSpec,
  loadMobileConfig,
  parseArgs,
  runBetaChannelLink,
  saveEasJson,
} from './release-lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dev = args.dev ?? args._[0];
  const config = loadMobileConfig();
  const result = addBetaDeveloperProfile(config.easJson, dev, { allowExisting: Boolean(args.execute) });
  if (args.execute) {
    assertEasLoggedIn({ mobileDir: config.mobileDir });
    if (result.created) saveEasJson(config.easJson, config.mobileDir);
    const link = runBetaChannelLink({
      channel: result.channel,
      branch: result.branch,
      cwd: config.mobileDir,
      execute: true,
    });
    console.log(`${result.created ? 'Added' : 'Profile already exists'} ${result.profile} -> ${result.channel}`);
    console.log(`Linked EAS channel ${result.channel} -> ${result.branch}${link.created ? '' : ' (channel already existed)'}`);
  } else {
    console.log(`Would add ${result.profile} -> ${result.channel} and link EAS channel ${result.channel} -> ${result.branch}`);
    console.log(JSON.stringify(config.easJson.build[result.profile], null, 2));
    for (const command of buildBetaChannelLinkCommands(result)) {
      console.log(`$ ${formatCommandSpec(command)}`);
    }
    console.log('dry-run: pass --execute to write eas.json and link EAS channel');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
