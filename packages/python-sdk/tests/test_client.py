import json
import unittest
from unittest.mock import Mock

from x402_sdk import X402Client, X402Error
from x402_sdk.stellar import get_horizon_url, get_network_passphrase


class FakeResponse:
    def __init__(self, status_code, body, headers=None, lines=None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self._lines = lines or []
        self.ok = 200 <= status_code < 300
        self.text = json.dumps(body)
        self.closed = False

    def json(self):
        return self._body

    def close(self):
        self.closed = True

    def iter_lines(self, decode_unicode=False):
        return iter(self._lines)


class X402ClientTest(unittest.TestCase):
    def quote(self):
        return {
            "id": "quote-1",
            "route": "/v1/chat/completions",
            "pricingModel": "flat",
            "amount": "1000000",
            "asset": "USDC",
            "paymentAddress": "GDEST",
            "network": "testnet",
            "expiresAt": 4102444800,
            "statusUrl": "https://gateway.example.com/api/v1/payments/quote-1/status",
        }

    def test_call_retries_after_402_with_payment_hash(self):
        session = Mock()
        session.post.side_effect = [
            FakeResponse(402, {"quote": self.quote()}),
            FakeResponse(200, {"choices": [{"message": {"content": "ok"}}]}),
        ]
        payments = []

        client = X402Client(
            "https://gateway.example.com",
            payment_handler=lambda quote: payments.append(quote) or "tx-123",
            session=session,
        )

        result = client.call({"model": "demo", "messages": []})

        self.assertEqual(result.response["choices"][0]["message"]["content"], "ok")
        self.assertEqual(payments[0].id, "quote-1")
        self.assertEqual(session.post.call_args_list[1].kwargs["headers"]["X-Payment-Hash"], "tx-123")

    def test_missing_payment_handler_raises_actionable_error(self):
        session = Mock()
        session.post.return_value = FakeResponse(402, {"quote": self.quote()})
        client = X402Client("https://gateway.example.com", session=session)

        with self.assertRaises(X402Error) as ctx:
            client.call({"model": "demo", "messages": []})

        self.assertIn("payment required", str(ctx.exception))

    def test_stream_parses_sse_chunks(self):
        session = Mock()
        session.post.return_value = FakeResponse(
            200,
            {},
            lines=[
                "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}",
                "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}",
                "data: [DONE]",
            ],
        )
        client = X402Client("https://gateway.example.com", session=session)

        chunks = list(client.stream({"model": "demo", "messages": []}))

        self.assertEqual(chunks[0]["choices"][0]["delta"]["content"], "he")
        self.assertEqual(chunks[1]["choices"][0]["delta"]["content"], "llo")

    def test_stellar_network_helpers_match_project_defaults(self):
        self.assertEqual(get_horizon_url("mainnet"), "https://horizon.stellar.org")
        self.assertEqual(get_horizon_url("testnet"), "https://horizon-testnet.stellar.org")
        self.assertEqual(
            get_network_passphrase("testnet"),
            "Test SDF Network ; September 2015",
        )


if __name__ == "__main__":
    unittest.main()
