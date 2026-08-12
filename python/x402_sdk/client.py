"""X402Client — automatic 402 → pay → retry for x402 LLM gateways.

Python port of the TypeScript ``@x402/sdk`` (``packages/sdk/src/index.ts``).
The client sends the request, and when the gateway answers ``402 Payment
Required`` it automatically parses the quote, builds/signs/submits the
Stellar payment, waits for on-chain confirmation, and retries the original
request with the ``X-Payment-Hash`` header — transparently, for both
non-streaming and SSE streaming calls.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Iterator, Optional

import httpx

from .stellar import pay_quote
from .types import (
    Cost,
    PaymentReceipt,
    PaymentRequiredResponse,
    X402CallResult,
    X402ClientConfig,
    X402StreamResult,
)

DEFAULT_PATH = "/v1/chat/completions"
PAYMENT_STATUS_PATH = "/api/v1/payments/{quote_id}/status"


class X402Client:
    """Client for the x402 gateway.

    :param config: client configuration (see :class:`X402ClientConfig`).
    """

    def __init__(self, config: X402ClientConfig):
        self.config = config
        self._http = config.http_client or httpx.Client(timeout=30.0)

    # ── Public API ────────────────────────────────────────────────────────

    def call(
        self,
        request: Dict[str, Any],
        *,
        path: str = DEFAULT_PATH,
        asset: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> X402CallResult:
        """Make a non-streaming LLM API call through the x402 gateway.

        Handles ``402 Payment Required`` responses by paying and retrying.
        """
        url = self._url(path)
        response = self._http.post(
            url,
            json=request,
            headers={"Content-Type": "application/json", **(headers or {})},
        )

        if response.status_code == 402:
            payment_required = PaymentRequiredResponse.from_dict(response.json())
            return self._handle_402_payment(
                payment_required, request, path, asset, headers, stream=False
            )

        if response.is_success:
            receipt = _parse_receipt_header(response.headers.get("X-Payment-Receipt"))
            return X402CallResult(
                success=True,
                response=response.json(),
                receipt=receipt,
                cost=Cost(amount=receipt.amount, asset=receipt.asset)
                if receipt
                else Cost(amount="0", asset="USDC"),
            )

        return X402CallResult(success=False, error=f"Gateway error: {response.status_code} {response.text}")

    def call_stream(
        self,
        request: Dict[str, Any],
        *,
        path: str = DEFAULT_PATH,
        asset: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> X402StreamResult:
        """Make a streaming LLM API call through the x402 gateway.

        Returns an :class:`X402StreamResult` whose ``stream`` is a generator
        of OpenAI-compatible chat completion chunk dicts (SSE ``data:``
        frames). Handles ``402 Payment Required`` transparently.
        """
        streaming_request = {**request, "stream": True}
        url = self._url(path)
        response = self._http.post(
            url,
            json=streaming_request,
            headers={"Content-Type": "application/json", **(headers or {})},
        )

        if response.status_code == 402:
            payment_required = PaymentRequiredResponse.from_dict(response.json())
            return self._handle_402_payment(
                payment_required, streaming_request, path, asset, headers, stream=True
            )

        if response.is_success:
            result = X402StreamResult(success=True)
            result.receipt = _parse_receipt_header(response.headers.get("X-Payment-Receipt"))
            result.stream = self._sse_generator(response, result)
            return result

        return X402StreamResult(success=False, error=f"Gateway error: {response.status_code} {response.text}")

    def check_payment_status(self, quote_id: str) -> Optional[PaymentReceipt]:
        """Check the payment status for a quote.

        Returns the receipt if the gateway reports one, else ``None``.
        """
        try:
            url = self._url(PAYMENT_STATUS_PATH.format(quote_id=quote_id))
            response = self._http.get(url)
            if response.is_success:
                return PaymentReceipt.from_dict(response.json())
        except httpx.HTTPError:
            return None
        return None

    # ── Shared 402 → pay → retry logic ────────────────────────────────────

    def _handle_402_payment(
        self,
        payment_required: PaymentRequiredResponse,
        request: Dict[str, Any],
        path: str,
        asset: Optional[str],
        headers: Optional[Dict[str, str]],
        stream: bool,
    ) -> X402CallResult | X402StreamResult:
        quote = payment_required.quote

        # Validate the quote before paying anything.
        if time.time() > quote.expiresAt:
            return self._failure("Quote expired before payment could be made", stream)

        required_asset = asset or self.config.default_asset or "USDC"
        if required_asset != quote.asset:
            return self._failure(
                f"Wrong asset: gateway requires {quote.asset}, you're paying with {required_asset}",
                stream,
            )

        # Execute the payment (build → sign → submit → confirm).
        ok, value = pay_quote(quote, self.config, http_client=self._http)
        if not ok:
            return self._failure(value, stream)
        tx_hash = value

        # Retry the request with payment proof.
        url = self._url(path)
        response = self._http.post(
            url,
            json=request,
            headers={
                "Content-Type": "application/json",
                "X-Payment-Hash": tx_hash,
                **(headers or {}),
            },
        )

        if not response.is_success:
            return self._failure(
                f"Gateway error after payment: {response.status_code} {response.text}", stream
            )

        if stream:
            result = X402StreamResult(success=True)
            result.receipt = _parse_receipt_header(response.headers.get("X-Payment-Receipt"))
            result.stream = self._sse_generator(response, result)
            return result

        llm_response = response.json()
        receipt = _parse_receipt_header(response.headers.get("X-Payment-Receipt"))
        return X402CallResult(
            success=True,
            response=llm_response,
            receipt=receipt,
            cost=Cost(amount=receipt.amount, asset=receipt.asset) if receipt else None,
        )

    # ── Helpers ───────────────────────────────────────────────────────────

    def _url(self, path: str) -> str:
        return f"{self.config.gateway_url.rstrip('/')}{path}"

    def _failure(self, error: str, stream: bool) -> X402CallResult | X402StreamResult:
        if stream:
            return X402StreamResult(success=False, error=error)
        return X402CallResult(success=False, error=error)

    @staticmethod
    def _sse_generator(response: httpx.Response, result: X402StreamResult) -> Iterator[Dict[str, Any]]:
        """Parse SSE frames from an httpx response into chunk dicts.

        Yields one dict per ``data:`` frame. ``[DONE]`` terminates the
        stream. A trailing ``x402_receipt`` event is stored on ``result``
        rather than yielded, mirroring the TypeScript SDK.
        """
        for raw_line in response.iter_lines():
            if not raw_line:
                continue
            line = raw_line.strip()
            if not line.startswith("data: "):
                continue
            data = line[len("data: "):]
            if data == "[DONE]":
                return
            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and parsed.get("x402_receipt"):
                result.receipt = PaymentReceipt.from_dict(parsed["x402_receipt"])
                continue
            yield parsed


def create_x402_client(config: X402ClientConfig) -> X402Client:
    """Create a new x402 client instance (mirrors ``createX402Client``)."""
    return X402Client(config)


def _parse_receipt_header(header: Optional[str]) -> Optional[PaymentReceipt]:
    if not header:
        return None
    try:
        return PaymentReceipt.from_dict(json.loads(header))
    except (json.JSONDecodeError, TypeError):
        return None
