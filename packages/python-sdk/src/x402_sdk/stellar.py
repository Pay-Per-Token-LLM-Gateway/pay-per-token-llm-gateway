from __future__ import annotations

import time

import requests

from .models import PaymentQuote, X402Error

DEFAULT_CONFIRMATION_TIMEOUT = 300.0
DEFAULT_CONFIRMATION_INTERVAL = 2.0


def get_horizon_url(network: str) -> str:
    if network == "mainnet":
        return "https://horizon.stellar.org"
    if network == "futurenet":
        return "https://horizon-futurenet.stellar.org"
    return "https://horizon-testnet.stellar.org"


def get_network_passphrase(network: str) -> str:
    if network == "mainnet":
        return "Public Global Stellar Network ; September 2015"
    if network == "futurenet":
        return "Test SDF Future Network ; October 2022"
    return "Test SDF Network ; September 2015"


def pay_quote_with_stellar(
    quote: PaymentQuote,
    *,
    source_secret: str,
    horizon_url: str | None = None,
    confirmation_timeout: float = DEFAULT_CONFIRMATION_TIMEOUT,
    confirmation_interval: float = DEFAULT_CONFIRMATION_INTERVAL,
) -> str:
    """Build, sign, submit, and confirm a Stellar payment for an x402 quote."""

    try:
        from stellar_sdk import Asset, Keypair, Server, TransactionBuilder
    except ImportError as exc:
        raise X402Error(
            "stellar-sdk is required for Stellar payments; install x402-sdk[stellar]"
        ) from exc

    resolved_horizon_url = horizon_url or get_horizon_url(quote.network)
    server = Server(horizon_url=resolved_horizon_url)
    source_keypair = Keypair.from_secret(source_secret)
    source_account = server.load_account(source_keypair.public_key)

    if quote.asset == "XLM":
        asset = Asset.native()
    elif quote.asset_issuer:
        asset = Asset(quote.asset, quote.asset_issuer)
    else:
        raise X402Error(f"unsupported asset or missing issuer: {quote.asset}")

    builder = TransactionBuilder(
        source_account=source_account,
        network_passphrase=get_network_passphrase(quote.network),
        base_fee=100,
    )
    if quote.memo:
        builder = builder.add_text_memo(quote.memo)

    transaction = (
        builder.append_payment_op(
            destination=quote.payment_address,
            asset=asset,
            amount=quote.amount,
        )
        .set_timeout(300)
        .build()
    )
    transaction.sign(source_keypair)

    result = server.submit_transaction(transaction)
    tx_hash = str(result.get("hash") or result.get("id") or "")
    if not tx_hash:
        raise X402Error("Stellar payment submission did not return a transaction hash")

    if not _wait_for_confirmation(
        tx_hash,
        horizon_url=resolved_horizon_url,
        timeout=confirmation_timeout,
        interval=confirmation_interval,
    ):
        raise X402Error("payment not confirmed within timeout")

    return tx_hash


def _wait_for_confirmation(
    tx_hash: str,
    *,
    horizon_url: str,
    timeout: float,
    interval: float,
) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            response = requests.get(
                f"{horizon_url.rstrip('/')}/transactions/{tx_hash}",
                timeout=10,
            )
            if response.ok and response.json().get("successful"):
                return True
        except requests.RequestException:
            pass
        time.sleep(interval)
    return False
