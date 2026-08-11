"""
Tests for x402_sdk LangChain integration.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from x402_sdk.langchain_adapter import X402ChatModel, _convert_lc_message_to_x402

try:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False


pytestmark = pytest.mark.skipif(
    not LANGCHAIN_AVAILABLE,
    reason='langchain-core not installed',
)


class TestX402ChatModel:
    """Test the X402ChatModel class."""

    def test_initialization(self):
        """Test model initialization."""
        model = X402ChatModel(
            gateway_url='https://gateway.example.com',
            model='gpt-4o',
            stellar_secret_key='SABCDEF...',
            network='testnet',
            temperature=0.7,
        )
        assert model.gateway_url == 'https://gateway.example.com'
        assert model.model == 'gpt-4o'
        assert model.stellar_secret_key == 'SABCDEF...'
        assert model.network == 'testnet'
        assert model.temperature == 0.7

    def test_llm_type(self):
        """Test _llm_type property."""
        model = X402ChatModel(gateway_url='https://gateway.example.com')
        assert model._llm_type == 'x402-gateway'

    def test_lazy_client_creation(self):
        """Test that the client is lazily created."""
        model = X402ChatModel(gateway_url='https://gateway.example.com')
        assert model._client is None

        client = model._get_client()
        assert client is not None
        assert model._client is client  # cached

    def test_convert_lc_message_to_x402(self):
        """Test LangChain message to x402 message conversion."""
        lc_msg = HumanMessage(content='Hello!')
        x402_msg = _convert_lc_message_to_x402(lc_msg)
        assert x402_msg.role == 'user'
        assert x402_msg.content == 'Hello!'

        system_msg = SystemMessage(content='You are a helpful assistant.')
        x402_sys = _convert_lc_message_to_x402(system_msg)
        assert x402_sys.role == 'system'
        assert x402_sys.content == 'You are a helpful assistant.'

        ai_msg = AIMessage(content='I am an AI.')
        x402_ai = _convert_lc_message_to_x402(ai_msg)
        assert x402_ai.role == 'assistant'
        assert x402_ai.content == 'I am an AI.'

    @pytest.mark.asyncio
    async def test_agenerate_success(self):
        """Test async generation via _agenerate."""
        model = X402ChatModel(
            gateway_url='https://gateway.example.com',
            model='gpt-4o',
            stellar_secret_key='SABCDEF...',
        )

        # Mock the client's call method
        mock_result = MagicMock()
        mock_result.success = True
        mock_result.error = None
        mock_result.response = MagicMock()
        mock_result.response.choices = [
            MagicMock(
                message=MagicMock(
                    role='assistant',
                    content='Hello! How can I help you?',
                    name=None,
                ),
                index=0,
                finish_reason='stop',
            )
        ]

        model._get_client = MagicMock(return_value=MagicMock(
            call=AsyncMock(return_value=mock_result)
        ))

        result = await model._agenerate([HumanMessage(content='Hello!')])

        assert len(result.generations) == 1
        assert result.generations[0].message.content == 'Hello! How can I help you?'

    @pytest.mark.asyncio
    async def test_agenerate_error(self):
        """Test async generation when gateway returns error."""
        model = X402ChatModel(
            gateway_url='https://gateway.example.com',
            model='gpt-4o',
        )

        mock_result = MagicMock()
        mock_result.success = False
        mock_result.error = 'Payment required. No secret key configured.'

        model._get_client = MagicMock(return_value=MagicMock(
            call=AsyncMock(return_value=mock_result)
        ))

        with pytest.raises(RuntimeError, match='x402 gateway error'):
            await model._agenerate([HumanMessage(content='Hello!')])

    @pytest.mark.asyncio
    async def test_astream_success(self):
        """Test async streaming via _astream."""
        model = X402ChatModel(
            gateway_url='https://gateway.example.com',
            model='gpt-4o',
        )

        # Create mock stream chunks
        async def mock_stream():
            chunk = MagicMock()
            chunk.choices = [MagicMock(
                index=0,
                delta=MagicMock(content='Hello', role=None),
                finish_reason=None,
            )]
            yield chunk

            chunk2 = MagicMock()
            chunk2.choices = [MagicMock(
                index=0,
                delta=MagicMock(content=' world', role=None),
                finish_reason=None,
            )]
            yield chunk2

        mock_result = MagicMock()
        mock_result.success = True
        mock_result.error = None
        mock_result.stream = mock_stream()

        model._get_client = MagicMock(return_value=MagicMock(
            call_stream=AsyncMock(return_value=mock_result)
        ))

        chunks = []
        async for chunk in model._astream([HumanMessage(content='Hello!')]):
            chunks.append(chunk)

        assert len(chunks) == 2
        assert chunks[0].message.content == 'Hello'
        assert chunks[1].message.content == ' world'

    @pytest.mark.asyncio
    async def test_astream_error(self):
        """Test async streaming when gateway returns error."""
        model = X402ChatModel(
            gateway_url='https://gateway.example.com',
            model='gpt-4o',
        )

        mock_result = MagicMock()
        mock_result.success = False
        mock_result.error = 'Stream failed'

        model._get_client = MagicMock(return_value=MagicMock(
            call_stream=AsyncMock(return_value=mock_result)
        ))

        with pytest.raises(RuntimeError, match='x402 gateway error'):
            async for _ in model._astream([HumanMessage(content='Hello!')]):
                pass

    def test_close(self):
        """Test close method."""
        model = X402ChatModel(gateway_url='https://gateway.example.com')
        # Should not raise when client is None
        model.close()

        # Should not raise when client exists
        model._get_client()
        model.close()

    def test_invoke(self):
        """Test synchronous invoke."""
        model = X402ChatModel(
            gateway_url='https://gateway.example.com',
            model='gpt-4o',
            stellar_secret_key='SABCDEF...',
        )

        mock_result = MagicMock()
        mock_result.success = True
        mock_result.error = None
        mock_result.response = MagicMock()
        mock_result.response.choices = [
            MagicMock(
                message=MagicMock(
                    role='assistant',
                    content='Hello!',
                    name=None,
                ),
                index=0,
                finish_reason='stop',
            )
        ]

        model._get_client = MagicMock(return_value=MagicMock(
            call=AsyncMock(return_value=mock_result)
        ))

        result = model.invoke([HumanMessage(content='Hi')])
        assert result.content == 'Hello!'