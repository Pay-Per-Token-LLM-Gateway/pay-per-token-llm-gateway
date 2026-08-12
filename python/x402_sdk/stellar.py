"""Stellar payment execution for x402.

Python port of the payment helpers in ``@x402/wallet`` and the payment
flow in ``@x402/sdk`` (``packages/wallet/src/index.ts`` and
``packages/sdk/src/index.ts``). Builds and signs the Stellar payment for a
quote, submits it to Horizon, and waits for on-chain confirmation.

All network access is performed through plain ``httpx`` calls (or an
injected ``httpx.Client``) so the module is fully unit-testable without a
live Horizon connection.
"""

from __future__ import annotations

import time
from decimal import Decimal
from typing import Any, Dict, Optional, Tuple, Union

import httpx
from stellar_sdk import Account, Asset, Keypair, Network, TextMemo, TransactionBuilder, TransactionEnvelope

from .types import Quote, X402ClientConfig

BASE_FEE = 100  # stroops
TRANSACTION_TIMEOUT = 300  # seconds (mirrors setTimeout(300) in the TS wallet)
STELLAR_DECIMALS = 7
CONFIRMATION_POLL_INTERVAL = 2.0  # seconds

NETWORK_PASSPHRASES: Dict[str, str] = {
    "testnet": Network.TESTNET_NETWORK_PASSPHRASE,
    "futurenet": Network.FUTURENET_NETWORK_PASSPHRASE,
    "mainnet": Network.PUBLIC_NETWORK_PASSPHRASE,
}

HORIZON_URLS: Dict[str, str] = {
    "testnet": "https://horizon-testnet.stellar.org",
    "futurenet": "https://horizon-futurenet.stellar.org",
    "mainnet": "https://horizon.stellar.org",
}


def get_horizon_url(network: str) -> str:
    """Return the default Horizon URL for a Stellar network."""
    return HORIZON_URLS.get(network, HORIZON_URLS["testnet"])


def stroops_to_units(amount: str, decimals: int = STELLAR_DECIMALS) -> str:
    """Convert an amount in stroops to decimal asset units as a string.

    Mirrors ``stroopsToUnits`` in ``@x402/shared`` (BigInt division with
    trailing-zero trimming): ``"1000000"`` → ``"0.1"``.
    """
    units = Decimal(int(amount)) / (Decimal(10) ** decimals)
    text = format(units, f".{decimals}f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def units_to_stroops(amount: str, decimals: int = STELLAR_DECIMALS) -> str:
    """Convert a decimal asset amount to stroops as a string.

    Mirrors ``unitsToStroops`` in ``@x402/shared``.
    """
    whole, _, fraction = amount.partition(".")
    padded = (fraction + "0" * decimals)[:decimals]
    return str(int(whole) * (10 ** decimals) + int(padded or "0"))


def _resolve_asset(asset: str, asset_issuer: Optional[str]) -> Asset:
    if asset == "XLM":
        return Asset.native()
    if asset == "USDC" and asset_issuer:
        return Asset(asset, asset_issuer)
    raise ValueError(f"Unsupported asset or missing issuer: {asset}")


def build_payment_envelope(
    source_account: Account,
    destination: str,
    amount: str,
    asset: str,
    asset_issuer: Optional[str],
    memo: Optional[str],
    network: str,
) -> TransactionEnvelope:
    """Build an unsigned payment transaction envelope (no network I/O).

    Mirrors ``buildUnsignedPaymentTransaction``: BASE_FEE, a 300-second
    timeout, and an optional text memo. ``source_account`` must carry the
    current sequence number (see :func:`load_account`).
    """
    passphrase = NETWORK_PASSPHRASES.get(network)
    if passphrase is None:
        raise ValueError(f"Unsupported network: {network}")

    builder = TransactionBuilder(source_account, passphrase, BASE_FEE)
    builder.append_payment_op(destination, _resolve_asset(asset, asset_issuer), amount)
    builder.set_timeout(TRANSACTION_TIMEOUT)
    if memo:
        builder.add_memo(TextMemo(memo))
    return builder.build()


def load_account(horizon_url: str, public_key: str, http_client: Optional[httpx.Client] = None) -> Account:
    """Load a Stellar account (for its sequence number) from Horizon."""
    client = http_client or httpx.Client()
    response = client.get(f"{horizon_url.rstrip('/')}/accounts/{public_key}")
    response.raise_for_status()
    data = response.json()
    return Account(public_key, int(data["sequence"]))


def submit_transaction(
    horizon_url: str, tx_xdr: str, http_client: Optional[httpx.Client] = None
) -> Dict[str, Any]:
    """Submit a signed transaction XDR to Horizon."""
    client = http_client or httpx.Client()
    response = client.post(f"{horizon_url.rstrip('/')}/transactions", data={"tx": tx_xdr})
    response.raise_for_status()
    return response.json()


def wait_for_confirmation(
    horizon_url: str,
    tx_hash: str,
    timeout_ms: int,
    http_client: Optional[httpx.Client] = None,
    poll_interval: float = CONFIRMATION_POLL_INTERVAL,
) -> bool:
    """Poll Horizon until the transaction is confirmed (successful) or the timeout elapses."""
    client = http_client or httpx.Client()
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        try:
            response = client.get(f"{horizon_url.rstrip('/')}/transactions/{tx_hash}")
            if response.is_success:
                if response.json().get("successful"):
                    return True
        except httpx.HTTPError:
            pass  # Transaction not found yet — keep waiting
        if poll_interval > 0:
            time.sleep(poll_interval)
    return False


# ── Payment flow ──────────────────────────────────────────────────────────


def pay_quote(
    quote: Quote,
    config: X402ClientConfig,
    http_client: Optional[httpx.Client] = None,
) -> Tuple[bool, str]:
    """Execute the payment for a quote: build → sign → submit → confirm.

    Returns ``(success, value)`` where ``value`` is the transaction hash on
    success or an error message on failure. Supports both secret-key
    signing and the external signer path (``public_key`` +
    ``sign_transaction``), mirroring the TypeScript SDK.
    """
    if config.sign_transaction:
        if not config.public_key:
            return False, (
                "publicKey is required when using signTransaction (external wallet signing)"
            )
        return _pay_with_external_signer(quote, config, http_client or config.http_client)

    if not config.secret_key:
        return False, (
            f"Payment required. Send {quote.amount} {quote.asset} to {quote.paymentAddress}."
        )
    return _pay_with_secret_key(quote, config, http_client or config.http_client)


def _horizon_url(quote: Quote, config: X402ClientConfig) -> str:
    return config.horizon_url or get_horizon_url(quote.network)


def _build_for_payment(
    horizon_url: str,
    source_public_key: str,
    quote: Quote,
    http_client: Optional[httpx.Client],
) -> TransactionEnvelope:
    account = load_account(horizon_url, source_public_key, http_client)
    return build_payment_envelope(
        source_account=account,
        destination=quote.paymentAddress,
        amount=stroops_to_units(quote.amount),
        asset=quote.asset,
        asset_issuer=quote.assetIssuer,
        memo=quote.memo,
        network=quote.network,
    )


def _pay_with_secret_key(
    quote: Quote,
    config: X402ClientConfig,
    http_client: Optional[httpx.Client],
) -> Tuple[bool, str]:
    try:
        horizon_url = _horizon_url(quote, config)
        keypair = Keypair.from_secret(config.secret_key)
        envelope = _build_for_payment(horizon_url, keypair.public_key, quote, http_client)
        envelope.sign(keypair)
        tx_hash = envelope.hash().hex()

        submit_transaction(horizon_url, envelope.to_xdr(), http_client)

        if not wait_for_confirmation(horizon_url, tx_hash, config.payment_timeout, http_client):
            return False, "Payment not confirmed within timeout"
        return True, tx_hash
    except Exception as error:  # noqa: BLE001 - surface any payment failure to the caller
        return False, f"Payment failed: {error}"


def _pay_with_external_signer(
    quote: Quote,
    config: X402ClientConfig,
    http_client: Optional[httpx.Client],
) -> Tuple[bool, str]:
    try:
        horizon_url = _horizon_url(quote, config)
        envelope = _build_for_payment(horizon_url, config.public_key, quote, http_client)
        tx_hash = envelope.hash().hex()  # hash excludes signatures — stable across signing

        signed_xdr = config.sign_transaction(envelope.to_xdr())
        submit_transaction(horizon_url, signed_xdr, http_client)

        if not wait_for_confirmation(horizon_url, tx_hash, config.payment_timeout, http_client):
            return False, "Payment not confirmed within timeout"
        return True, tx_hash
    except Exception as error:  # noqa: BLE001
        return False, f"External payment failed: {error}"
