"""
x402 SDK — Stellar wallet utilities mirroring @x402/wallet.

Uses the `stellar-sdk` Python package to build, sign, submit, and verify
Stellar payment transactions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from .types import PaymentAsset, StellarAddress, StellarNetwork, TxHash

logger = logging.getLogger(__name__)

try:
    from stellar_sdk import Asset, Keypair, Memo, Network, Operation, TransactionBuilder
    from stellar_sdk import Server as StellarServer
    _STELLAR_AVAILABLE = True
except ImportError:  # pragma: no cover
    _STELLAR_AVAILABLE = False


# ── Network Configuration ────────────────────

NETWORK_PASSPHRASES: dict[str, str] = {
    'public': 'Public Global Stellar Network ; September 2015',
    'testnet': 'Test SDF Network ; September 2015',
    'futurenet': 'Test SDF Future Network ; October 2022',
}

HORIZON_URLS: dict[StellarNetwork, str] = {
    'mainnet': 'https://horizon.stellar.org',
    'testnet': 'https://horizon-testnet.stellar.org',
    'futurenet': 'https://horizon-futurenet.stellar.org',
}

SOROBAN_RPC_URLS: dict[StellarNetwork, str] = {
    'mainnet': 'https://soroban-mainnet.stellar.org',
    'testnet': 'https://soroban-testnet.stellar.org',
    'futurenet': 'https://rpc-futurenet.stellar.org',
}


def get_network_passphrase(network: StellarNetwork) -> str:
    """Return the network passphrase for a Stellar network."""
    if network == 'mainnet':
        return NETWORK_PASSPHRASES['public']
    return NETWORK_PASSPHRASES[network]


def get_horizon_url(network: StellarNetwork) -> str:
    """Return the Horizon API URL for a Stellar network."""
    return HORIZON_URLS[network]


def get_soroban_rpc_url(network: StellarNetwork) -> str:
    """Return the Soroban RPC URL for a Stellar network."""
    return SOROBAN_RPC_URLS[network]


# ── Key Management ───────────────────────────

def generate_keypair() -> dict[str, str]:
    """Generate a new Stellar keypair."""
    if not _STELLAR_AVAILABLE:
        raise ImportError('stellar-sdk is required. Install with: pip install x402-sdk[stellar]')
    kp = Keypair.random()
    return {'publicKey': kp.public_key, 'secretKey': kp.secret}


def keypair_from_secret(secret: str) -> 'Keypair':
    """Create a Keypair from a secret seed."""
    if not _STELLAR_AVAILABLE:
        raise ImportError('stellar-sdk is required. Install with: pip install x402-sdk[stellar]')
    return Keypair.from_secret(secret)


# ── Payment Transaction Builder ──────────────

@dataclass
class BuildPaymentOptions:
    """Options for building a Stellar payment transaction."""

    sourceSecret: str
    destination: StellarAddress
    amount: str
    asset: PaymentAsset
    assetIssuer: Optional[str] = None
    memo: Optional[str] = None
    network: StellarNetwork = 'testnet'
    horizonUrl: Optional[str] = None


@dataclass
class BuiltPayment:
    """A signed Stellar payment transaction."""

    txXdr: str
    txHash: TxHash


def build_payment_transaction(options: BuildPaymentOptions) -> BuiltPayment:
    """
    Build and sign a Stellar payment transaction.

    Returns the signed transaction XDR and the transaction hash.
    """
    if not _STELLAR_AVAILABLE:
        raise ImportError('stellar-sdk is required. Install with: pip install x402-sdk[stellar]')

    source_keypair = Keypair.from_secret(options.sourceSecret)
    horizon_url = options.horizonUrl or get_horizon_url(options.network)
    server = StellarServer(horizon_url)
    source_account = server.load_account(source_keypair.public_key)
    passphrase = get_network_passphrase(options.network)

    if options.asset == 'XLM':
        stellar_asset = Asset.native()
    elif options.asset == 'USDC' and options.assetIssuer:
        stellar_asset = Asset(options.asset, options.assetIssuer)
    else:
        raise ValueError(f'Unsupported asset or missing issuer: {options.asset}')

    builder = TransactionBuilder(
        source_account=source_account,
        network_passphrase=passphrase,
        base_fee=100,
    ).add_time_bounds(min_time=0, max_time=300)

    builder.append_payment_op(
        destination=options.destination,
        asset=stellar_asset,
        amount=options.amount,
    )

    if options.memo:
        builder.add_text_memo(options.memo)

    tx = builder.build()
    tx.sign(source_keypair)

    return BuiltPayment(
        txXdr=tx.to_xdr(),
        txHash=tx.hash().hex(),
    )


# ── Horizon Helpers ──────────────────────────

def create_horizon_server(network: StellarNetwork = 'testnet',
                          custom_url: Optional[str] = None) -> 'StellarServer':
    """Create a Horizon server instance for the given network."""
    if not _STELLAR_AVAILABLE:
        raise ImportError('stellar-sdk is required. Install with: pip install x402-sdk[stellar]')
    url = custom_url or get_horizon_url(network)
    return StellarServer(url)


def account_exists(address: StellarAddress, server: 'StellarServer') -> bool:
    """Check if a Stellar account exists on the network."""
    try:
        server.load_account(address)
        return True
    except Exception:
        return False


def get_account_balances(address: StellarAddress,
                         server: 'StellarServer') -> list[dict[str, Optional[str]]]:
    """Get account balances for a Stellar address."""
    try:
        account = server.load_account(address)
        balances = []
        for b in account.balances:
            if b.asset_type == 'native':
                balances.append({'asset': 'XLM', 'balance': b.balance, 'issuer': None})
            else:
                balances.append({
                    'asset': b.asset_code,
                    'balance': b.balance,
                    'issuer': getattr(b, 'asset_issuer', None),
                })
        return balances
    except Exception:
        return []


def get_transaction(tx_hash: TxHash, server: 'StellarServer') -> Optional[dict]:
    """Lookup a transaction by hash. Returns None if not found."""
    try:
        return server.transactions().transaction(tx_hash).call()
    except Exception:
        return None


# ── Wallet Auth Signing (for dashboard login) ─

def sign_challenge(secret_key: str, challenge: str) -> str:
    """Sign a challenge string for wallet-based authentication. Returns base64."""
    if not _STELLAR_AVAILABLE:
        raise ImportError('stellar-sdk is required. Install with: pip install x402-sdk[stellar]')
    keypair = Keypair.from_secret(secret_key)
    message = challenge.encode('utf-8')
    signature = keypair.sign(message)
    import base64
    return base64.b64encode(signature).decode('utf-8')


def verify_challenge(public_key: StellarAddress, challenge: str, signature: str) -> bool:
    """Verify a challenge signature."""
    try:
        if not _STELLAR_AVAILABLE:
            return False
        keypair = Keypair.from_public_key(public_key)
        message = challenge.encode('utf-8')
        import base64
        sig_buffer = base64.b64decode(signature)
        return keypair.verify(message, sig_buffer)
    except Exception:
        logger.error('Challenge verification failed', exc_info=True)
        return False