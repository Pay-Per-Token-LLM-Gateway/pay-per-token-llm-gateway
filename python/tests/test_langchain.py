"""Tests for the LangChain integration (requires the langchain extra)."""

from __future__ import annotations

import json

import httpx
import pytest

pytest.importorskip("langchain_core")

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage  # noqa: E402

from x402_sdk.langchain import X402ChatModel, _to_openai_message  # noqa: E402
from x402_sdk.types import PaymentReceipt  # noqa: E402

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
CHAT_RESPONSE = {
    "id": "chatcmpl-9",
    "object": "chat.completion",
    "created": 1750000000,
    "model": "test/model",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "LangChain says hi"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7},
}
SSE_BODY = (
    'data: {"id":"1","object":"chat.completion.chunk","created":1750000000,"model":"test/model",'
    '"choices":[{"index":0,"delta":{"role":"assistant","content":"Stream"},"finish_reason":null}]}\n\n'
    'data: {"id":"1","object":"chat.completion.chunk","created":1750000000,"model":"test/model",'
    '"choices":[{"index":0,"delta":{"content":"ing"},"finish_reason":null}]}\n\n'
    'data: {"id":"1","object":"chat.completion.chunk","created":1750000000,"model":"test/model",'
    '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n'
    "data: [DONE]\n\n"
)


def make_model(handler) -> X402ChatModel:
    model = X402ChatModel(
        gateway_url="https://gateway.test",
        model_name="test/model",
        network="testnet",
        temperature=0.5,
        max_tokens=64,
    )
    model.x402_client._http = httpx.Client(transport=httpx.MockTransport(handler))
    return model


def _ok_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json=CHAT_RESPONSE,
        headers={"X-Payment-Receipt": json.dumps(RECEIPT)},
    )


def test_message_conversion():
    assert _to_openai_message(HumanMessage(content="hi")) == {"role": "user", "content": "hi"}
    assert _to_openai_message(SystemMessage(content="sys")) == {"role": "system", "content": "sys"}
    ai = _to_openai_message(AIMessage(content="yo", additional_kwargs={"x": 1}))
    assert ai == {"role": "assistant", "content": "yo"}


def test_build_request_shape():
    model = make_model(_ok_handler)
    request = model._build_request(
        [SystemMessage(content="be brief"), HumanMessage(content="hi")], stop=["\n"]
    )
    assert request["model"] == "test/model"
    assert request["messages"] == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hi"},
    ]
    assert request["temperature"] == 0.5
    assert request["max_tokens"] == 64
    assert request["stop"] == ["\n"]


def test_invoke_returns_ai_message_with_metadata():
    model = make_model(_ok_handler)
    result = model.invoke([HumanMessage(content="hello")])

    assert isinstance(result, AIMessage)
    assert result.content == "LangChain says hi"
    assert result.response_metadata["model"] == "test/model"
    assert result.response_metadata["finish_reason"] == "stop"
    assert result.response_metadata["usage"]["total_tokens"] == 7
    assert result.response_metadata["receipt"].quoteId == "q-1"


def test_invoke_402_flow_transparent():
    """The 402 → pay → retry must be invisible to the LangChain caller."""
    calls = []
    stellar_sdk = pytest.importorskip("stellar_sdk")
    issuer = stellar_sdk.Keypair.random().public_key
    destination = stellar_sdk.Keypair.random().public_key

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.headers.get("X-Payment-Hash"))
        if not request.headers.get("X-Payment-Hash"):
            return httpx.Response(402, json={
                "status": 402,
                "message": "Payment required",
                "quote": {
                    "id": "q-1",
                    "route": "test/model",
                    "pricingModel": "flat",
                    "amount": "1000000",
                    "asset": "USDC",
                    "assetIssuer": issuer,
                    "paymentAddress": destination,
                    "memo": "abc123",
                    "expiresAt": 9999999999,
                    "network": "testnet",
                    "statusUrl": "https://gateway.test/api/v1/payments/q-1/status",
                },
                "instructions": "pay",
                "docs": "docs",
            })
        return httpx.Response(
            200,
            json=CHAT_RESPONSE,
            headers={"X-Payment-Receipt": json.dumps(RECEIPT)},
        )

    keypair = stellar_sdk.Keypair.random()
    model = X402ChatModel(
        gateway_url="https://gateway.test",
        model_name="test/model",
        network="testnet",
        secret_key=keypair.secret,
        horizon_url="https://horizon.test",
    )
    transport = httpx.MockTransport(_horizon_and_gateway_handler(handler))
    model.x402_client._http = httpx.Client(transport=transport)

    result = model.invoke([HumanMessage(content="hello")])
    assert result.content == "LangChain says hi"
    assert calls[0] is None and calls[1]  # first call unpaid, retry carries the hash


def _horizon_and_gateway_handler(gateway_handler):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "horizon.test":
            path = request.url.path
            if request.method == "GET" and path.startswith("/accounts/"):
                return httpx.Response(200, json={"sequence": "300"})
            if request.method == "POST" and path == "/transactions":
                return httpx.Response(200, json={"hash": "f" * 64})
            if request.method == "GET" and path.startswith("/transactions/"):
                return httpx.Response(200, json={"successful": True})
            return httpx.Response(404)
        return gateway_handler(request)

    return handler


def test_stream_accumulates_chunks():
    model = make_model(lambda request: httpx.Response(200, text=SSE_BODY))
    chunks = [c for c in model.stream([HumanMessage(content="hi")])]

    # langchain-core >= 1.x appends a synthetic final chunk (chunk_position="last")
    # and yields AIMessageChunk directly, so assert on content/usage rather than
    # an exact chunk count or wrapper type.
    contents = [c.content for c in chunks if c.content]
    assert contents == ["Stream", "ing"]
    assert any(
        c.response_metadata.get("usage", {}).get("total_tokens") == 6 for c in chunks
    )


def test_stream_402_flow_transparent():
    calls = []
    stellar_sdk = pytest.importorskip("stellar_sdk")
    issuer = stellar_sdk.Keypair.random().public_key
    destination = stellar_sdk.Keypair.random().public_key
    keypair = stellar_sdk.Keypair.random()

    def gateway_handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.headers.get("X-Payment-Hash"))
        if not request.headers.get("X-Payment-Hash"):
            return httpx.Response(402, json={
                "status": 402,
                "message": "Payment required",
                "quote": {
                    "id": "q-1",
                    "route": "test/model",
                    "pricingModel": "flat",
                    "amount": "1000000",
                    "asset": "USDC",
                    "assetIssuer": issuer,
                    "paymentAddress": destination,
                    "memo": "abc123",
                    "expiresAt": 9999999999,
                    "network": "testnet",
                    "statusUrl": "https://gateway.test/api/v1/payments/q-1/status",
                },
                "instructions": "pay",
                "docs": "docs",
            })
        return httpx.Response(200, text=SSE_BODY)

    model = X402ChatModel(
        gateway_url="https://gateway.test",
        model_name="test/model",
        network="testnet",
        secret_key=keypair.secret,
        horizon_url="https://horizon.test",
    )
    model.x402_client._http = httpx.Client(
        transport=httpx.MockTransport(_horizon_and_gateway_handler(gateway_handler))
    )

    chunks = [c for c in model.stream([HumanMessage(content="hi")])]
    assert calls[0] is None and calls[1]
    contents = [c.content for c in chunks if c.content]
    assert contents == ["Stream", "ing"]
