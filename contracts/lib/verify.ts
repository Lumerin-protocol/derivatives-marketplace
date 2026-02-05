import { run } from "hardhat";

export async function verifyContract(address: string, constructorArgs?: any[]) {
  await run("verify:verify", {
    address,
    constructorArguments: constructorArgs,
  }).catch((err) => {
    console.error(err);
  });
}
