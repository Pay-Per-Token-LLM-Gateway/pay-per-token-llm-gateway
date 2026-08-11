"""
Tests for x402_sdk types.
"""

import pytest
from x402_sdk.types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionStreamChunk,
    ChatMessage,
    Choice,
    ChoiceDelta,
    CostInfo,
    PaymentReceipt,
    Quote,
    StreamChoice,
    Usage,
    X402CallResult,
    X402ClientConfig,
    X402StreamResult,
)


class TestTypes:
    """Test type definitions and serialization."""

    def test_chat_completion_request_to_dict(self):
        """Test ChatCompletionRequest.to_dict() serialization."""
        req = ChatCompletionRequest(
            model='gpt-4o',
            messages=[
                ChatMessage(role='system', content='You are a helpful assistant.'),
                ChatMessage(role='user', content='Hello!'),
            ],
            temperature=0.7,
            max_tokens=100,
        )
        d = req.to_dict()
        assert d['model'] == 'gpt-4o'
        assert len(d['messages']) == 2
        assert d['messages'][0]['role'] == 'system'
        assert d['messages'][0]['content'] == 'You are a helpful assistant.'
        assert d['messages'][1]['role'] == 'user'
        assert d['messages'][1]['content'] == 'Hello!'
        assert d['temperature'] == 0.7
        assert d['max_tokens'] == 100

    def test_chat_completion_request_to_dict_omits_none(self):
        """Test that None values are omitted from dict."""
        req = ChatCompletionRequest(
            model='gpt-4o',
            messages=[ChatMessage(role='user', content='Hi')],
        )
        d = req.to_dict()
        assert 'temperature' not in d
        assert 'max_tokens' not in d
        assert 'stream' not in d

    def test_chat_completion_response_from_dict(self):
        """Test ChatCompletionResponse.from_dict() deserialization."""
        data = {
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
            'usage': {
                'prompt_tokens': 10,
                'completion_tokens': 7,
                'total_tokens': 17,
            },
        }
        response = ChatCompletionResponse.from_dict(data)
        assert response.id == 'chatcmpl-123'
        assert response.model == 'gpt-4o'
        assert len(response.choices) == 1
        assert response.choices[0].message.content == 'Hello! How can I help you?'
        assert response.usage is not None
        assert response.usage.total_tokens == 17

    def test_chat_completion_stream_chunk_from_dict(self):
        """Test ChatCompletionStreamChunk.from_dict() deserialization."""
        data = {
            'id': 'chatcmpl-123',
            'object': 'chat.completion.chunk',
            'created': 1677652288,
            'model': 'gpt-4o',
            'choices': [
                {
                    'index': 0,
                    'delta': {'content': 'Hello'},
                    'finish_reason': None,
                }
            ],
        }
        chunk = ChatCompletionStreamChunk.from_dict(data)
        assert chunk.id == 'chatcmpl-123'
        assert len(chunk.choices) == 1
        assert chunk.choices[0].delta.content == 'Hello'
        assert chunk.choices[0].finish_reason is None

    def test_quote_dataclass(self):
        """Test Quote dataclass creation."""
        quote = Quote(
            id='q-123',
            route='/v1/chat/completions',
            pricingModel='flat',
            amount='100',
            asset='USDC',
            paymentAddress='GABCD...',
            network='testnet',
            expiresAt=1700000000,
            statusUrl='https://gateway.example.com/api/v1/payments/q-123/status',
        )
        assert quote.id == 'q-123'
        assert quote.amount == '100'
        assert quote.asset == 'USDC'
        assert quote.pricingModel == 'flat'

    def test_payment_receipt_dataclass(self):
        """Test PaymentReceipt dataclass."""
        receipt = PaymentReceipt(
            id='r-123',
            quoteId='q-123',
            txHash='abc123',
            payerAddress='GABCD...',
            amount='100',
            asset='USDC',
            route='/v1/chat/completions',
            status='confirmed',
            verifiedAt='2026-01-01T00:00:00Z',
            ledger=12345,
        )
        assert receipt.id == 'r-123'
        assert receipt.status == 'confirmed'

    def test_x402_client_config(self):
        """Test X402ClientConfig creation."""
        config = X402ClientConfig(
            gatewayUrl='https://gateway.example.com',
            network='testnet',
            secretKey='SABCD...',
        )
        assert config.gatewayUrl == 'https://gateway.example.com'
        assert config.network == 'testnet'
        assert config.secretKey == 'SABCD...'
        assert config.defaultAsset == 'USDC'
        assert config.paymentTimeout == 300_000

    def test_cost_info(self):
        """Test CostInfo dataclass."""
        cost = CostInfo(amount='500', asset='USDC')
        assert cost.amount == '500'
        assert cost.asset == 'USDC'

    def test_x402_call_result(self):
        """Test X402CallResult dataclass."""
        result = X402CallResult(success=True, error=None)
        assert result.success is True
        assert result.error is None

        error_result = X402CallResult(success=False, error='Something went wrong')
        assert error_result.success is False
        assert error_result.error == 'Something went wrong'

    def test_x402_stream_result(self):
        """Test X402StreamResult dataclass."""
        result = X402StreamResult(success=False, error='Stream failed')
        assert result.success is False
        assert result.error == 'Stream failed'

    def test_chat_message_with_name(self):
        """Test ChatMessage with optional name field."""
        msg = ChatMessage(role='function', content='{"result": "ok"}', name='get_weather')
        assert msg.role == 'function'
        assert msg.content == '{"result": "ok"}'
        assert msg.name == 'get_weather'

    def test_choice_delta_defaults(self):
        """Test ChoiceDelta default values."""
        delta = ChoiceDelta()
        assert delta.role is None
        assert delta.content is None

    def test_usage_defaults(self):
        """Test Usage dataclass."""
        usage = Usage(prompt_tokens=10, completion_tokens=20, total_tokens=30)
        assert usage.prompt_tokens == 10
        assert usage.completion_tokens == 20
        assert usage.total_tokens == 30