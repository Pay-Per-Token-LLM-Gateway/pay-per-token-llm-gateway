# x402 Python SDK

Python client for x402 LLM Gateway applications.

The SDK mirrors the TypeScript `@x402/sdk` flow:

1. Send the original LLM request.
2. If the gateway returns `402 Payment Required`, parse the quote.
3. Ask a caller-provided payment handler to pay the quote.
4. Retry the same request with `X-Payment-Hash`.

The base package does not keep private keys by itself. Apps can wire in a
hosted wallet or test payment handler through the `payment_handler` callback, or
install the Stellar extra to build, sign, submit, and confirm Stellar payments.

## Install

```bash
pip install x402-sdk
```

For LangChain support:

```bash
pip install "x402-sdk[langchain]"
```

For automatic Stellar payments:

```bash
pip install "x402-sdk[stellar]"
```

## Basic Usage

```python
from x402_sdk import X402Client


def pay_quote(quote):
    # Build, sign, submit, and confirm a Stellar transaction here.
    return "stellar_tx_hash"


client = X402Client(
    gateway_url="https://gateway.example.com",
    payment_handler=pay_quote,
)

result = client.call({
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}],
})

print(result.response)
```

## Stellar Payment Handler

```python
import os

from x402_sdk import X402Client, pay_quote_with_stellar


client = X402Client(
    gateway_url="https://gateway.example.com",
    payment_handler=lambda quote: pay_quote_with_stellar(
        quote,
        source_secret=os.environ["STELLAR_SECRET_KEY"],
    ),
)
```

`pay_quote_with_stellar` supports native XLM and issued assets such as USDC when
the gateway quote includes `assetIssuer`. It waits for Horizon confirmation and
returns the transaction hash used as the `X-Payment-Hash` retry header.

## LangChain Usage

```python
from x402_sdk.langchain import X402LLM

llm = X402LLM(
    gateway_url="https://gateway.example.com",
    payment_handler=pay_quote,
    model="gpt-4o-mini",
)

print(llm.invoke("Write a one-line status update."))
```
