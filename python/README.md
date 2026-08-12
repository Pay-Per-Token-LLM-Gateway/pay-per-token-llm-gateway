# x402-sdk (Python)

Python client SDK for the **x402** payment protocol — automatic
**402 → pay → retry** for LLM gateways, mirroring the TypeScript
[`@x402/sdk`](../packages/sdk). Python AI apps can use the
[pay-per-token-llm-gateway](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway)
as a drop-in LLM provider: the first request returns a `402 Payment
Required` with a Stellar quote, the SDK pays it (build → sign → submit →
confirm on-chain), then transparently retries with the `X-Payment-Hash`
header.

Includes:

- **Core client** — `X402Client.call()` / `X402Client.call_stream()`
- **Stellar payment execution** — secret-key and external-signer modes
- **Streaming (SSE)** — with trailing `x402_receipt` support
- **LangChain integration** — `X402ChatModel(BaseChatModel)` as a drop-in
  chat model
- **Flat-rate and per-token pricing** — both quote shapes are handled by
  the same pay-and-retry flow
- **PyPI-ready packaging** — `hatchling` build, published as `x402-sdk`

## Installation

```bash
pip install x402-sdk            # core SDK
pip install x402-sdk[langchain] # + LangChain integration
```

Requires Python 3.9+.

## Quick start

```python
from x402_sdk import X402Client, X402ClientConfig

client = X402Client(X402ClientConfig(
    gateway_url="https://gateway.example.com",
    network="testnet",            # testnet | futurenet | mainnet
    secret_key="S...",            # your Stellar secret key (or use an
                                  # external signer — see below)
    default_asset="USDC",
))

result = client.call({
    "model": "provider/model",
    "messages": [{"role": "user", "content": "Hello!"}],
})

if result.success:
    print(result.response["choices"][0]["message"]["content"])
    print(result.receipt)   # payment receipt (quoteId, amount, txHash, ...)
    print(result.cost)      # Cost(amount="...", asset="USDC")
else:
    print(result.error)
```

The first request transparently triggers the 402 → pay → retry flow — no
extra code needed.

### Streaming (SSE)

```python
result = client.call_stream({
    "model": "provider/model",
    "messages": [{"role": "user", "content": "Write a haiku"}],
})

for chunk in result.stream:                    # dict per SSE data frame
    delta = chunk["choices"][0]["delta"].get("content")
    if delta:
        print(delta, end="", flush=True)

print("\ncost:", result.cost)                  # available after the stream
print("receipt:", result.receipt)              # incl. trailing x402_receipt
```

### External wallet signing

When the SDK must not hold a secret key (browser wallet extension,
hardware wallet, agent SDK), provide a signer callback instead:

```python
client = X402Client(X402ClientConfig(
    gateway_url="https://gateway.example.com",
    public_key="G...",            # your public Stellar address
    sign_transaction=lambda unsigned_xdr: my_wallet.sign(unsigned_xdr),
))
```

The SDK builds the unsigned transaction, hands the XDR to your signer,
submits the signed XDR, and waits for confirmation.

### Payment status

```python
receipt = client.check_payment_status(quote_id)   # PaymentReceipt | None
```

## LangChain integration

```bash
pip install x402-sdk[langchain]
```

```python
from x402_sdk.langchain import X402ChatModel

llm = X402ChatModel(
    gateway_url="https://gateway.example.com",
    model_name="provider/model",
    secret_key="S...",
    temperature=0.7,
)

# Regular calls
print(llm.invoke("Hello!").content)

# Streaming
for chunk in llm.stream("Tell me a story"):
    print(chunk.content, end="", flush=True)

# In a chain
from langchain_core.prompts import ChatPromptTemplate
chain = ChatPromptTemplate.from_template("Summarize: {text}") | llm
```

The 402 → pay → retry flow is fully transparent inside `_generate()` and
`_stream()`. Payment receipts and usage are attached to
`response_metadata`.

## Per-token pricing

Both quote shapes (`pricingModel: "flat" | "per_token"`) flow through the
same client code. For per-token routes the gateway issues a quote for the
estimated maximum tokens; the receipt returned with the final response
carries the actual cost (`actualCost`) and tokens consumed (`tokensUsed`).

## Configuration

| Field              | Default          | Description                                                |
| ------------------ | ---------------- | ---------------------------------------------------------- |
| `gateway_url`      | —                | Gateway base URL (required)                                |
| `network`          | `"testnet"`      | Stellar network: `testnet`, `futurenet`, `mainnet`         |
| `default_asset`    | `"USDC"`         | Asset used when the quote asset is not overridden per call |
| `secret_key`       | `None`           | Stellar secret key (secret-key signing mode)               |
| `public_key`       | `None`           | Stellar public key (external-signer mode)                  |
| `sign_transaction` | `None`           | `(unsigned_xdr: str) -> str` signer callback               |
| `payment_timeout`  | `300_000`        | Max ms to wait for on-chain confirmation                   |
| `horizon_url`      | per-network      | Override the Horizon endpoint                              |
| `http_client`      | `httpx.Client()` | Inject an `httpx.Client` (tests, proxies)                  |

## Development

```bash
uv venv --python 3.10 .venv-py
uv pip install --python .venv-py/bin/python -e 'python[langchain,test]'
cd python && ../.venv-py/bin/python -m pytest
```

The test suite runs fully offline via `httpx.MockTransport` — no gateway or
Horizon connection required.

## How it works

1. `POST {gateway_url}/v1/chat/completions` with the OpenAI-compatible body
2. Gateway responds `402 Payment Required` with a quote
   (`quote.amount` in stroops, `quote.asset`, `quote.paymentAddress`,
   `quote.memo`, `quote.expiresAt`, ...)
3. SDK validates the quote (expiry, asset), then:
   - converts stroops → asset units
   - builds a Stellar payment tx (BASE_FEE, 300s timeout, text memo)
   - signs (secret key or external signer)
   - submits to Horizon and polls `/transactions/{hash}` until
     `successful`
4. SDK retries the original request with `X-Payment-Hash: <txHash>`
5. Gateway verifies on-chain, forwards to the upstream LLM provider, and
   returns the response plus an `X-Payment-Receipt` header (or a trailing
   `x402_receipt` SSE event for streams)

## License

MIT — see the repository [LICENSE](../LICENSE).
