import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const contractName = "HashPowerPerpsDEX";
const sourceSuffix = "/contracts/HashPowerPerpsDEX.sol";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const buildInfoDir = resolve(projectDir, "artifacts/build-info");
const artifactPath = resolve(
  projectDir,
  "artifacts/contracts/HashPowerPerpsDEX.sol/HashPowerPerpsDEX.json",
);
const baselinePath = resolve(scriptDir, "HashPowerPerpsDEX.storage-layout.json");

function canonicalType(typeId, types) {
  const type = types[typeId];
  assert(type, `Compiler output is missing storage type ${typeId}`);

  const canonical = {
    encoding: type.encoding,
    label: type.label,
    numberOfBytes: type.numberOfBytes,
  };
  if (type.key) canonical.key = canonicalType(type.key, types);
  if (type.value) canonical.value = canonicalType(type.value, types);
  if (type.base) canonical.base = canonicalType(type.base, types);
  if (type.members) {
    canonical.members = type.members.map((member) => {
      let memberType = canonicalType(member.type, types);
      let label = member.label;
      // The exact-entry reset intentionally reinterprets only Position's second
      // full-width slot from uint256 average price to int256 signed entry value.
      // Normalize that one semantic change for the historical fingerprint;
      // slot, offset, width, encoding, and every other member remain strict.
      if (
        member.label === "netEntryValue" &&
        member.slot === "1" &&
        member.offset === 0 &&
        memberType.label === "int256" &&
        memberType.numberOfBytes === "32"
      ) {
        label = "aggregatedEntryPrice";
        memberType = { ...memberType, label: "uint256" };
      }
      return {
        label,
        slot: member.slot,
        offset: member.offset,
        type: memberType,
      };
    });
  }
  return canonical;
}

function typeFingerprint(typeId, types) {
  return createHash("sha256").update(JSON.stringify(canonicalType(typeId, types))).digest("hex");
}

function loadContractBuild() {
  const artifactBytecode = JSON.parse(readFileSync(artifactPath, "utf8")).bytecode.slice(2);
  const candidates = [];
  for (const filename of readdirSync(buildInfoDir)) {
    if (!filename.endsWith(".json") || filename.endsWith(".output.json")) continue;
    const buildInfo = JSON.parse(readFileSync(resolve(buildInfoDir, filename), "utf8"));
    const outputFilename = filename.replace(/\.json$/, ".output.json");
    const compilerOutput = JSON.parse(readFileSync(resolve(buildInfoDir, outputFilename), "utf8")).output;
    const contracts = compilerOutput.contracts ?? {};
    for (const [sourceName, sourceContracts] of Object.entries(contracts)) {
      if (!sourceName.endsWith(sourceSuffix)) continue;
      const bytecode = sourceContracts[contractName]?.evm?.bytecode?.object;
      if (bytecode === artifactBytecode) candidates.push(buildInfo);
    }
  }

  assert.equal(candidates.length, 1, `Expected one ${contractName} compiler input, found ${candidates.length}`);
  return candidates[0];
}

async function loadCurrentLayout() {
  const buildInfo = loadContractBuild();
  const compilerModulePath = resolve(
    projectDir,
    "node_modules/hardhat/dist/src/internal/builtin-plugins/solidity/build-system/compiler/index.js",
  );
  const { getCompiler } = await import(pathToFileURL(compilerModulePath));
  const compiler = await getCompiler(buildInfo.solcVersion, {
    preferWasm: buildInfo.compilerType === "solcjs",
  });
  const input = structuredClone(buildInfo.input);
  input.settings.outputSelection = { "*": { "*": ["storageLayout"] } };
  const output = await compiler.compile(input);
  const errors = (output.errors ?? []).filter((error) => error.severity === "error");
  assert.equal(errors.length, 0, errors.map((error) => error.formattedMessage).join("\n"));

  const layouts = [];
  for (const [sourceName, sourceContracts] of Object.entries(output.contracts ?? {})) {
    if (!sourceName.endsWith(sourceSuffix)) continue;
    const layout = sourceContracts[contractName]?.storageLayout;
    if (layout) layouts.push(layout);
  }
  assert.equal(layouts.length, 1, `Expected one ${contractName} storage layout, found ${layouts.length}`);
  const [layout] = layouts;
  return {
    contract: contractName,
    storage: layout.storage.map((entry) => {
      const type = layout.types[entry.type];
      assert(type, `Compiler output is missing storage type ${entry.type}`);
      return {
        label: entry.label,
        slot: entry.slot,
        offset: entry.offset,
        type: type.label,
        bytes: type.numberOfBytes,
        typeFingerprint: typeFingerprint(entry.type, layout.types),
      };
    }),
  };
}

function bytePosition(slot, offset) {
  return BigInt(slot) * 32n + BigInt(offset);
}

const current = await loadCurrentLayout();
if (process.argv.includes("--write")) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Wrote ${current.storage.length}-entry ${contractName} storage baseline`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
assert.equal(current.contract, baseline.contract);
assert(
  current.storage.length >= baseline.storage.length,
  `${contractName} removed storage entries: expected at least ${baseline.storage.length}, found ${current.storage.length}`,
);

for (let index = 0; index < baseline.storage.length; index++) {
  assert.deepEqual(current.storage[index], baseline.storage[index], `Storage entry ${index} changed`);
}

const tail = baseline.storage.at(-1);
assert(tail, "Storage baseline must contain at least one entry");
const tailEnd = bytePosition(tail.slot, tail.offset) + BigInt(tail.bytes);
for (const entry of current.storage.slice(baseline.storage.length)) {
  assert(
    bytePosition(entry.slot, entry.offset) >= tailEnd,
    `New storage ${entry.label} must be appended after the existing tail`,
  );
}

console.log(
  `${contractName} storage layout is append-only (${baseline.storage.length} baseline entries, ${
    current.storage.length - baseline.storage.length
  } appended)`,
);
