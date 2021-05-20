import { subtask, task, types } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import * as fs from 'fs';
import * as path from 'path';
import type {
  LibraryContracts,
  DarkForestCoreReturn,
  DarkForestTokens,
  DarkForestGPTCredit,
  Whitelist,
  DarkForestGetters,
} from '../task-types';
import '../tasks/deploy-more';
import * as prettier from 'prettier';
import * as settings from '../settings';

task('deploy', 'deploy all contracts')
  .addOptionalParam('whitelist', 'override the whitelist', true, types.boolean)
  .addOptionalParam('fund', 'amount of eth to fund whitelist contract for fund', 0.5, types.float)
  .addOptionalParam(
    'subgraph',
    'bring up subgraph with name (requires docker)',
    undefined,
    types.string
  )
  .setAction(deploy);

async function deploy(
  args: { whitelist: boolean; fund: number; subgraph: string },
  hre: HardhatRuntimeEnvironment
) {
  const isDev = hre.network.name === 'localhost';

  // Ensure we have required keys in our initializers
  settings.required(hre.initializers, ['PLANETHASH_KEY', 'SPACETYPE_KEY', 'BIOMEBASE_KEY']);

  // need to force a compile for tasks
  await hre.run('compile');

  // Were only using one account, getSigners()[0], the deployer. Becomes the ProxyAdmin
  const [deployer] = await hre.ethers.getSigners();
  // give contract administration over to an admin adress if was provided, or use deployer
  const controllerWalletAddress =
    hre.ADMIN_PUBLIC_ADDRESS !== undefined ? hre.ADMIN_PUBLIC_ADDRESS : deployer.address;

  const requires = hre.ethers.utils.parseEther('2.1');
  const balance = await deployer.getBalance();

  // Only when deploying to production, give the deployer wallet money,
  // in order for it to be able to deploy the contracts
  if (!isDev && balance.lt(requires)) {
    throw new Error(
      `${deployer.address} requires ~$${hre.ethers.utils.formatEther(
        requires
      )} but has ${hre.ethers.utils.formatEther(balance)} top up and rerun`
    );
  }

  // deploy the whitelist contract
  const whitelist: Whitelist = await hre.run('deploy:whitelist', {
    controllerWalletAddress,
    whitelistEnabled: args.whitelist,
  });

  const whitelistAddress = whitelist.address;
  console.log('Whitelist deployed to:', whitelistAddress);

  // deploy the tokens contract
  const darkForestTokens: DarkForestTokens = await hre.run('deploy:tokens');
  const tokensAddress = darkForestTokens.address;
  console.log('DarkForestTokens deployed to:', tokensAddress);

  const libraries: LibraryContracts = await hre.run('deploy:libraries');

  // deploy the core contract
  const darkForestCoreReturn: DarkForestCoreReturn = await hre.run('deploy:core', {
    controllerWalletAddress,
    whitelistAddress,
    tokensAddress,
    initializeAddress: libraries.initialize.address,
    planetAddress: libraries.planet.address,
    utilsAddress: libraries.utils.address,
    verifierAddress: libraries.verifier.address,
  });

  const coreAddress = darkForestCoreReturn.contract.address;
  console.log('DarkForestCore deployed to:', coreAddress);

  // late initlialize tokens now that we have corecontract address
  const dftReceipt = await darkForestTokens.initialize(coreAddress, deployer.address);
  await dftReceipt.wait();

  const darkForestGetters: DarkForestGetters = await hre.run('deploy:getters', {
    controllerWalletAddress,
    coreAddress,
    tokensAddress,
    utilsAddress: libraries.utils.address,
  });

  const gettersAddress = darkForestGetters.address;

  const gpt3Credit: DarkForestGPTCredit = await hre.run('deploy:gptcredits', {
    controllerWalletAddress,
  });
  const gptCreditAddress = gpt3Credit.address;

  await hre.run('deploy:save', {
    coreBlockNumber: darkForestCoreReturn.blockNumber,
    libraries,
    coreAddress,
    tokensAddress,
    gettersAddress,
    whitelistAddress,
    gptCreditAddress,
  });

  // give all contract administration over to an admin adress if was provided
  if (hre.ADMIN_PUBLIC_ADDRESS) {
    await hre.upgrades.admin.transferProxyAdminOwnership(hre.ADMIN_PUBLIC_ADDRESS);
  }

  // Note Ive seen `ProviderError: Internal error` when not enough money...
  await deployer.sendTransaction({
    to: whitelist.address,
    value: hre.ethers.utils.parseEther(args.fund.toString()),
  });

  if (args.subgraph) {
    await hre.run('subgraph:deploy', { name: args.subgraph });
  }

  console.log(`Sent ${args.fund} to whitelist contract to fund drips`);
  console.log('Deployed successfully. Godspeed cadet.');
}

subtask('deploy:save').setAction(deploySave);

async function deploySave(
  args: {
    coreBlockNumber: number;
    libraries: LibraryContracts;
    coreAddress: string;
    tokensAddress: string;
    gettersAddress: string;
    whitelistAddress: string;
    gptCreditAddress: string;
  },
  hre: HardhatRuntimeEnvironment
) {
  const isDev = hre.network.name === 'localhost';

  const contractsFile = path.join(hre.packageDirs['@darkforest_eth/contracts'], 'index.ts');

  const options = prettier.resolveConfig.sync(contractsFile);

  // Save the addresses of the deployed contracts to the `@darkforest_eth/contracts` package
  const addrFileContents = prettier.format(
    `
  /**
   * Network information
   */
  export const NETWORK = '${hre.network.name}';
  export const NETWORK_ID = ${hre.network.config.chainId};
  export const START_BLOCK = ${isDev ? 0 : args.coreBlockNumber};
  /**
   * Library addresses
   */
  export const UTILS_LIBRARY_ADDRESS = '${args.libraries.utils.address}';
  export const PLANET_LIBRARY_ADDRESS = '${args.libraries.planet.address}';
  export const VERIFIER_LIBRARY_ADDRESS = '${args.libraries.verifier.address}';
  export const INITIALIZE_LIBRARY_ADDRESS = '${args.libraries.initialize.address}';
  export const LAZY_UPDATE_LIBRARY_ADDRESS = '${args.libraries.lazyUpdate.address}';
  /**
   * Contract addresses
   */
  export const CORE_CONTRACT_ADDRESS = '${args.coreAddress}';
  export const TOKENS_CONTRACT_ADDRESS = '${args.tokensAddress}';
  export const GETTERS_CONTRACT_ADDRESS = '${args.gettersAddress}';
  export const WHITELIST_CONTRACT_ADDRESS = '${args.whitelistAddress}';
  export const GPT_CREDIT_CONTRACT_ADDRESS = '${args.gptCreditAddress}';
  `,
    { ...options, parser: 'babel-ts' }
  );

  fs.writeFileSync(contractsFile, addrFileContents);
}
