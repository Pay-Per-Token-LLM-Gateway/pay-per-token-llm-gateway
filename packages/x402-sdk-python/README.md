# x402 SDK — Python

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](pyproject.toml)

Python client SDK for the [x402 LLM Gateway](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway) — pay-per-request LLM access with stablecoin micropayments on Stellar.

Automatically handles the **402 → Pay → Retry** flow: when the gateway returns HTTP 402 Payment Required, the SDK builds and submits a Stellar payment, then retries the request with the payment proof — all transparently.

## Features

- **Core SDK** — `X402Client` with `call()` and `call_stream()` for non-streaming and SSE streaming LLM requests
- **Automatic 402 Handling** — detects 402 responses, pays using your Stellar secret key, and retries with the payment hash
- **Stellar Wallet Integration** — build, sign, and submit Stellar payment transactions via Horizon
- **LangChain Integration** — `X402ChatModel` extends `BaseChatModel` for drop-in use with LangChain/LangGraph
- **Flat & Per-Token Pricing** — supports both pricing models
- **Payment Verification** — polls Horizon for transaction confirmation with configurable timeout
- **Async-First** — built on `httpx` and `asyncio` for high concurrency

## Installation

```bash
# Core SDK (HTTP client + Stellar wallet)
pip install x402-sdk

# With LangChain support
pip install x402-sdk[langchain]

# Development
pip install x402-sdk[dev]
```

## Quick Start

### Basic Usage

```python
import asyncio
from x402_sdk import X402Client, X402ClientConfig, ChatCompletionRequest, ChatMessage

async def main():
    config = X402ClientConfig(
        gatewayUrl='https://gateway.example.com',
        network='testnet',
        secretKey='S...',  # Your Stellar secret key
    )

    client = X402Client(config)

    request = ChatCompletionRequest(
        model='gpt-4o',
        messages=[
            ChatMessage(role='user', content='What is the capital of France?'),
        ],
        max_tokens=100,
    )

    result = await client.call(request)
    if result.success:
        print(f'Response: {result.response.choices[0].message.content}')
        if result.cost:
            print(f'Cost: {result.cost.amount} {result.cost.asset}')
    else:
        print(f'Error: {result.error}')

    await client.close()

asyncio.run(main())
```

### Streaming

```python
async def stream_example():
    config = X402ClientConfig(
        gatewayUrl='https://gateway.example.com',
        secretKey='S...',
    )

    client = X402Client(config)

    request = ChatCompletionRequest(
        model='gpt-4o',
        messages=[ChatMessage(role='user', content='Tell me a story.')],
        stream=True,
    )

    result = await client.call_stream(request)
    if result.success and result.stream:
        async for chunk in result.stream:
            for choice in chunk.choices:
                if choice.delta.content:
                    print(choice.delta.content, end='', flush=True)

    await client.close()
```

### LangChain Integration

```python
from langchain_core.messages import HumanMessage
from x402_sdk import X402ChatModel

model = X402ChatModel(
    gateway_url='https://gateway.example.com',
    model='gpt-4o',
    stellar_secret_key='S...',
    network='testnet',
    temperature=0.7,
)

# Synchronous invoke
result = model.invoke([HumanMessage(content='Hello!')])
print(result.content)

# Streaming
for chunk in model.stream([HumanMessage(content='Tell me a story.')]):
    print(chunk.content, end='', flush=True)
```

## API Reference

### `X402Client`

| Method | Description |
|--------|-------------|
| `call(request, *, path, asset, headers)` | Make an LLM API call, auto-handle 402 → pay → retry |
| `call_stream(request, *, path, asset, headers)` | Streaming version returning SSE chunks |
| `check_payment_status(quote_id)` | Check payment status for a quote |
| `close()` | Close the underlying HTTP client |

### `X402ClientConfig`

| Field | Default | Description |
|-------|---------|-------------|
| `gatewayUrl` | — | Gateway base URL (required) |
| `network` | `'testnet'` | Stellar network (`testnet`, `mainnet`, `futurenet`) |
| `defaultAsset` | `'USDC'` | Default payment asset |
| `secretKey` | `None` | Stellar secret key for signing transactions |
| `paymentTimeout` | `300000` | Max time to wait for payment confirmation (ms) |

### `X402ChatModel` (LangChain)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `gateway_url` | `''` | Gateway base URL |
| `model` | `'gpt-4o'` | Model identifier |
| `stellar_secret_key` | `None` | Stellar secret key for 402 payments |
| `network` | `'testnet'` | Stellar network |
| `default_asset` | `'USDC'` | Default payment asset |
| `temperature` | `None` | Sampling temperature |
| `max_tokens` | `None` | Maximum tokens to generate |

## Development

```bash
# Clone the repository
git clone https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway.git
cd pay-per-token-llm-gateway/packages/x402-sdk-python

# Set up virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
python3 -m pytest tests/ -v
```

## License

MIT

## Related

- [x402 Gateway](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway) — The TypeScript monorepo this SDK is part of
- [@x402/sdk](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/tree/main/packages/sdk) — TypeScript SDK that this Python SDK mirrors
- [Stellar SDK](https://github.com/StellarCN/py-stellar-base) — Python Stellar SDK used for transaction building