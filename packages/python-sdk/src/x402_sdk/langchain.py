from __future__ import annotations

from typing import Any

from .client import PaymentHandler, X402Client

try:
    from langchain_core.language_models.llms import LLM
except ImportError as exc:  # pragma: no cover - import guard
    raise ImportError(
        "Install LangChain support with `pip install x402-sdk[langchain]`."
    ) from exc


class X402LLM(LLM):
    """LangChain LLM wrapper for an x402 gateway."""

    gateway_url: str
    model: str
    payment_handler: PaymentHandler | None = None
    path: str = "/v1/chat/completions"
    timeout: float = 60.0

    @property
    def _llm_type(self) -> str:
        return "x402"

    def _call(self, prompt: str, stop: list[str] | None = None, **kwargs: Any) -> str:
        client = X402Client(
            gateway_url=self.gateway_url,
            payment_handler=self.payment_handler,
            default_path=self.path,
            timeout=self.timeout,
        )
        request = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            **kwargs,
        }
        if stop:
            request["stop"] = stop
        result = client.call(request)
        choices = result.response.get("choices", [])
        if not choices:
            return ""
        message = choices[0].get("message", {})
        return str(message.get("content", ""))

