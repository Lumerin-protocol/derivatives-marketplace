declare module "hardhat/types/config" {
  interface HardhatUserConfig {
    codegen?: {
      contracts?: string[];
    };
  }
  interface HardhatConfig {
    codegen: {
      contracts: string[];
    };
  }
}
export {};
