"""
Tests for x402_sdk client — 402 → pay → retry flow with mocked HTTP.
"""

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from x402_sdk.client import X402Client, create_x402_client
from x402_sdk.types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    CostInfo,
    PaymentReceipt,
    Quote,
    X402CallResult,
    X402ClientConfig,
    X402StreamResult,
)


@pytest.fixture
def config():
    """Create a test config."""
    return X402ClientConfig(
        gatewayUrl='https://gateway.example.com',
        network='testnet',
        secretKey='SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
        paymentTimeout=5000,
    )


@pytest.fixture
def client(config):
    """Create a test client."""
    return X402Client(config)


@pytest.fixture
def chat_request():
    """Create a test chat completion request."""
    return ChatCompletionRequest(
        model='gpt-4o',
        messages=[
            ChatMessage(role='user', content='Hello!'),
        ],
        max_tokens=10,
    )


@pytest.fixture
def sample_quote():
    """Create a sample quote (not expired)."""
    return Quote(
        id='q-test-123',
        route='/v1/chat/completions',
        pricingModel='flat',
        amount='100',
        asset='USDC',
        assetIssuer='GA5ZSEJYB37JRC5AV...',
        paymentAddress='GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
        network='testnet',
        expiresAt=int(time.time()) + 300,  # 5 min from now
        statusUrl='https://gateway.example.com/api/v1/payments/q-test-123/status',
    )


@pytest.fixture
def sample_receipt():
    """Create a sample payment receipt."""
    return PaymentReceipt(
        id='r-test-123',
        quoteId='q-test-123',
        txHash='abc123',
        payerAddress='GABCDEF...',
        amount='100',
        asset='USDC',
        route='/v1/chat/completions',
        status='confirmed',
        verifiedAt='2026-01-01T00:00:00Z',
        ledger=12345,
    )


class TestX402Client:
    """Test the X402Client class."""

    @pytest.mark.asyncio
    async def test_call_success_no_402(self, client, chat_request):
        """Test a successful call without 402 — direct response."""
        # Mock the HTTP response to return 200 OK
        mock_response = AsyncMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.is_success = True
        mock_response.json.return_value = {
            'id': 'chatcmpl-123',
            'object': 'chat.completion',
            'created': 1677652288,
            'model': 'gpt-4o',
            'choices': [
                {
                    'index': 0,
                    'message': {
                        'role': 'assistant',
                        'content': 'Hello! How can I help you?',
                    },
                    'finish_reason': 'stop',
                }
            ],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 7, 'total_tokens': 17},
        }
        mock_response.headers = {}

        client._http.post = AsyncMock(return_value=mock_response)

        result = await client.call(chat_request)

        assert result.success is True
        assert result.response is not None
        assert result.response.choices[0].message.content == 'Hello! How can I help you?'
        assert result.cost is None

    @pytest.mark.asyncio
    async def test_call_402_flow(self, client, chat_request, sample_quote):
        """Test the 402 → pay → retry flow."""
        # First response: 402 Payment Required
        quote_expiry = int(time.time()) + 300
        sample_quote.expiresAt = quote_expiry

        payment_required_data = {
            'status': 402,
            'message': 'Payment Required',
            'quote': {
                'id': sample_quote.id,
                'route': sample_quote.route,
                'pricingModel': sample_quote.pricingModel,
                'amount': sample_quote.amount,
                'asset': sample_quote.asset,
                'assetIssuer': sample_quote.assetIssuer,
                'paymentAddress': sample_quote.paymentAddress,
                'network': sample_quote.network,
                'expiresAt': quote_expiry,
                'statusUrl': sample_quote.statusUrl,
            },
            'instructions': 'Send 100 USDC to GABCDEF...',
            'docs': 'https://gateway.example.com/docs/x402',
        }

        mock_402 = AsyncMock(spec=httpx.Response)
        mock_402.status_code = 402
        mock_402.is_success = False
        mock_402.json.return_value = payment_required_data
        mock_402.headers = {}

        # Second response: 200 OK (after payment)
        mock_200 = AsyncMock(spec=httpx.Response)
        mock_200.status_code = 200
        mock_200.is_success = True
        mock_200.json.return_value = {
            'id': 'chatcmpl-456',
            'object': 'chat.completion',
            'created': 1677652290,
            'model': 'gpt-4o',
            'choices': [
                {
                    'index': 0,
                    'message': {
                        'role': 'assistant',
                        'content': 'Payment received! Here is your response.',
                    },
                    'finish_reason': 'stop',
                }
            ],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 7, 'total_tokens': 17},
        }
        mock_200.headers = {'X-Payment-Receipt': json.dumps({
            'id': 'r-123',
            'quoteId': sample_quote.id,
            'txHash': 'txhash123',
            'payerAddress': 'GABCDEF...',
            'amount': '100',
            'asset': 'USDC',
            'route': '/v1/chat/completions',
            'status': 'confirmed',
            'verifiedAt': '2026-01-01T00:00:00Z',
            'ledger': 12345,
        })}

        # Mock execute_payment to succeed
        client._execute_payment = AsyncMock(return_value={
            'success': True,
            'txHash': 'txhash123',
        })

        # mock _http.post to return 402 first, then 200
        client._http.post = AsyncMock(side_effect=[mock_402, mock_200])

        result = await client.call(chat_request)

        assert result.success is True
        assert result.response is not None
        assert result.response.choices[0].message.content == 'Payment received! Here is your response.'
        assert result.cost is not None
        assert result.cost.amount == '100'
        assert result.cost.asset == 'USDC'
        assert result.receipt is not None
        assert result.receipt.status == 'confirmed'

    @pytest.mark.asyncio
    async def test_call_gateway_error(self, client, chat_request):
        """Test a gateway error response (non-402, non-200)."""
        mock_response = AsyncMock(spec=httpx.Response)
        mock_response.status_code = 500
        mock_response.is_success = False
        mock_response.text = 'Internal Server Error'
        mock_response.headers = {}

        client._http.post = AsyncMock(return_value=mock_response)

        result = await client.call(chat_request)

        assert result.success is False
        assert 'Gateway error: 500' in (result.error or '')

    @pytest.mark.asyncio
    async def test_call_402_expired_quote(self, client, chat_request):
        """Test 402 with an expired quote."""
        # Quote that expired 1 hour ago
        expired_quote = {
            'id': 'q-expired',
            'route': '/v1/chat/completions',
            'pricingModel': 'flat',
            'amount': '100',
            'asset': 'USDC',
            'paymentAddress': 'GABCDEF...',
            'network': 'testnet',
            'expiresAt': int(time.time()) - 3600,  # expired
            'statusUrl': 'https://gateway.example.com/api/v1/payments/q-expired/status',
        }

        mock_402 = AsyncMock(spec=httpx.Response)
        mock_402.status_code = 402
        mock_402.is_success = False
        mock_402.json.return_value = {
            'status': 402,
            'message': 'Payment Required',
            'quote': expired_quote,
        }
        mock_402.headers = {}

        client._http.post = AsyncMock(return_value=mock_402)

        result = await client.call(chat_request)

        assert result.success is False
        assert 'expired' in (result.error or '').lower()

    @pytest.mark.asyncio
    async def test_call_402_wrong_asset(self, client, chat_request):
        """Test 402 with wrong asset type."""
        quote_data = {
            'id': 'q-asset',
            'route': '/v1/chat/completions',
            'pricingModel': 'flat',
            'amount': '100',
            'asset': 'XLM',  # gateway requires XLM
            'paymentAddress': 'GABCDEF...',
            'network': 'testnet',
            'expiresAt': int(time.time()) + 300,
            'statusUrl': 'https://gateway.example.com/api/v1/payments/q-asset/status',
        }

        mock_402 = AsyncMock(spec=httpx.Response)
        mock_402.status_code = 402
        mock_402.is_success = False
        mock_402.json.return_value = {
            'status': 402,
            'message': 'Payment Required',
            'quote': quote_data,
        }
        mock_402.headers = {}

        client._http.post = AsyncMock(return_value=mock_402)

        # Client defaults to USDC
        result = await client.call(chat_request, asset='USDC')

        assert result.success is False
        assert 'Wrong asset' in (result.error or '')

    @pytest.mark.asyncio
    async def test_call_402_payment_fails(self, client, chat_request, sample_quote):
        """Test 402 flow where payment fails."""
        quote_expiry = int(time.time()) + 300
        sample_quote.expiresAt = quote_expiry

        payment_required_data = {
            'status': 402,
            'message': 'Payment Required',
            'quote': {
                'id': sample_quote.id,
                'route': sample_quote.route,
                'pricingModel': sample_quote.pricingModel,
                'amount': sample_quote.amount,
                'asset': sample_quote.asset,
                'assetIssuer': sample_quote.assetIssuer,
                'paymentAddress': sample_quote.paymentAddress,
                'network': sample_quote.network,
                'expiresAt': quote_expiry,
                'statusUrl': sample_quote.statusUrl,
            },
            'instructions': 'Send 100 USDC to GABCDEF...',
            'docs': 'https://gateway.example.com/docs/x402',
        }

        mock_402 = AsyncMock(spec=httpx.Response)
        mock_402.status_code = 402
        mock_402.is_success = False
        mock_402.json.return_value = payment_required_data
        mock_402.headers = {}

        # Mock execute_payment to fail
        client._execute_payment = AsyncMock(return_value={
            'success': False,
            'error': 'Insufficient funds',
        })

        client._http.post = AsyncMock(return_value=mock_402)

        result = await client.call(chat_request)

        assert result.success is False
        assert 'Insufficient funds' in (result.error or '')

    @pytest.mark.asyncio
    async def test_call_no_secret_key(self, config, chat_request):
        """Test 402 flow when no secret key is configured."""
        config.secretKey = None
        client = X402Client(config)

        quote_data = {
            'id': 'q-nokey',
            'route': '/v1/chat/completions',
            'pricingModel': 'flat',
            'amount': '100',
            'asset': 'USDC',
            'paymentAddress': 'GABCDEF...',
            'network': 'testnet',
            'expiresAt': int(time.time()) + 300,
            'statusUrl': 'https://gateway.example.com/api/v1/payments/q-nokey/status',
        }

        mock_402 = AsyncMock(spec=httpx.Response)
        mock_402.status_code = 402
        mock_402.is_success = False
        mock_402.json.return_value = {
            'status': 402,
            'message': 'Payment Required',
            'quote': quote_data,
        }
        mock_402.headers = {}

        client._http.post = AsyncMock(return_value=mock_402)

        result = await client.call(chat_request)

        assert result.success is False
        assert 'Payment required' in (result.error or '')

    @pytest.mark.asyncio
    async def test_call_stream_success(self, client, chat_request):
        """Test a successful streaming call without 402."""
        sse_data = (
            'data: {"id":"chunk1","object":"chat.completion.chunk","created":1677652288,'
            '"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n'
            'data: {"id":"chunk2","object":"chat.completion.chunk","created":1677652289,'
            '"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n'
            'data: [DONE]\n'
        )

        mock_response = AsyncMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.is_success = True
        mock_response.headers = {}

        async def mock_aiter_bytes():
            yield sse_data.encode('utf-8')

        mock_response.aiter_bytes = mock_aiter_bytes

        client._http.post = AsyncMock(return_value=mock_response)

        result = await client.call_stream(chat_request)

        assert result.success is True
        assert result.stream is not None

        chunks = []
        async for chunk in result.stream:
            chunks.append(chunk)

        assert len(chunks) == 2
        assert chunks[0].choices[0].delta.content == 'Hello'
        assert chunks[1].choices[0].delta.content == ' world'

    @pytest.mark.asyncio
    async def test_check_payment_status(self, client):
        """Test check_payment_status."""
        # Mock successful response
        mock_response = AsyncMock(spec=httpx.Response)
        mock_response.is_success = True
        mock_response.json.return_value = {
            'id': 'r-123',
            'quoteId': 'q-123',
            'txHash': 'abc123',
            'payerAddress': 'GABCDEF...',
            'amount': '100',
            'asset': 'USDC',
            'route': '/v1/chat/completions',
            'status': 'confirmed',
            'verifiedAt': '2026-01-01T00:00:00Z',
            'ledger': 12345,
        }

        client._http.get = AsyncMock(return_value=mock_response)

        receipt = await client.check_payment_status('q-123')
        assert receipt is not None
        assert receipt.status == 'confirmed'

    @pytest.mark.asyncio
    async def test_check_payment_status_not_found(self, client):
        """Test check_payment_status when payment is not found."""
        mock_response = AsyncMock(spec=httpx.Response)
        mock_response.is_success = False

        client._http.get = AsyncMock(return_value=mock_response)

        receipt = await client.check_payment_status('q-unknown')
        assert receipt is None

    @pytest.mark.asyncio
    async def test_create_x402_client(self, config):
        """Test create_x402_client factory function."""
        client = create_x402_client(config)
        assert isinstance(client, X402Client)
        assert client.config.gatewayUrl == 'https://gateway.example.com'
        await client.close()

    @pytest.mark.asyncio
    async def test_close(self, client):
        """Test closing the client."""
        # Should not raise
        await client.close()

    @pytest.mark.asyncio
    async def test_http_error_non_402(self, client, chat_request):
        """Test non-402, non-200 HTTP error."""
        mock_response = AsyncMock(spec=httpx.Response)
        mock_response.status_code = 429
        mock_response.is_success = False
        mock_response.text = 'Too Many Requests'
        mock_response.headers = {}

        client._http.post = AsyncMock(return_value=mock_response)

        result = await client.call(chat_request)
        assert result.success is False
        assert 'Gateway error: 429' in (result.error or '')

    @pytest.mark.asyncio
    async def test_call_stream_402_flow(self, client, chat_request, sample_quote):
        """Test streaming call with 402 → pay → retry."""
        quote_expiry = int(time.time()) + 300
        sample_quote.expiresAt = quote_expiry

        payment_required_data = {
            'status': 402,
            'message': 'Payment Required',
            'quote': {
                'id': sample_quote.id,
                'route': sample_quote.route,
                'pricingModel': sample_quote.pricingModel,
                'amount': sample_quote.amount,
                'asset': sample_quote.asset,
                'assetIssuer': sample_quote.assetIssuer,
                'paymentAddress': sample_quote.paymentAddress,
                'network': sample_quote.network,
                'expiresAt': quote_expiry,
                'statusUrl': sample_quote.statusUrl,
            },
            'instructions': 'Send 100 USDC...',
            'docs': 'https://gateway.example.com/docs/x402',
        }

        mock_402 = AsyncMock(spec=httpx.Response)
        mock_402.status_code = 402
        mock_402.is_success = False
        mock_402.json.return_value = payment_required_data
        mock_402.headers = {}

        sse_data = (
            'data: {"id":"chunk1","object":"chat.completion.chunk","created":1677652288,'
            '"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Streaming"},"finish_reason":null}]}\n'
            'data: [DONE]\n'
        )

        mock_200 = AsyncMock(spec=httpx.Response)
        mock_200.status_code = 200
        mock_200.is_success = True
        mock_200.headers = {'X-Payment-Receipt': json.dumps({
            'id': 'r-123',
            'quoteId': sample_quote.id,
            'txHash': 'txhash123',
            'payerAddress': 'GABCDEF...',
            'amount': '100',
            'asset': 'USDC',
            'route': '/v1/chat/completions',
            'status': 'confirmed',
            'verifiedAt': '2026-01-01T00:00:00Z',
            'ledger': 12345,
        })}

        async def mock_aiter_bytes():
            yield sse_data.encode('utf-8')

        mock_200.aiter_bytes = mock_aiter_bytes

        client._execute_payment = AsyncMock(return_value={
            'success': True,
            'txHash': 'txhash123',
        })

        client._http.post = AsyncMock(side_effect=[mock_402, mock_200])

        result = await client.call_stream(chat_request)

        assert result.success is True
        assert result.stream is not None
        assert result.receipt is not None
        assert result.cost is not None

        chunks = [c async for c in result.stream]
        assert len(chunks) == 1
        assert chunks[0].choices[0].delta.content == 'Streaming'