from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from typing import Any

import requests

from .models import PaymentQuote, PaymentReceipt, X402CallResult, X402Error

PaymentHandler = Callable[[PaymentQuote], str]


class X402Client:
    """Client for the x402 402 -> pay -> retry flow."""

    def __init__(
        self,
        gateway_url: str,
        payment_handler: PaymentHandler | None = None,
        default_path: str = "/v1/chat/completions",
        timeout: float = 60.0,
        session: requests.Session | None = None,
    ) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.payment_handler = payment_handler
        self.default_path = default_path
        self.timeout = timeout
        self.session = session or requests.Session()

    def call(
        self,
        request: dict[str, Any],
        *,
        path: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> X402CallResult:
        route = path or self.default_path
        response = self._post_json(route, request, headers=headers)

        if response.status_code == 402:
            quote = self._parse_payment_required(response)
            tx_hash = self._pay(quote)
            paid_response = self._post_json(
                route,
                request,
                headers={**(headers or {}), "X-Payment-Hash": tx_hash},
            )
            return self._parse_success(paid_response)

        return self._parse_success(response)

    def stream(
        self,
        request: dict[str, Any],
        *,
        path: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> Iterator[dict[str, Any]]:
        route = path or self.default_path
        payload = {**request, "stream": True}
        response = self._post_json(route, payload, headers=headers, stream=True)

        if response.status_code == 402:
            quote = self._parse_payment_required(response)
            tx_hash = self._pay(quote)
            response = self._post_json(
                route,
                payload,
                headers={**(headers or {}), "X-Payment-Hash": tx_hash},
                stream=True,
            )

        self._raise_for_gateway_error(response)
        yield from self._iter_sse_json(response)

    def check_payment_status(self, quote_id: str) -> PaymentReceipt | None:
        response = self.session.get(
            f"{self.gateway_url}/api/v1/payments/{quote_id}/status",
            timeout=self.timeout,
        )
        if not response.ok:
            return None
        return PaymentReceipt.from_dict(response.json())

    def _post_json(
        self,
        route: str,
        payload: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
        stream: bool = False,
    ) -> requests.Response:
        return self.session.post(
            f"{self.gateway_url}{route}",
            json=payload,
            headers={"Content-Type": "application/json", **(headers or {})},
            timeout=self.timeout,
            stream=stream,
        )

    def _parse_payment_required(self, response: requests.Response) -> PaymentQuote:
        try:
            body = response.json()
        finally:
            response.close()
        if "quote" not in body:
            raise X402Error("402 response did not contain a quote")
        quote = PaymentQuote.from_dict(body["quote"])
        if quote.expires_at and time.time() > quote.expires_at:
            raise X402Error("payment quote expired before it could be paid")
        return quote

    def _pay(self, quote: PaymentQuote) -> str:
        if self.payment_handler is None:
            raise X402Error(
                f"payment required: send {quote.amount} {quote.asset} to "
                f"{quote.payment_address}"
            )
        tx_hash = self.payment_handler(quote)
        if not tx_hash:
            raise X402Error("payment handler returned an empty transaction hash")
        return tx_hash

    def _parse_success(self, response: requests.Response) -> X402CallResult:
        self._raise_for_gateway_error(response)
        receipt_header = response.headers.get("X-Payment-Receipt")
        receipt = None
        if receipt_header:
            receipt = PaymentReceipt.from_dict(json.loads(receipt_header))
        return X402CallResult(response=response.json(), receipt=receipt)

    def _raise_for_gateway_error(self, response: requests.Response) -> None:
        if response.ok:
            return
        raise X402Error(f"gateway error: {response.status_code} {response.text}")

    def _iter_sse_json(self, response: requests.Response) -> Iterator[dict[str, Any]]:
        for line in response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            payload = line.removeprefix("data:").strip()
            if payload == "[DONE]":
                break
            yield json.loads(payload)

