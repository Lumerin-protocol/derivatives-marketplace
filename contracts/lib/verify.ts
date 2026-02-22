import { tasks } from "hardhat";

export async function verifyContract(address: string, constructorArgs?: any[]) {
  await tasks
    .getTask("verify")
    .run({
      address,
      constructorArgs: constructorArgs,
    })
    .catch((err) => {
      console.log(err);
    });
}
