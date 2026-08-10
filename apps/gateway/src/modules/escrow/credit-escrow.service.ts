import { Injectable, Logger } from '@nestjs/common';
import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { getConfig } from '@x402/config';

export interface EscrowCheck {
  useEscrow: boolean;
  balance: bigint;
  requiredAmount: bigint;
  reason: 'escrow_sufficient' | 'escrow_insufficient' | 'escrow_unavailable';
}

export interface EscrowUsageEvent {
  user: string;
  amount: string;
  quoteId: string;
  timestamp: number;
}

export interface ChargeResult {
  txHash: string;
  charged: bigint;
  remaining: bigint;
}

/** Small Soroban client for the credit-escrow contract. */
@Injectable()
export class CreditEscrowService {
  private readonly logger = new Logger(CreditEscrowService.name);
  private readonly config = getConfig();
  private readonly gatewayKey = this.loadGatewayKey();

  isConfigured(): boolean {
    return Boolean(this.gatewayKey && this.config.contracts.creditEscrow);
  }

  async checkEscrow(userAddress: string, estimatedCost: bigint): Promise<EscrowCheck> {
    const requiredAmount = BigInt(estimatedCost);
    if (!this.isConfigured() || requiredAmount <= 0n || !this.isValidAddress(userAddress)) {
      return {
        useEscrow: false,
        balance: 0n,
        requiredAmount,
        reason: 'escrow_unavailable',
      };
    }

    try {
      const balance = await this.readBalance(userAddress);
      return {
        useEscrow: balance >= requiredAmount,
        balance,
        requiredAmount,
        reason: balance >= requiredAmount ? 'escrow_sufficient' : 'escrow_insufficient',
      };
    } catch (error) {
      this.logger.warn(`Escrow balance check failed; falling back to x402: ${String(error)}`);
      return {
        useEscrow: false,
        balance: 0n,
        requiredAmount,
        reason: 'escrow_unavailable',
      };
    }
  }

  async readBalance(userAddress: string): Promise<bigint> {
    const value = await this.simulateRead('balance', [
      nativeToScVal(this.assertAddress(userAddress), { type: 'address' }),
    ]);
    return BigInt((value as string | number | bigint | undefined) ?? 0);
  }

  async readUsage(userAddress: string, offset = 0, limit = 50): Promise<EscrowUsageEvent[]> {
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const value = await this.simulateRead('get_usage', [
      nativeToScVal(this.assertAddress(userAddress), { type: 'address' }),
      nativeToScVal(safeOffset, { type: 'u32' }),
      nativeToScVal(safeLimit, { type: 'u32' }),
    ]);

    if (!Array.isArray(value)) return [];
    return value.map((raw) => {
      const event = raw as Record<string, unknown>;
      return {
        user: String(event.user ?? userAddress),
        amount: String(event.amount ?? '0'),
        quoteId: String(event.quote_id ?? event.quoteId ?? ''),
        timestamp: Number(event.timestamp ?? 0),
      };
    });
  }

  async charge(userAddress: string, actualCost: bigint, quoteId: string): Promise<ChargeResult> {
    const key = this.requireGatewayKey();
    const amount = BigInt(actualCost);
    if (amount < 0n) throw new Error('Escrow charge amount cannot be negative');
    if (!quoteId) throw new Error('Escrow charge requires a quote id');

    const rpc = this.createRpc();
    const account = await rpc.getAccount(key.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.stellar.networkPassphrase || Networks.TESTNET,
    })
      .addOperation(
        new Contract(this.config.contracts.creditEscrow).call(
          'charge',
          nativeToScVal(this.assertAddress(userAddress), { type: 'address' }),
          nativeToScVal(amount.toString(), { type: 'i128' }),
          nativeToScVal(quoteId, { type: 'string' }),
        ),
      )
      .setTimeout(60)
      .build();

    const prepared = await rpc.prepareTransaction(transaction);
    prepared.sign(key);
    const sent = await rpc.sendTransaction(prepared);
    if (sent.status !== 'PENDING') {
      throw new Error(`Escrow charge was not accepted: ${sent.status}`);
    }

    const result = await this.waitForTransaction(rpc, sent.hash);
    if (result.status !== 'SUCCESS') {
      throw new Error(`Escrow charge failed on-chain: ${result.status}`);
    }

    return {
      txHash: sent.hash,
      charged: amount,
      remaining: await this.readBalance(userAddress),
    };
  }

  private async simulateRead(method: string, args: xdr.ScVal[]): Promise<unknown> {
    const key = this.requireGatewayKey();
    const rpc = this.createRpc();
    const account = await rpc.getAccount(key.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.stellar.networkPassphrase || Networks.TESTNET,
    })
      .addOperation(new Contract(this.config.contracts.creditEscrow).call(method, ...args))
      .setTimeout(60)
      .build();
    const simulation = await rpc.simulateTransaction(transaction);
    if (SorobanRpc.Api.isSimulationError(simulation) || !simulation.result) {
      throw new Error(`Soroban simulation failed for ${method}`);
    }
    return scValToNative(simulation.result.retval);
  }

  private async waitForTransaction(rpc: SorobanRpc.Server, hash: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await rpc.getTransaction(hash);
      if (result.status !== 'NOT_FOUND') return result;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Timed out waiting for Soroban transaction confirmation');
  }

  private createRpc(): SorobanRpc.Server {
    return new SorobanRpc.Server(this.config.stellar.sorobanRpcUrl);
  }

  private loadGatewayKey(): Keypair | undefined {
    const secret = this.config.payment.contractAdminSecret;
    if (!secret) {
      this.logger.warn(
        'Escrow disabled: CONTRACT_ADMIN_SECRET/STELLAR_SECRET_KEY is not configured',
      );
      return undefined;
    }
    try {
      return Keypair.fromSecret(secret);
    } catch {
      this.logger.error('Escrow disabled: configured contract admin secret is invalid');
      return undefined;
    }
  }

  private requireGatewayKey(): Keypair {
    if (!this.gatewayKey) throw new Error('Credit escrow is not configured');
    return this.gatewayKey;
  }

  private assertAddress(address: string): string {
    if (!this.isValidAddress(address)) throw new Error('Invalid Stellar user address');
    return address;
  }

  private isValidAddress(address: string): boolean {
    return typeof address === 'string' && StrKey.isValidEd25519PublicKey(address);
  }
}
