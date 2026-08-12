"""Tests for Stellar payment building/execution helpers (offline)."""

from __future__ import annotations

import httpx
import pytest
from stellar_sdk import Account, Keypair, Network, TextMemo, TransactionEnvelope

from x402_sdk.stellar import (
    BASE_FEE,
    HORIZON_URLS,
    build_payment_envelope,
    get_horizon_url,
    load_account,
    pay_quote,
    stroops_to_units,
    submit_transaction,
    units_to_stroops,
    wait_for_confirmation,
)
from x402_sdk.types import Quote, X402ClientConfig

ISSUER = Keypair.random().public_key
DESTINATION = Keypair.random().public_key


def make_quote(**overrides) -> Quote:
    data = {
        "id": "q-1",
        "route": "test/model",
        "pricingModel": "flat",
        "amount": "1000000",
        "asset": "USDC",
        "assetIssuer": ISSUER,
        "paymentAddress": DESTINATION,
        "memo": "abc123",
        "expiresAt": 9999999999,
        "network": "testnet",
        "statusUrl": "https://gateway.test/api/v1/payments/q-1/status",
    }
    data.update(overrides)
    return Quote.from_dict(data)


# ── Amount conversion (mirrors @x402/shared) ──────────────────────────────


@pytest.mark.parametrize(
    "stroops,expected",
    [
        ("1000000", "0.1"),
        ("10000", "0.001"),
        ("0", "0"),
        ("1", "0.0000001"),
        ("1234567890", "123.456789"),
        ("50000000", "5"),
    ],
)
def test_stroops_to_units(stroops, expected):
    assert stroops_to_units(stroops) == expected


@pytest.mark.parametrize(
    "units,expected",
    [
        ("0.1", "1000000"),
        ("0.001", "10000"),
        ("0", "0"),
        ("123.456789", "1234567890"),
        ("5", "50000000"),
    ],
)
def test_units_to_stroops(units, expected):
    assert units_to_stroops(units) == expected


def test_horizon_urls():
    assert get_horizon_url("testnet") == HORIZON_URLS["testnet"]
    assert get_horizon_url("futurenet") == "https://horizon-futurenet.stellar.org"
    assert get_horizon_url("mainnet") == "https://horizon.stellar.org"
    assert get_horizon_url("bogus") == HORIZON_URLS["testnet"]  # safe default


# ── Transaction building (pure, no I/O) ───────────────────────────────────


def test_build_payment_envelope_xlm():
    keypair = Keypair.random()
    account = Account(keypair.public_key, 100)
    envelope = build_payment_envelope(
        source_account=account,
        destination=DESTINATION,
        amount="0.1",
        asset="XLM",
        asset_issuer=None,
        memo=None,
        network="testnet",
    )
    assert isinstance(envelope, TransactionEnvelope)
    assert len(envelope.hash().hex()) == 64
    assert envelope.to_xdr()  # serializable


def test_build_payment_envelope_usdc_with_memo():
    keypair = Keypair.random()
    account = Account(keypair.public_key, 100)
    envelope = build_payment_envelope(
        source_account=account,
        destination=DESTINATION,
        amount="0.1",
        asset="USDC",
        asset_issuer=ISSUER,
        memo="abc123",
        network="testnet",
    )
    xdr = envelope.to_xdr()
    parsed = TransactionEnvelope.from_xdr(xdr, Network.TESTNET_NETWORK_PASSPHRASE)
    memo = parsed.transaction.memo
    assert isinstance(memo, TextMemo)  # MEMO_TEXT
    memo_value = memo.memo_text
    assert memo_value.decode() if isinstance(memo_value, bytes) else memo_value == "abc123"
    assert parsed.transaction.operations[0].destination.account_id == DESTINATION


def test_build_payment_envelope_signing_keeps_hash_stable():
    keypair = Keypair.random()
    account = Account(keypair.public_key, 100)
    envelope = build_payment_envelope(
        source_account=account,
        destination=DESTINATION,
        amount="1",
        asset="XLM",
        asset_issuer=None,
        memo="m1",
        network="testnet",
    )
    unsigned_hash = envelope.hash().hex()
    envelope.sign(keypair)
    signed_hash = envelope.hash().hex()
    # Stellar tx hash excludes the signature envelope — signing must not change it.
    assert unsigned_hash == signed_hash


def test_build_payment_envelope_rejects_missing_issuer():
    keypair = Keypair.random()
    account = Account(keypair.public_key, 100)
    with pytest.raises(ValueError, match="issuer"):
        build_payment_envelope(
            source_account=account,
            destination=DESTINATION,
            amount="1",
            asset="USDC",
            asset_issuer=None,
            memo=None,
            network="testnet",
        )


def test_build_payment_envelope_rejects_unknown_network():
    keypair = Keypair.random()
    account = Account(keypair.public_key, 100)
    with pytest.raises(ValueError, match="network"):
        build_payment_envelope(
            source_account=account,
            destination=DESTINATION,
            amount="1",
            asset="XLM",
            asset_issuer=None,
            memo=None,
            network="testnet-bogus",
        )


# ── Network helpers with mock transport ───────────────────────────────────


def _mock_client() -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.startswith("/accounts/"):
            return httpx.Response(200, json={"sequence": "250"})
        if request.method == "POST" and path == "/transactions":
            assert b"tx=" in request.content  # form-encoded XDR submission
            return httpx.Response(200, json={"hash": "f" * 64, "successful": True})
        if request.method == "GET" and path.startswith("/transactions/"):
            return httpx.Response(200, json={"successful": True})
        return httpx.Response(404)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_load_account_reads_sequence():
    client = _mock_client()
    public_key = Keypair.random().public_key
    account = load_account("https://horizon.test", public_key, client)
    assert account.sequence == 250


def test_submit_transaction_posts_form_encoded_xdr():
    client = _mock_client()
    result = submit_transaction("https://horizon.test", "AAAA...", client)
    assert result["successful"] is True


def test_wait_for_confirmation_polls_until_successful():
    client = _mock_client()
    assert wait_for_confirmation(
        "https://horizon.test", "f" * 64, timeout_ms=5000, http_client=client, poll_interval=0
    ) is True


def test_wait_for_confirmation_timeout_returns_false():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert (
        wait_for_confirmation(
            "https://horizon.test", "f" * 64, timeout_ms=100, http_client=client, poll_interval=0
        )
        is False
    )


# ── pay_quote orchestration ───────────────────────────────────────────────


def test_pay_quote_missing_secret_returns_manual_instructions():
    quote = make_quote()
    config = X402ClientConfig(gateway_url="https://gateway.test", network="testnet")
    ok, value = pay_quote(quote, config)
    assert ok is False
    assert "Payment required. Send" in value


def test_pay_quote_external_signer_without_public_key():
    quote = make_quote()
    config = X402ClientConfig(
        gateway_url="https://gateway.test", network="testnet", sign_transaction=lambda x: x
    )
    ok, value = pay_quote(quote, config)
    assert ok is False
    assert "publicKey is required" in value


def test_pay_quote_full_flow_with_secret_key():
    keypair = Keypair.random()
    quote = make_quote()
    config = X402ClientConfig(
        gateway_url="https://gateway.test",
        network="testnet",
        secret_key=keypair.secret,
        horizon_url="https://horizon.test",
        payment_timeout=5000,
        http_client=_mock_client(),
    )
    ok, value = pay_quote(quote, config)
    assert ok is True
    assert len(value) == 64  # tx hash hex


def test_pay_quote_full_flow_external_signer():
    keypair = Keypair.random()
    quote = make_quote()
    signed_xdrs = []

    def sign_transaction(xdr: str) -> str:
        signed_xdrs.append(xdr)
        return xdr

    config = X402ClientConfig(
        gateway_url="https://gateway.test",
        network="testnet",
        public_key=keypair.public_key,
        sign_transaction=sign_transaction,
        horizon_url="https://horizon.test",
        payment_timeout=5000,
        http_client=_mock_client(),
    )
    ok, value = pay_quote(quote, config)
    assert ok is True
    assert len(value) == 64
    assert len(signed_xdrs) == 1
    assert signed_xdrs[0]  # unsigned XDR handed to the external signer
