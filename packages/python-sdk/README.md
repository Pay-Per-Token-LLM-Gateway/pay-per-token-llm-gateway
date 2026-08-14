# x402 Python SDK
A Python client and LangChain integration for the Pay-Per-Token Gateway.

## Installation
```bash
pip install x402
```

## Usage
```python
from x402 import ChatX402

llm = ChatX402(
    gateway_url="http://localhost:3000",
    stellar_secret="SA...",
    model_name="gpt-3.5-turbo"
)

response = llm.invoke("Hello, how are you?")
print(response.content)
```
