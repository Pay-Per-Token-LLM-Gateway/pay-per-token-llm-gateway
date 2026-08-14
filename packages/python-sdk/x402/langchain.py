from typing import Any, List, Optional, Iterator
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, AIMessage
from langchain_core.outputs import ChatResult, ChatGeneration, ChatGenerationChunk
from .client import X402Client
import json

class ChatX402(BaseChatModel):
    gateway_url: str
    stellar_secret: str
    model_name: str
    _client: X402Client

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        self._client = X402Client(self.gateway_url, self.stellar_secret)

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        formatted_messages = [{"role": m.type, "content": m.content} for m in messages]
        payload = {"model": self.model_name, "messages": formatted_messages}
        
        response = self._client.post("/v1/chat/completions", json=payload)
        response.raise_for_status()
        
        data = response.json()
        ai_msg = AIMessage(content=data["choices"][0]["message"]["content"])
        return ChatResult(generations=[ChatGeneration(message=ai_msg)])

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        formatted_messages = [{"role": m.type, "content": m.content} for m in messages]
        payload = {"model": self.model_name, "messages": formatted_messages, "stream": True}
        
        response = self._client.post("/v1/chat/completions", json=payload, stream=True)
        response.raise_for_status()
        
        for line in response.iter_lines():
            if line:
                decoded = line.decode('utf-8')
                if decoded.startswith("data: ") and decoded != "data: [DONE]":
                    chunk = json.loads(decoded[6:])
                    content = chunk["choices"][0]["delta"].get("content", "")
                    if content:
                        yield ChatGenerationChunk(message=AIMessage(content=content))

    @property
    def _llm_type(self) -> str:
        return "x402-chat"
