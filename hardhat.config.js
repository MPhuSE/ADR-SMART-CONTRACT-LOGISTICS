require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      evmVersion: "paris",
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: { hardhat: { hardfork: "shanghai" } },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: 'USD',
    gasPrice: 20,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || null,
    outputFile: process.env.REPORT_GAS ? "results/gas-report.csv" : undefined,
    noColors: true
  }
};
