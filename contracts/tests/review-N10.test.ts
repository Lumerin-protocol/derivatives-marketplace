import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { type Address, isAddressEqual, type PublicClient } from "viem";
import { requireUpgradeDependencies } from "../scripts/lib/dependencies.ts";
import { deployPerpsFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/** A client on which `target` reports `version`, as an earlier release still deployed would. */
function reportingVersion(pc: PublicClient, target: Address, version: string): PublicClient {
  return new Proxy(pc, {
    get(client, prop, receiver) {
      if (prop !== "readContract") return Reflect.get(client, prop, receiver);
      return (args: Parameters<PublicClient["readContract"]>[0]) =>
        args.functionName === "VERSION" &&
        args.address !== undefined &&
        isAddressEqual(args.address, target)
          ? Promise.resolve(version)
          : client.readContract(args);
    },
  });
}

/**
 * N10: `update-perps.ts` accepted any engine from 2.2.0 and never checked the vault, so the
 * venue could be upgraded ahead of the vault and engine releases it depends on, or built against
 * a `VAULT_ADDRESS` other than the vault it settles into.
 */
describe("N10 — the perps upgrade checks the vault and engine it depends on", () => {
  it("passes against the vault and engine this venue is built with", async () => {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault, pme } = contracts;

    await requireUpgradeDependencies(accounts.pc, {
      venue: perps.address,
      vault: vault.address,
      engines: [pme.address],
    });
  });

  it("stops while the engine is a release behind", async () => {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault, pme } = contracts;

    await assert.rejects(
      requireUpgradeDependencies(reportingVersion(accounts.pc, pme.address, "2.5.0"), {
        venue: perps.address,
        vault: vault.address,
        engines: [pme.address],
      }),
      /PortfolioMarginEngine .* is at 2\.5\.0/,
    );
  });

  it("stops while the vault is a release behind", async () => {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault, pme } = contracts;

    await assert.rejects(
      requireUpgradeDependencies(reportingVersion(accounts.pc, vault.address, "1.4.2"), {
        venue: perps.address,
        vault: vault.address,
        engines: [pme.address],
      }),
      /CollateralVault .* is at 1\.4\.2/,
    );
  });

  it("stops when VAULT_ADDRESS is another vault than the one the venue settles into", async () => {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, pme } = contracts;
    const otherVault = await viem.deployContract("CollateralVault", []);

    await assert.rejects(
      requireUpgradeDependencies(accounts.pc, {
        venue: perps.address,
        vault: otherVault.address,
        engines: [pme.address],
      }),
      /VAULT_ADDRESS .* is not the vault/,
    );
  });
});
