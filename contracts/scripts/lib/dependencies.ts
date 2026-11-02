import { type Address, type PublicClient, getAddress, parseAbi } from "viem";

// Upgrade order: the vault (`update-collateral-vault.ts`), then the engine
// (`update-portfolio-margin-engine.ts`), then both venues while the vault is halted, then the
// keeper and the UI; resume the vault last. A venue upgraded early still runs, but without the
// vault's account debt and halt fixes or the engine's debt term.
export const MIN_ENGINE_VERSION = "2.6.0";
export const MIN_VAULT_VERSION = "1.4.3";
const VERSION_ABI = parseAbi(["function VERSION() view returns (string)"]);
const VENUE_ABI = parseAbi(["function vault() view returns (address)"]);

/** Dotted-version comparison; an unreadable version never passes. */
export function versionAtLeast(version: string, min: string): boolean {
  const have = version.split(".").map(Number);
  const want = min.split(".").map(Number);
  for (let i = 0; i < want.length; i++) {
    const part = have[i] ?? 0;
    if (part !== want[i]) return part > want[i];
  }
  return true;
}

async function requireVersion(
  pc: PublicClient,
  contract: string,
  address: Address,
  min: string,
  script: string,
  blockNumber?: bigint,
): Promise<void> {
  const version = await pc
    .readContract({
      address,
      abi: VERSION_ABI,
      functionName: "VERSION",
      blockNumber,
    })
    .catch(() => "unknown");
  if (!versionAtLeast(version, min)) {
    throw new Error(
      `${contract} ${address} is at ${version}; upgrade it to ${min} or later (${script}) before this venue`,
    );
  }
}

export interface UpgradeDependencies {
  /** The venue proxy being upgraded. */
  venue: Address;
  /** `VAULT_ADDRESS`: the vault the new implementation is built against. */
  vault: Address;
  /** Every margin engine the upgraded venue will call. */
  engines: readonly Address[];
  blockNumber?: bigint;
}

/** Stops the upgrade unless the contracts the new implementation relies on are in place. */
export async function requireUpgradeDependencies(
  pc: PublicClient,
  { venue, vault, engines, blockNumber }: UpgradeDependencies,
): Promise<void> {
  // The new implementation holds `vault` as an immutable and the script halts `vault`, so it
  // must be the vault the venue settles into today.
  const current = getAddress(
    await pc.readContract({
      address: venue,
      abi: VENUE_ABI,
      functionName: "vault",
      blockNumber,
    }),
  );
  if (current !== getAddress(vault)) {
    throw new Error(`VAULT_ADDRESS ${vault} is not the vault ${current} this venue settles into`);
  }
  await requireVersion(
    pc,
    "CollateralVault",
    current,
    MIN_VAULT_VERSION,
    "update-collateral-vault.ts",
    blockNumber,
  );
  for (const engine of engines) {
    await requireVersion(
      pc,
      "PortfolioMarginEngine",
      engine,
      MIN_ENGINE_VERSION,
      "update-portfolio-margin-engine.ts",
      blockNumber,
    );
  }
}
