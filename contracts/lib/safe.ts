import type { Account, Chain, PublicClient, Transport, WalletClient } from "viem";
import { getAddress } from "viem/utils";
import { sepolia, mainnet, arbitrum } from "viem/chains";
import SafeApiKit from "@safe-global/api-kit";
import Safe from "@safe-global/protocol-kit";
import type { MetaTransactionData } from "@safe-global/types-kit";

export class SafeWallet {
  private readonly safeApiKit: SafeApiKit;
  private readonly safeAddr: `0x${string}`;
  private readonly wallet: WalletClient<Transport, Chain, Account>;
  private safeSigner?: Safe;

  constructor(address: `0x${string}`, wallet: WalletClient<Transport, Chain, Account>) {
    this.safeApiKit = new SafeApiKit({
      chainId: BigInt(wallet.chain.id),
    });
    this.safeAddr = address;
    this.wallet = wallet;
  }

  async initSigner(): Promise<Safe> {
    const safe = this.safeSigner;
    if (safe) {
      return safe;
    }
    const protocolKit = await Safe.init({
      provider: this.wallet.transport,
      signer: this.wallet.account.address,
      safeAddress: this.safeAddr,
    });
    this.safeSigner = protocolKit;
    return protocolKit;
  }

  async proposeTransaction(data: MetaTransactionData): Promise<string> {
    const signer = await this.initSigner();
    const safeTransaction = await signer.createTransaction({
      transactions: [
        {
          ...data,
          ...(data.to ? { to: getAddress(data.to) } : {}),
        },
      ],
    });

    const safeTxHash = await signer.getTransactionHash(safeTransaction);
    const signature = await signer.signHash(safeTxHash);

    console.log("Proposing transaction to Safe...");
    console.log({
      safeAddress: getAddress(this.safeAddr),
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: getAddress(this.wallet.account.address),
      senderSignature: signature.data,
    });

    await this.safeApiKit.proposeTransaction({
      safeAddress: getAddress(this.safeAddr),
      safeTxHash,
      safeTransactionData: safeTransaction.data,
      senderAddress: getAddress(this.wallet.account.address),
      senderSignature: signature.data,
      origin: "Lumerin deployer",
    });

    return safeTxHash;
  }

  getSafeUITxUrl(txHash: string): string {
    const prefix = chainIdSafePrefixMap[this.wallet.chain.id];
    if (!prefix) {
      throw new Error(`Unsupported chain ${this.wallet.chain.id}`);
    }
    return `https://app.safe.global/transactions/tx?safe=${prefix}:${this.safeAddr}&id=multisig_${this.safeAddr}_${txHash}`;
  }
}

const chainIdSafePrefixMap = {
  [sepolia.id]: "sep",
  [mainnet.id]: "eth",
  [arbitrum.id]: "arb1",
} as Record<number, string>;
