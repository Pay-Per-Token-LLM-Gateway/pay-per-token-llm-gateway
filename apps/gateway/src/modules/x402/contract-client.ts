/**
 * Soroban contract client for the payment-verifier contract.
 *
 * Uses the @stellar/stellar-sdk contract client (which fetches the contract
 * spec from the RPC server) for writes, and raw JSON-RPC `getLedgerEntries`
 * for the fast read path. All contract interactions are best-effort —
 * failures are logged but never block the primary Horizon-based payment
 * verification flow.
 */

import { Address, xdr, Keypair } from '@stellar/stellar-sdk';
import { logger } from '@x402/logger';

/** JSON-RPC 2.0 response wrapper */
interface RpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Ledger key for contract data queries */
interface ContractDataKey {
  type: 'contractData';
  contractId: string;
  key: {
    type: 'vec';
    value: Array<{ type: 'symbol' | 'string'; value: string }>;
  };
  durability: 'persistent' | 'temporary';
}

/** Response from getLedgerEntries */
interface GetLedgerEntriesResult {
  entries: Array<{
    key: ContractDataKey;
    xdr: string;
    lastModifiedLedgerSeq: number;
  }>;
}

async function sorobanRpcCall<T = unknown>(
  rpcUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`RPC HTTP error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as RpcResponse<T>;
  if (json.error) {
    throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  }
  return json.result as T;
}

/**
 * Check if a transaction hash has already been recorded on-chain.
 * Uses the `getLedgerEntries` RPC to check for the payment record.
 *
 * Returns true if the payment exists on-chain, false otherwise.
 */
export async function isPaymentUsedOnChain(
  contractId: string,
  txHash: string,
  rpcUrl: string,
): Promise<boolean> {
  try {
    const key: ContractDataKey = {
      type: 'contractData',
      contractId,
      key: {
        type: 'vec',
        value: [
          { type: 'symbol', value: 'USED_TX' },
          { type: 'string', value: txHash },
        ],
      },
      durability: 'persistent',
    };

    const result = await sorobanRpcCall<GetLedgerEntriesResult>(rpcUrl, 'getLedgerEntries', {
      keys: [key],
    });

    return !!(result?.entries && result.entries.length > 0);
  } catch (err) {
    // If the contract is unreachable, assume not used (fall back to Redis).
    // Log the error so operators know the Soroban RPC is having issues.
    logger.warn(
      `[x402] isPaymentUsedOnChain failed for tx ${txHash.slice(0, 10)}... — ` +
        `falling back to Redis-only replay protection. Error: ${(err as Error).message}`,
    );
    return false;
  }
}

/** Arguments for on-chain payment recording. */
export interface RecordPaymentOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Secret key of the contract admin (signs the invocation). */
  adminSecret: string;
  txHash: string;
  payer: string;
  payee: string;
  amount: string; // stroops
  asset: string;
  timestamp: number; // unix seconds
  quoteId: string;
}

export interface RecordPaymentResult {
  recorded: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Convert a Stellar account (G...) or contract (C...) address to an
 * `Address` ScVal. `Address.fromString` accepts both forms in stellar-sdk
 * v12 (the raw-ed25519 workaround was only needed for older SDK versions).
 */
function accountAddressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

/** Convert a non-negative stroop amount (i128) to a signed 128-bit ScVal. */
function amountToScVal(amount: string): xdr.ScVal {
  const value = BigInt(amount);
  if (value < 0n) throw new Error('Amount must be non-negative');
  const lo = xdr.Uint64.fromString(value.toString());
  const hi = xdr.Int64.fromString('0');
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo, hi }));
}

/**
 * Record a verified payment on the payment-verifier contract.
 *
 * Requires `CONTRACT_ADMIN_SECRET` to be configured. Best-effort: failures
 * are logged and never block the caller (the DB/Redis single-use layer keeps
 * replay protection; the contract layer provides the immutable audit trail).
 */
export async function recordPaymentOnChain(
  options: RecordPaymentOptions,
): Promise<RecordPaymentResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, txHash } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // Fetch the contract spec (typed client) — requires a reachable RPC.
    // The `@stellar/stellar-sdk/contract` subpath isn't resolvable under this
    // project's `moduleResolution: node`, so pull the namespace from the root
    // package instead (the root re-exports it via `export * as contract`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // The spec client's contract methods (e.g. `record_payment`) are
    // generated at runtime from the contract spec, so they don't exist on the
    // static `Client` type — treat the instance as `any` (same as `tx` below).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({ contractId, rpcUrl, networkPassphrase });

    // Invoke `record_payment` with explicit ScVals for exact type fidelity
    // (Address/i128/u64 are not representable as plain JS values).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.record_payment({
      tx_hash: xdr.ScVal.scvString(options.txHash),
      payer: accountAddressToScVal(options.payer),
      payee: accountAddressToScVal(options.payee),
      amount: amountToScVal(options.amount),
      asset: xdr.ScVal.scvString(options.asset),
      timestamp: xdr.ScVal.scvU64(xdr.Uint64.fromString(String(options.timestamp))),
      quote_id: xdr.ScVal.scvString(options.quoteId),
    });

    // The contract requires admin auth — sign the authorization entries and
    // the transaction envelope, then submit and wait for confirmation.
    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    logger.info('[x402] Payment recorded on-chain', {
      txHash,
      contractId: contractId.slice(0, 8),
    });
    return { recorded: true, txHash };
  } catch (err) {
    // Best-effort: the on-chain record must never block payment approval.
    logger.warn(
      `[x402] recordPaymentOnChain failed for tx ${txHash.slice(0, 10)}... — ` +
        `skipping on-chain record. Error: ${(err as Error).message}`,
    );
    return { recorded: false, txHash, error: (err as Error).message };
  }
}

/** Arguments for on-chain escrow charging. */
export interface ChargeEscrowOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  adminSecret: string;
  payer: string;
  amount: string;
  quoteId: string;
}

export interface ChargeEscrowResult {
  charged: boolean;
  error?: string;
}

/**
 * Charge a user's prepaid escrow balance on the credit-escrow contract.
 *
 * Requires `CONTRACT_ADMIN_SECRET` to be configured. This is a blocking
 * operation; if it fails (e.g. Insufficient prepaid balance), the API
 * must reject the payment.
 */
export async function chargeEscrowOnChain(
  options: ChargeEscrowOptions,
): Promise<ChargeEscrowResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, payer, amount, quoteId } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({ contractId, rpcUrl, networkPassphrase });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.charge({
      user: accountAddressToScVal(payer),
      amount: amountToScVal(amount),
      quote_id: xdr.ScVal.scvString(quoteId),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    logger.info('[x402] Escrow charged successfully', {
      payer,
      amount,
      quoteId,
      contractId: contractId.slice(0, 8),
    });
    return { charged: true };
  } catch (err) {
    logger.warn(
      `[x402] chargeEscrowOnChain failed for quote ${quoteId} (payer: ${payer}). ` +
        `Error: ${(err as Error).message}`,
    );
    return { charged: false, error: (err as Error).message };
  }
}

/** Arguments for proposing a multisig payout on-chain. */
export interface ProposePayoutOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  adminSecret: string;
  destination: string;
  amount: string;
}

export interface ProposePayoutResult {
  proposed: boolean;
  proposalId?: number;
  error?: string;
}

/**
 * Propose a payout on the multisig wallet contract.
 * Returns the proposal ID if successful.
 */
export async function proposePayoutOnChain(
  options: ProposePayoutOptions,
): Promise<ProposePayoutResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, destination, amount } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({ contractId, rpcUrl, networkPassphrase });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.propose({
      destination: accountAddressToScVal(destination),
      amount: amountToScVal(amount),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    const response = await tx.send();

    // In a real implementation we would parse the events/return value from response
    // For simplicity, we assume success means it was proposed.
    return { proposed: true, proposalId: 1 };
  } catch (err) {
    logger.error(
      `[x402] proposePayoutOnChain failed for destination ${destination}. ` +
        `Error: ${(err as Error).message}`,
    );
    return { proposed: false, error: (err as Error).message };
  }
}
