"""
x402 SDK — LangChain integration.

Provides an X402ChatModel class that extends langchain's BaseChatModel,
enabling transparent 402 → pay → retry flow through the x402 gateway.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Iterator, List, Optional, cast

from .types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    X402CallResult,
    X402ClientConfig,
)

try:
    from langchain_core.callbacks import CallbackManagerForLLMRun
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import (
        AIMessage,
        AIMessageChunk,
        BaseMessage,
        HumanMessage,
        SystemMessage,
    )
    from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False


_ROLE_MAP: dict[str, str] = {
    'human': 'user',
    'user': 'user',
    'ai': 'assistant',
    'assistant': 'assistant',
    'system': 'system',
    'system': 'system',
    'function': 'function',
    'tool': 'function',
}


def _convert_lc_message_to_x402(msg: BaseMessage) -> ChatMessage:
    """Convert a LangChain BaseMessage to an x402 ChatMessage."""
    role = _ROLE_MAP.get(msg.type, msg.type)
    return ChatMessage(role=cast(str, role), content=str(msg.content))


def _convert_x402_to_lc_message(msg: ChatMessage) -> BaseMessage:
    """Convert an x402 ChatMessage to a LangChain BaseMessage."""
    if msg.role == 'user':
        return HumanMessage(content=msg.content)
    elif msg.role == 'system':
        return SystemMessage(content=msg.content)
    elif msg.role == 'function':
        from langchain_core.messages import FunctionMessage
        return FunctionMessage(content=msg.content, name=msg.name or 'function')
    else:
        return AIMessage(content=msg.content)


class X402ChatModel(BaseChatModel):
    """
    LangChain chat model that routes through the x402 gateway.

    Automatically handles the 402 → pay → retry flow using the configured
    Stellar secret key.

    Example usage::

        from x402_sdk import X402ClientConfig, X402ChatModel

        model = X402ChatModel(
            gateway_url="https://gateway.example.com",
            model="gpt-4o",
            stellar_secret_key="S...",
        )

        result = model.invoke([HumanMessage(content="Hello!")])
        print(result.content)
    """

    gateway_url: str = ''
    """x402 gateway base URL."""

    model: str = 'gpt-4o'
    """The model identifier to use."""

    stellar_secret_key: Optional[str] = None
    """Stellar secret key for paying 402 responses."""

    network: str = 'testnet'
    """Stellar network (testnet, mainnet, futurenet)."""

    default_asset: str = 'USDC'
    """Default payment asset."""

    temperature: Optional[float] = None
    """Sampling temperature."""

    max_tokens: Optional[int] = None
    """Maximum tokens to generate."""

    top_p: Optional[float] = None
    """Nucleus sampling parameter."""

    _client: Any = None  # X402Client, lazily initialized

    def __init__(self, **kwargs: Any) -> None:
        if not LANGCHAIN_AVAILABLE:
            raise ImportError(
                'langchain-core is required. Install with: pip install x402-sdk[langchain]'
            )
        super().__init__(**kwargs)

    @property
    def _llm_type(self) -> str:
        return 'x402-gateway'

    def _get_client(self) -> Any:
        """Lazy-initialize the x402 client."""
        if self._client is None:
            from .client import X402Client

            config = X402ClientConfig(
                gatewayUrl=self.gateway_url,
                network=self.network,  # type: ignore[arg-type]
                defaultAsset=self.default_asset,  # type: ignore[arg-type]
                secretKey=self.stellar_secret_key,
            )
            self._client = X402Client(config)
        return self._client

    def _build_request(self, messages: List[BaseMessage], stop: Optional[List[str]] = None) -> dict:
        """Build a chat completion request dict."""
        x402_messages = [_convert_lc_message_to_x402(m) for m in messages]
        req = ChatCompletionRequest(
            model=self.model,
            messages=x402_messages,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            top_p=self.top_p,
            stop=stop,
        )
        return req.to_dict()

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        """Synchronous generation."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            return loop.run_until_complete(
                self._agenerate(messages, stop, run_manager, **kwargs)
            )
        finally:
            loop.close()

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        """Async generation."""
        client = self._get_client()
        body = self._build_request(messages, stop)
        request = ChatCompletionRequest(
            model=body['model'],
            messages=[ChatMessage(**m) for m in body['messages']],
            temperature=body.get('temperature'),
            max_tokens=body.get('max_tokens'),
            top_p=body.get('top_p'),
            stop=body.get('stop'),
        )

        result = await client.call(request)

        if not result.success:
            raise RuntimeError(f'x402 gateway error: {result.error}')

        if not result.response:
            raise RuntimeError('x402 gateway returned empty response')

        # Convert to LangChain ChatResult
        lc_messages = []
        for choice in result.response.choices:
            lc_msg = _convert_x402_to_lc_message(choice.message)
            gen = ChatGeneration(message=lc_msg)
            lc_messages.append(gen)

        return ChatResult(generations=lc_messages)

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        """Synchronous streaming — delegates to async."""
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            async_gen = self._astream(messages, stop, run_manager, **kwargs)
            while True:
                try:
                    chunk = loop.run_until_complete(async_gen.__anext__())
                    yield chunk
                except StopAsyncIteration:
                    break
        finally:
            loop.close()

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        """Async streaming generation."""
        client = self._get_client()
        body = self._build_request(messages, stop)
        request = ChatCompletionRequest(
            model=body['model'],
            messages=[ChatMessage(**m) for m in body['messages']],
            temperature=body.get('temperature'),
            max_tokens=body.get('max_tokens'),
            top_p=body.get('top_p'),
            stop=body.get('stop'),
        )

        result = await client.call_stream(request)

        if not result.success:
            raise RuntimeError(f'x402 gateway error: {result.error}')

        if not result.stream:
            raise RuntimeError('x402 gateway returned empty stream')

        async for chunk in result.stream:
            for choice in chunk.choices:
                content = choice.delta.content or ''
                chunk_msg = ChatGenerationChunk(
                    message=AIMessageChunk(content=content)
                )
                yield chunk_msg

                if run_manager:
                    await run_manager.on_llm_new_token(
                        token=content,
                        chunk=chunk_msg,
                    )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        if self._client is not None:
            import asyncio
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # Can't close in a running loop — skip
                    pass
                else:
                    loop.run_until_complete(self._client.close())
            except RuntimeError:
                pass

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass