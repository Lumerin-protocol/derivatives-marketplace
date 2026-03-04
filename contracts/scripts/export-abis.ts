/**
 * Copies selected contract ABIs from Hardhat artifacts to the flat abi/ directory.
 * Replaces hardhat-abi-exporter for Hardhat v3.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = resolve(__dirname, "../artifacts");
const OUT_DIR = resolve(__dirname, "../abi");

const CONTRACTS = [
  "contracts/PerpsSimple.sol/PerpsSimple.json",
  "contracts/USDCMock.sol/USDCMock.json",
  "contracts/PriceOracleMock.sol/PriceOracleMock.json",
  "contracts/BTCPriceOracleMock.sol/BTCPriceOracleMock.json",
  "contracts/Multicall3.sol/Multicall3.json",
  "contracts/AggregatorV3Interface.sol/AggregatorV3Interface.json",
  "@openzeppelin/contracts/token/ERC20/IERC20.sol/IERC20.json",
];

mkdirSync(OUT_DIR, { recursive: true });

for (const contractPath of CONTRACTS) {
  const src = resolve(ARTIFACTS_DIR, contractPath);
  const name = contractPath.split("/").pop();
  if (!name) {
    console.warn(`  skipped ${contractPath} (no name)`);
    continue;
  }
  const dest = resolve(OUT_DIR, name);
  try {
    const artifact = JSON.parse(readFileSync(src, "utf-8"));
    writeFileSync(dest, JSON.stringify(artifact.abi, null, 2));
    console.log(`  exported ${name}`);
  } catch {
    console.warn(`  skipped ${name} (not found in artifacts)`);
  }
}
