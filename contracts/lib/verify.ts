import hre from "hardhat";
import { verifyContract as hreVerify } from "@nomicfoundation/hardhat-verify/verify";

export async function verifyContract(address: string, constructorArgs?: readonly unknown[]) {
  console.log(`\nVerifying contract at ${address}...`);
  await hreVerify({ address, constructorArgs: (constructorArgs ?? []) as unknown[] }, hre)
    .then(() => {
      console.log("  Contract verified successfully.");
    })
    .catch((err: Error) => {
      if (err.message?.includes("Already Verified")) {
        console.log("  Contract is already verified.");
      } else {
        console.warn("  Verification failed:", err.message, err);
      }
    });
}
