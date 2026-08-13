# x402 Python SDK

The official Python client for the x402 Pay-Per-Token LLM Gateway.
Automatically handles HTTP 402 Payment Required flows via the Stellar network.

## Installation

```bash
pip install x402-sdk
```

## Basic Usage

```python
from x402 import x402Client

client = x402Client(
    base_url="https://gateway.example.com",
    stellar_secret="S...", # Your Stellar secret key
    network="testnet"
)

response = client.post("/api/v1/chat/completions", json={
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello world"}]
})

print(response.json())
```

## LangChain Integration

You can use the x402 gateway as a drop-in replacement for OpenAI/Anthropic in your LangChain applications.

```python
from x402.langchain import x402LangChainLLM

llm = x402LangChainLLM(
    base_url="https://gateway.example.com",
    stellar_secret="S...",
    model="gpt-3.5-turbo"
)

print(llm.invoke("What is the capital of France?"))
```
