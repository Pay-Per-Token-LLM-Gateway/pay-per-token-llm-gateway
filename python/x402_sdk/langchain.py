"""LangChain integration for x402.

A ``BaseChatModel`` subclass that wraps :class:`~x402_sdk.client.X402Client`
so LangChain apps can use an x402 gateway as a drop-in LLM provider. The
402 → pay → retry flow happens transparently inside ``_generate`` and
``_stream``.

Requires the optional ``langchain`` extra (``pip install x402-sdk[langchain]``).
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Iterator, List, Optional

try:
    from langchain_core.callbacks import CallbackManagerForLLMRun
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
    from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
    from pydantic import ConfigDict, PrivateAttr
except ImportError as error:  # pragma: no cover - import-time guard for the optional extra
    raise ImportError(
        "The LangChain integration requires langchain-core. "
        "Install it with: pip install 'x402-sdk[langchain]'"
    ) from error

from .client import X402Client
from .types import X402ClientConfig

_ROLE_MAP = {
    "human": "user",
    "ai": "assistant",
    "system": "system",
    "function": "function",
    "tool": "tool",
}


def _to_openai_message(message: BaseMessage) -> Dict[str, Any]:
    """Convert a LangChain message to the OpenAI-compatible wire format."""
    role = _ROLE_MAP.get(message.type, message.type)
    converted: Dict[str, Any] = {"role": role, "content": message.content}
    if message.type == "ai" and message.additional_kwargs.get("function_call"):
        converted["function_call"] = message.additional_kwargs["function_call"]
    if message.type == "function" and getattr(message, "name", None):
        converted["name"] = message.name
    if message.type == "tool":
        converted["tool_call_id"] = getattr(message, "tool_call_id", None)
    return converted


class X402ChatModel(BaseChatModel):
    """LangChain chat model that routes through an x402 gateway.

    Example::

        from x402_sdk.langchain import X402ChatModel

        llm = X402ChatModel(
            gateway_url="https://gateway.example.com",
            model_name="provider/model",
            secret_key="S...",
            temperature=0.7,
        )
        result = llm.invoke("Hello!")
    """

    gateway_url: str
    model_name: str
    network: str = "testnet"
    default_asset: str = "USDC"
    secret_key: Optional[str] = None
    public_key: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    payment_timeout: int = 300_000
    horizon_url: Optional[str] = None  # override the per-network Horizon endpoint
    sign_transaction: Optional[Callable[[str], str]] = None

    model_config = ConfigDict(arbitrary_types_allowed=True)

    _client: X402Client = PrivateAttr(default=None)

    @property
    def _llm_type(self) -> str:
        return "x402"

    @property
    def x402_client(self) -> X402Client:
        """The underlying :class:`X402Client` (created lazily).

        Named ``x402_client`` rather than ``client`` because
        ``BaseChatModel`` in langchain-core >= 0.2 declares a ``client``
        field that would shadow a plain ``client`` property.
        """
        if self._client is None:
            self._client = X402Client(
                X402ClientConfig(
                    gateway_url=self.gateway_url,
                    network=self.network,
                    default_asset=self.default_asset,
                    secret_key=self.secret_key,
                    public_key=self.public_key,
                    payment_timeout=self.payment_timeout,
                    horizon_url=self.horizon_url,
                    sign_transaction=self.sign_transaction,
                )
            )
        return self._client

    # ── BaseChatModel implementation ──────────────────────────────────────

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        request = self._build_request(messages, stop, **kwargs)
        result = self.x402_client.call(request)
        if not result.success:
            raise ValueError(result.error)
        assert result.response is not None
        return self._to_chat_result(result.response, result)

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        request = self._build_request(messages, stop, **kwargs)
        result = self.x402_client.call_stream(request)
        if not result.success:
            raise ValueError(result.error)
        assert result.stream is not None

        for chunk in result.stream:
            choices = chunk.get("choices") or []
            if choices:
                delta = choices[0].get("delta", {}) or {}
                content = delta.get("content")
                if content:
                    generation = ChatGenerationChunk(message=AIMessageChunk(content=content))
                    if run_manager:
                        run_manager.on_llm_new_token(content, chunk=generation)
                    yield generation
                elif delta:
                    # Function-call / tool-call deltas — propagate as empty chunks.
                    yield ChatGenerationChunk(
                        message=AIMessageChunk(content="", additional_kwargs=delta)
                    )
            usage = chunk.get("usage")
            if usage:
                # Final usage-only frame: attach usage metadata.
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content="", response_metadata={"usage": usage})
                )

    # ── Helpers ───────────────────────────────────────────────────────────

    def _build_request(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]],
        **kwargs: Any,
    ) -> Dict[str, Any]:
        request: Dict[str, Any] = {
            "model": self.model_name,
            "messages": [_to_openai_message(message) for message in messages],
        }
        if self.temperature is not None:
            request["temperature"] = self.temperature
        if self.max_tokens is not None:
            request["max_tokens"] = self.max_tokens
        if stop:
            request["stop"] = stop
        # Passthrough of extra generation options ("stream" is managed by the client).
        request.update({key: value for key, value in kwargs.items() if key != "stream"})
        return request

    @staticmethod
    def _to_chat_result(response: Dict[str, Any], result: Any) -> ChatResult:
        choices = response.get("choices") or []
        choice = choices[0] if choices else {}
        message = choice.get("message", {}) or {}
        usage = response.get("usage")
        ai_message = AIMessage(
            content=message.get("content") or "",
            additional_kwargs={
                key: value
                for key, value in message.items()
                if key not in ("content", "role")
            },
            response_metadata={
                "model": response.get("model"),
                "finish_reason": choice.get("finish_reason"),
                "usage": usage,
                "receipt": result.receipt,
                "cost": result.cost,
            },
        )
        return ChatResult(generations=[ChatGeneration(message=ai_message)])
