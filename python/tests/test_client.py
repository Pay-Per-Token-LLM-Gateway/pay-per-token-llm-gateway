"""Tests for the x402 Python SDK client — 402 → pay → retry flow.

All HTTP interactions go through ``httpx.MockTransport`` so the suite runs
fully offline against a simulated gateway + Horizon.
"""

from __future__ import annotations

import json
import time
from typing import Dict, List

import httpx
import pytest
from stellar_sdk import Keypair

from x402_sdk.client import X402Client, create_x402_client
from x402_sdk.types import X402ClientConfig

ISSUER = Keypair.random().public_key
DESTINATION = Keypair.random().public_key
CHAT_RESPONSE = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 1750000000,
    "model": "test/model",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Hello from x402!"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
}
RECEIPT = {
    "id": "rcpt-1",
    "quoteId": "q-1",
    "txHash": "a" * 64,
    "payerAddress": "G" + "A" * 55,
    "amount": "1000000",
    "asset": "USDC",
    "route": "test/model",
    "status": "verified",
    "verifiedAt": "2026-08-12T00:00:00Z",
    "ledger": 12345,
}


def make_quote(**overrides: Dict) -> Dict:
    quote = {
        "id": "q-1",
        "route": "test/model",
        "pricingModel": "flat",
        "amount": "1000000",
        "asset": "USDC",
        "assetIssuer": ISSUER,
        "paymentAddress": DESTINATION,
        "memo": "abc123",
        "expiresAt": int(time.time()) + 300,
        "network": "testnet",
        "statusUrl": "https://gateway.test/api/v1/payments/q-1/status",
    }
    quote.update(overrides)
    return quote


def payment_required(quote: Dict) -> Dict:
    return {
        "status": 402,
        "message": "Payment required",
        "quote": quote,
        "instructions": "Send 0.1 USDC with memo abc123",
        "docs": "https://docs.x402.org",
    }


class FakeHorizon:
    """Simulates the parts of Horizon the SDK touches."""

    def __init__(self) -> None:
        self.submitted: List[str] = []
        self.confirmed = True

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.startswith("/accounts/"):
            return httpx.Response(200, json={"sequence": "100"})
        if request.method == "POST" and path == "/transactions":
            self.submitted.append(request.content.decode())
            return httpx.Response(200, json={"hash": "f" * 64})
        if request.method == "GET" and path.startswith("/transactions/"):
            if self.confirmed:
                return httpx.Response(200, json={"successful": True, "hash": "f" * 64})
            return httpx.Response(404, json={"type": "https://stellar.org/horizon-errors/not_found"})
        return httpx.Response(500, json={"error": "unexpected"})


def make_client(
    horizon: FakeHorizon,
    *,
    secret_key: str = None,
    public_key: str = None,
    sign_transaction=None,
    default_asset: str = "USDC",
    extra_requests: Dict = None,
    paid_response: Dict = None,
    paid_headers: Dict = None,
) -> X402Client:
    keypair = (
        Keypair.random()
        if secret_key is None and public_key is None and sign_transaction is None
        else None
    )
    config = {
        "gateway_url": "https://gateway.test",
        "network": "testnet",
        "default_asset": default_asset,
        "horizon_url": "https://horizon.test",
        "payment_timeout": 10_000,
        "secret_key": secret_key or (keypair.secret if keypair else None),
        "public_key": public_key or (keypair.public_key if keypair else None),
        "sign_transaction": sign_transaction,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "horizon.test":
            return horizon.handle(request)
        if request.url.host == "gateway.test":
            if request.headers.get("X-Payment-Hash"):
                headers = dict(paid_headers or {})
                return httpx.Response(
                    200,
                    json=paid_response if paid_response is not None else CHAT_RESPONSE,
                    headers=headers,
                )
            # 402 for the quoted model, else pass through extra routes.
            for pattern, response in (extra_requests or {}).items():
                if pattern in request.url.path:
                    return response
            return httpx.Response(402, json=payment_required(make_quote()))
        return httpx.Response(500, json={"error": "unexpected"})

    config["http_client"] = httpx.Client(transport=httpx.MockTransport(handler))
    return X402Client(X402ClientConfig(**config))


# ── Non-streaming calls ───────────────────────────────────────────────────


def test_call_without_payment_returns_response_directly():
    horizon = FakeHorizon()
    client = make_client(horizon)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=CHAT_RESPONSE)

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    result = client.call({"model": "test/model", "messages": [{"role": "user", "content": "hi"}]})

    assert result.success is True
    assert result.response["choices"][0]["message"]["content"] == "Hello from x402!"
    assert result.cost.amount == "0"
    assert result.error is None


def test_call_full_402_pay_retry_flow():
    horizon = FakeHorizon()
    client = make_client(horizon, paid_headers={"X-Payment-Receipt": json.dumps(RECEIPT)})

    result = client.call({"model": "test/model", "messages": [{"role": "user", "content": "hi"}]})

    assert result.success is True
    assert result.response["id"] == "chatcmpl-1"
    assert result.receipt is not None
    assert result.receipt.quoteId == "q-1"
    assert result.cost.amount == "1000000"
    assert result.cost.asset == "USDC"
    assert len(horizon.submitted) == 1  # exactly one payment submitted


def test_call_402_flow_hits_custom_path():
    horizon = FakeHorizon()
    client = make_client(horizon, paid_headers={"X-Payment-Receipt": json.dumps(RECEIPT)})

    result = client.call(
        {"model": "test/model", "messages": []}, path="/proxy/chat/completions"
    )

    assert result.success is True
    assert len(horizon.submitted) == 1


def test_call_quote_expired_fails_before_payment():
    horizon = FakeHorizon()
    client = make_client(horizon)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json=payment_required(make_quote(expiresAt=int(time.time()) - 10)))

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    result = client.call({"model": "test/model", "messages": []})

    assert result.success is False
    assert "expired" in result.error
    assert horizon.submitted == []


def test_call_wrong_asset_fails_before_payment():
    horizon = FakeHorizon()
    client = make_client(horizon, default_asset="XLM")

    result = client.call({"model": "test/model", "messages": []})

    assert result.success is False
    assert "Wrong asset" in result.error
    assert "USDC" in result.error
    assert horizon.submitted == []


def test_call_without_secret_key_returns_manual_payment_instructions():
    horizon = FakeHorizon()
    # Empty secret key (not None) so make_client does not auto-generate a keypair.
    client = make_client(horizon, secret_key="", public_key=None, sign_transaction=None)

    result = client.call({"model": "test/model", "messages": []})

    assert result.success is False
    assert "Payment required. Send" in result.error
    assert horizon.submitted == []


def test_call_gateway_5xx_returns_error_result():
    horizon = FakeHorizon()
    client = make_client(horizon)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream down")

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    result = client.call({"model": "test/model", "messages": []})

    assert result.success is False
    assert "503" in result.error


def test_call_external_signer_path():
    horizon = FakeHorizon()
    signed: List[str] = []
    keypair = Keypair.random()

    def sign_transaction(xdr: str) -> str:
        signed.append(xdr)
        return xdr  # mock signer returns as-is; flow just needs a submission

    client = make_client(
        horizon,
        secret_key=None,
        public_key=keypair.public_key,
        sign_transaction=sign_transaction,
        paid_headers={"X-Payment-Receipt": json.dumps(RECEIPT)},
    )

    result = client.call({"model": "test/model", "messages": []})

    assert result.success is True
    assert len(signed) == 1  # external signer was invoked
    assert len(horizon.submitted) == 1


def test_call_external_signer_requires_public_key():
    horizon = FakeHorizon()
    client = make_client(horizon, secret_key=None, public_key=None, sign_transaction=lambda x: x)

    result = client.call({"model": "test/model", "messages": []})

    assert result.success is False
    assert "publicKey is required" in result.error


# ── Streaming calls ───────────────────────────────────────────────────────

SSE_BODY = (
    'data: {"id":"1","object":"chat.completion.chunk","created":1750000000,"model":"test/model",'
    '"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n'
    'data: {"id":"1","object":"chat.completion.chunk","created":1750000000,"model":"test/model",'
    '"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n'
    f'data: {json.dumps({"id": "1", "object": "chat.completion.chunk", "created": 1750000000, "model": "test/model", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}})}\n\n'
    f'data: {json.dumps({"x402_receipt": RECEIPT})}\n\n'
    "data: [DONE]\n\n"
)


def test_call_stream_pays_and_yields_sse_chunks():
    horizon = FakeHorizon()
    client = make_client(horizon)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "horizon.test":
            return horizon.handle(request)
        if request.headers.get("X-Payment-Hash"):
            return httpx.Response(200, text=SSE_BODY)
        return httpx.Response(402, json=payment_required(make_quote()))

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    result = client.call_stream({"model": "test/model", "messages": []})

    assert result.success is True
    chunks = list(result.stream)
    assert len(chunks) == 3  # "Hel", "lo", final usage frame (receipt + [DONE] not yielded)
    assert chunks[0]["choices"][0]["delta"]["content"] == "Hel"
    assert chunks[1]["choices"][0]["delta"]["content"] == "lo"
    # Trailing x402_receipt event surfaced on the result after consumption.
    assert result.receipt is not None
    assert result.receipt.quoteId == "q-1"
    assert result.cost.amount == "1000000"
    assert len(horizon.submitted) == 1


def test_call_stream_no_payment_needed():
    horizon = FakeHorizon()
    client = make_client(horizon)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=SSE_BODY)

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    result = client.call_stream({"model": "test/model", "messages": []})

    assert result.success is True
    chunks = list(result.stream)
    assert len(chunks) == 3
    assert horizon.submitted == []


def test_call_stream_sets_stream_true_on_request():
    horizon = FakeHorizon()
    client = make_client(horizon)
    seen: List[Dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "horizon.test":
            return horizon.handle(request)
        if request.headers.get("X-Payment-Hash"):
            seen.append(json.loads(request.content))
            return httpx.Response(200, text=SSE_BODY)
        return httpx.Response(402, json=payment_required(make_quote()))

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    result = client.call_stream({"model": "test/model", "messages": []})
    list(result.stream)

    assert seen and seen[0]["stream"] is True


# ── Payment status ────────────────────────────────────────────────────────


def test_check_payment_status_returns_receipt():
    client = make_client(FakeHorizon())

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=RECEIPT)

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    receipt = client.check_payment_status("q-1")

    assert receipt is not None
    assert receipt.quoteId == "q-1"
    assert receipt.status == "verified"


def test_check_payment_status_404_returns_none():
    client = make_client(FakeHorizon())

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "not found"})

    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    assert client.check_payment_status("q-missing") is None


# ── Factory ───────────────────────────────────────────────────────────────


def test_create_x402_client_factory():
    keypair = Keypair.random()
    client = create_x402_client(
        X402ClientConfig(gateway_url="https://gateway.test", secret_key=keypair.secret)
    )
    assert isinstance(client, X402Client)
    assert client.config.gateway_url == "https://gateway.test"


def test_default_path_and_url_building():
    keypair = Keypair.random()
    client = X402Client(X402ClientConfig(gateway_url="https://gateway.test/", secret_key=keypair.secret))
    assert client._url("/v1/chat/completions") == "https://gateway.test/v1/chat/completions"
