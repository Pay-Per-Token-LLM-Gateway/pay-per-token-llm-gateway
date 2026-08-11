"""
x402 SDK — Client SDK for the 402 → pay → retry flow.

Mirrors the TypeScript @x402/sdk implementation.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Optional

import httpx

from .types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionStreamChunk,
    CostInfo,
    PaymentAsset,
    PaymentReceipt,
    PaymentRequiredResponse,
    Quote,
    StellarNetwork,
    X402CallResult,
    X402ClientConfig,
    X402StreamResult,
)

logger = logging.getLogger(__name__)


class X402Client:
    """
    x402 Client — automatically handles 402 → pay → retry.

    Make LLM API calls through the x402 gateway. When the gateway responds
    with HTTP 402 Payment Required, the client automatically pays using the
    configured Stellar secret key and retries the request.
    """

    def __init__(self, config: X402ClientConfig) -> None:
        self.config = config
        self._http = httpx.AsyncClient(timeout=60.0)

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._http.aclose()

    # ── Public API ──────────────────────────────

    async def call(
        self,
        request: ChatCompletionRequest,
        *,
        path: Optional[str] = None,
        asset: Optional[PaymentAsset] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> X402CallResult:
        """
        Make an LLM API call through the x402 gateway.

        Automatically handles 402 responses by paying and retrying.
        """
        route = path or '/v1/chat/completions'
        url = f'{self.config.gatewayUrl}{route}'
        body = request.to_dict()

        logger.info('Making x402 call', extra={'url': url, 'model': request.model})

        first_response = await self._http.post(
            url,
            json=body,
            headers={'Content-Type': 'application/json', **(headers or {})},
        )

        # 402 → handle payment + retry
        if first_response.status_code == 402:
            payment_required = self._parse_payment_required(first_response)
            if payment_required.quote:
                await first_response.aclose()
                return await self._handle_402_payment(
                    payment_required, request, route, options={
                        'headers': headers,
                        'asset': asset,
                    }, is_stream=False,
                )
            return X402CallResult(
                success=False,
                error='Gateway returned 402 without a quote',
            )

        if first_response.is_success:
            data = first_response.json()
            receipt = self._parse_receipt_header(
                first_response.headers.get('X-Payment-Receipt')
            )
            return X402CallResult(
                success=True,
                response=ChatCompletionResponse.from_dict(data),
                receipt=receipt,
                cost=CostInfo(amount=receipt.amount, asset=receipt.asset) if receipt else None,
            )

        error_body = first_response.text
        return X402CallResult(
            success=False,
            error=f'Gateway error: {first_response.status_code} {error_body}',
        )

    async def call_stream(
        self,
        request: ChatCompletionRequest,
        *,
        path: Optional[str] = None,
        asset: Optional[PaymentAsset] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> X402StreamResult:
        """
        Make a streaming LLM API call through the x402 gateway.

        Returns an async generator of SSE chunks.
        """
        route = path or '/v1/chat/completions'
        request.stream = True
        url = f'{self.config.gatewayUrl}{route}'
        body = request.to_dict()

        first_response = await self._http.post(
            url,
            json=body,
            headers={'Content-Type': 'application/json', **(headers or {})},
        )

        if first_response.status_code == 402:
            payment_required = self._parse_payment_required(first_response)
            if payment_required.quote:
                await first_response.aclose()
                result = await self._handle_402_payment(
                    payment_required, request, route, options={
                        'headers': headers,
                        'asset': asset,
                    }, is_stream=True,
                )
                if isinstance(result, X402StreamResult):
                    return result
                return X402StreamResult(
                    success=False,
                    error=result.error or 'Payment failed',
                )
            return X402StreamResult(
                success=False,
                error='Gateway returned 402 without a quote',
            )

        if first_response.is_success:
            receipt = self._parse_receipt_header(
                first_response.headers.get('X-Payment-Receipt')
            )
            return X402StreamResult(
                success=True,
                stream=self._sse_generator(first_response),
                receipt=receipt,
                cost=CostInfo(amount=receipt.amount, asset=receipt.asset) if receipt else None,
            )

        error_body = first_response.text
        return X402StreamResult(
            success=False,
            error=f'Gateway error: {first_response.status_code} {error_body}',
        )

    async def check_payment_status(self, quote_id: str) -> Optional[PaymentReceipt]:
        """Check the payment status for a quote."""
        try:
            response = await self._http.get(
                f'{self.config.gatewayUrl}/api/v1/payments/{quote_id}/status'
            )
            if response.is_success:
                data = response.json()
                return PaymentReceipt(**data)
            return None
        except Exception:
            return None

    # ── Shared Payment Logic ────────────────────

    async def _handle_402_payment(
        self,
        payment_required: PaymentRequiredResponse,
        request: ChatCompletionRequest,
        route: str,
        options: Optional[dict[str, Any]],
        is_stream: bool,
    ) -> X402CallResult | X402StreamResult:
        """Shared 402 → pay → retry flow used by both call() and call_stream()."""
        quote = payment_required.quote
        if not quote:
            return X402CallResult(success=False, error='No quote in 402 response')

        # Validate quote expiration
        now = datetime.now(timezone.utc).timestamp()
        if now > quote.expiresAt:
            return X402CallResult(success=False, error='Quote expired before payment could be made')

        required_asset = (options or {}).get('asset') or self.config.defaultAsset or 'USDC'
        if required_asset != quote.asset:
            return X402CallResult(
                success=False,
                error=f'Wrong asset: gateway requires {quote.asset}, '
                      f"you're paying with {required_asset}",
            )

        # Execute payment
        tx_result = await self._execute_payment(quote)
        if not tx_result.get('success'):
            return X402CallResult(success=False, error=tx_result.get('error', 'Payment failed'))

        # Retry the request with payment proof
        tx_hash = tx_result['txHash']
        url = f'{self.config.gatewayUrl}{route}'
        merged_headers = {
            'Content-Type': 'application/json',
            'X-Payment-Hash': tx_hash,
            **((options or {}).get('headers') or {}),
        }

        response = await self._http.post(url, json=request.to_dict(), headers=merged_headers)

        if not response.is_success:
            error_body = response.text
            return X402CallResult(
                success=False,
                error=f'Gateway error after payment: {response.status_code} {error_body}',
            )

        if is_stream:
            receipt = self._parse_receipt_header(
                response.headers.get('X-Payment-Receipt')
            )
            return X402StreamResult(
                success=True,
                stream=self._sse_generator(response),
                receipt=receipt,
                cost=CostInfo(amount=receipt.amount, asset=receipt.asset) if receipt else None,
            )

        data = response.json()
        llm_response = ChatCompletionResponse.from_dict(data)
        receipt = self._parse_receipt_header(
            response.headers.get('X-Payment-Receipt')
        )
        cost = CostInfo(amount=receipt.amount, asset=receipt.asset) if receipt else None

        return X402CallResult(
            success=True,
            response=llm_response,
            receipt=receipt,
            cost=cost,
        )

    async def _execute_payment(self, quote: Quote) -> dict[str, Any]:
        """
        Build, submit, and confirm a Stellar payment for the given quote.

        Returns {'success': True, 'txHash': '...'} on success,
        or {'success': False, 'error': '...'} on failure.
        """
        if not self.config.secretKey:
            return {
                'success': False,
                'error': f'Payment required. Send {quote.amount} {quote.asset} '
                         f'to {quote.paymentAddress}.',
            }

        try:
            from .wallet import BuildPaymentOptions, build_payment_transaction, create_horizon_server

            horizon_url = self._get_horizon_url(quote.network)
            result = build_payment_transaction(
                BuildPaymentOptions(
                    sourceSecret=self.config.secretKey,
                    destination=quote.paymentAddress,
                    amount=quote.amount,
                    asset=quote.asset,
                    assetIssuer=quote.assetIssuer,
                    memo=quote.memo,
                    network=quote.network,
                    horizonUrl=horizon_url,
                )
            )

            # Submit to Horizon
            server = create_horizon_server(quote.network)
            server.submit_transaction(result.txXdr)

            logger.info('Payment submitted', extra={
                'txHash': result.txHash,
                'amount': quote.amount,
                'asset': quote.asset,
            })

            confirmed = await self._wait_for_confirmation(result.txHash, quote)
            if not confirmed:
                return {'success': False, 'error': 'Payment not confirmed within timeout'}

            return {'success': True, 'txHash': result.txHash}

        except Exception as e:
            return {'success': False, 'error': f'Payment failed: {e}'}

    # ── Helpers ─────────────────────────────────

    async def _wait_for_confirmation(self, tx_hash: str, quote: Quote) -> bool:
        """Poll Horizon until the transaction is confirmed."""
        deadline = datetime.now(timezone.utc).timestamp() * 1000 + (
            self.config.paymentTimeout or 300_000
        )
        horizon_url = self._get_horizon_url(quote.network)

        while (datetime.now(timezone.utc).timestamp() * 1000) < deadline:
            try:
                response = await self._http.get(f'{horizon_url}/transactions/{tx_hash}')
                if response.is_success:
                    tx_data = response.json()
                    if tx_data.get('successful'):
                        return True
            except Exception:
                pass
            await asyncio.sleep(2)

        return False

    def _get_horizon_url(self, network: StellarNetwork) -> str:
        """Return the appropriate Horizon URL for the network."""
        urls = {
            'mainnet': 'https://horizon.stellar.org',
            'futurenet': 'https://horizon-futurenet.stellar.org',
            'testnet': 'https://horizon-testnet.stellar.org',
        }
        return urls.get(network, 'https://horizon-testnet.stellar.org')

    # ── SSE Parsing ─────────────────────────────

    async def _sse_generator(
        self,
        response: httpx.Response,
    ) -> AsyncGenerator[ChatCompletionStreamChunk, None]:
        """Parse SSE chunks from an httpx Response into an async generator."""
        buffer = ''
        async for chunk in response.aiter_bytes():
            buffer += chunk.decode('utf-8', errors='replace')
            lines = buffer.split('\n')
            buffer = lines.pop() if lines else ''

            for line in lines:
                trimmed = line.strip()
                if not trimmed or not trimmed.startswith('data: '):
                    continue

                data = trimmed[6:]  # strip 'data: '
                if data == '[DONE]':
                    return

                try:
                    chunk_data = json.loads(data)
                    yield ChatCompletionStreamChunk.from_dict(chunk_data)
                except json.JSONDecodeError:
                    continue

    def _parse_payment_required(self, response: httpx.Response) -> PaymentRequiredResponse:
        """Parse a 402 response body into a PaymentRequiredResponse."""
        try:
            data = response.json()
            quote_data = data.get('quote')
            if quote_data:
                quote = Quote(**quote_data)
            else:
                quote = None
            return PaymentRequiredResponse(
                status=response.status_code,
                message=data.get('message', 'Payment Required'),
                quote=quote,
                instructions=data.get('instructions'),
                docs=data.get('docs'),
            )
        except Exception:
            return PaymentRequiredResponse(
                status=402,
                message='Payment Required',
                instructions='Failed to parse 402 response',
            )

    def _parse_receipt_header(self, header: Optional[str]) -> Optional[PaymentReceipt]:
        """Parse the X-Payment-Receipt header into a PaymentReceipt."""
        if not header:
            return None
        try:
            data = json.loads(header)
            return PaymentReceipt(**data)
        except (json.JSONDecodeError, TypeError):
            return None


def create_x402_client(config: X402ClientConfig) -> X402Client:
    """Create a new x402 client instance."""
    return X402Client(config)