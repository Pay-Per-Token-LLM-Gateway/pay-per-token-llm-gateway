/**
 * Soroban contract client for the multisig wallet contract.
 *
 * Enables automated provider payouts: gateway revenue is paid out to
 * providers through the M-of-N multisig wallet. For threshold = 1 the
 * payout is executed immediately; for higher thresholds proposals are
 * exposed in the dashboard for signer approval.
 *
 * Requires `CONTRACT_ADMIN_SECRET` and `PAYOUT_AUTOMATION_ENABLED=true`.
 */

import { Address, xdr, Keypair } from '@stellar/stellar-sdk';
import { logger } from '@x402/logger';

/** Convert a Stellar account address to an Address ScVal. */
function accountAddressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

/** Convert a non-negative stroop amount to a signed 128-bit ScVal. */
function amountToScVal(amount: string): xdr.ScVal {
  const value = BigInt(amount);
  if (value < 0n) throw new Error('Amount must be non-negative');
  const lo = xdr.Uint64.fromString(value.toString());
  const hi = xdr.Int64.fromString('0');
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo, hi }));
}

// ── Public API ───────────────────────────────

export interface PayoutProposeOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Secret key of the contract admin (signs the invocation). */
  adminSecret: string;
  /** Destination wallet address. */
  destination: string;
  /** Amount in stroops. */
  amount: string;
}

export interface PayoutApproveOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  adminSecret: string;
  /** On-chain proposal ID returned by propose. */
  proposalId: string;
  /** Signer address executing the approval. */
  signer: string;
}

export interface MultisigResult {
  success: boolean;
  proposalId?: number;
  txHash?: string;
  error?: string;
}

export interface MultisigConfigResult {
  signers: string[];
  threshold: number;
}

// ── Core Operations ───────────────────────────

/**
 * Propose a payout on the multisig contract.
 *
 * Creates a proposal on-chain. If the threshold is 1, the payout is
 * executed immediately. Returns the on-chain proposal ID.
 */
export async function proposePayout(
  options: PayoutProposeOptions,
): Promise<MultisigResult> {
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
    const result = await tx.send();

    const proposalId = result?.result?._return?.[0] ?? 0;

    logger.info('[multisig] Payout proposed on-chain', {
      destination: destination.slice(0, 8),
      amount,
      proposalId,
    });
    return { success: true, proposalId };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      `[multisig] proposePayout failed for destination ${destination.slice(0, 8)}... — ` +
        `skipping on-chain proposal. Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Approve a pending payout proposal on the multisig contract.
 *
 * If the threshold is reached after this approval, the payout is
 * executed automatically by the contract.
 */
export async function approvePayout(
  options: PayoutApproveOptions,
): Promise<MultisigResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, proposalId, signer } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({ contractId, rpcUrl, networkPassphrase });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.approve({
      signer: accountAddressToScVal(signer),
      proposal_id: xdr.ScVal.scvU32(Number(proposalId)),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    logger.info('[multisig] Payout approved on-chain', {
      proposalId,
      signer: signer.slice(0, 8),
    });
    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      `[multisig] approvePayout failed for proposal ${proposalId} — ` +
        `Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Fetch the contract config (signers, threshold).
 */
export async function getMultisigConfig(
  contractId: string,
  rpcUrl: string,
  networkPassphrase: string,
): Promise<MultisigConfigResult | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({ contractId, rpcUrl, networkPassphrase });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = await client.get_config();

    return {
      signers: (config.signers as string[]).map((s: string) => s.toString()),
      threshold: Number(config.threshold),
    };
  } catch (err) {
    logger.warn(
      `[multisig] getMultisigConfig failed — falling back to default. Error: ${(err as Error).message}`,
    );
    return null;
  }
}