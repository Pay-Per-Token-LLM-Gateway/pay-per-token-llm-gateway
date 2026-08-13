from typing import Any, List, Optional, Dict
from langchain_core.language_models.llms import BaseLLM
from langchain_core.outputs import Generation, LLMResult
from langchain_core.callbacks.manager import CallbackManagerForLLMRun
from ..client import x402Client

class x402LangChainLLM(BaseLLM):
    """
    LangChain wrapper for the x402 Gateway.
    Allows using x402 as a drop-in replacement for OpenAI/Anthropic in LangChain apps.
    """
    
    base_url: str
    stellar_secret: str
    model: str = "gpt-3.5-turbo"
    network: str = "testnet"
    api_key: Optional[str] = None
    
    def _generate(
        self,
        prompts: List[str],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> LLMResult:
        
        client = x402Client(
            base_url=self.base_url,
            stellar_secret=self.stellar_secret,
            network=self.network,
            api_key=self.api_key
        )
        
        generations = []
        for prompt in prompts:
            payload = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                **kwargs
            }
            
            # The client handles the 402 flow automatically
            response = client.post("/api/v1/chat/completions", json=payload)
            data = response.json()
            
            content = data["choices"][0]["message"]["content"]
            generations.append([Generation(text=content)])
            
        return LLMResult(generations=generations)
        
    @property
    def _llm_type(self) -> str:
        return "x402-gateway"
