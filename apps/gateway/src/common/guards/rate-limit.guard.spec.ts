/* eslint-disable @typescript-eslint/no-explicit-any */
import { RateLimitGuard } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  const redisMock = {
    eval: jest.fn().mockResolvedValue(1),
  };

  const prismaMock = {
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const CALLER_HEADER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
  const CLIENT_IP = '203.0.113.7';
  const TX_HASH = 'a'.repeat(64);

  function makeContext(headers: Record<string, string | undefined>, ip?: string) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          ip,
          socket: { remoteAddress: '198.51.100.9' },
        }),
      }),
    } as any;
  }

  function makeGuard() {
    return new RateLimitGuard(redisMock as any, prismaMock as any);
  }

  function evalKey(): string {
    return (redisMock.eval as jest.Mock).mock.calls[0][2] as string;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (redisMock.eval as jest.Mock).mockResolvedValue(1);
    (prismaMock.payment.findFirst as jest.Mock).mockResolvedValue(null);
  });

  it('derives the rate-limit key from the client IP, ignoring x-caller-address', async () => {
    const guard = makeGuard();

    await guard.canActivate(makeContext({ 'x-caller-address': CALLER_HEADER }, CLIENT_IP));

    const key = evalKey();
    expect(key).toContain(CLIENT_IP);
    expect(key).not.toContain(CALLER_HEADER);
  });

  it('falls back to the socket remote address when request.ip is unavailable', async () => {
    const guard = makeGuard();

    await guard.canActivate(makeContext({}, undefined));

    const key = evalKey();
    expect(key).toContain('198.51.100.9');
  });

  it('does NOT grant the paid tier for a fabricated X-Payment-Hash (no confirmed payment)', async () => {
    const guard = makeGuard();

    await guard.canActivate(
      makeContext({ 'x-payment-hash': TX_HASH, 'x-caller-address': CALLER_HEADER }, CLIENT_IP),
    );

    // A fake hash must not raise the limit — the unpaid tier applies.
    const key = evalKey();
    expect(key).toContain(':unpaid:');
    expect(key).toContain(CLIENT_IP);
    expect(key).not.toContain(CALLER_HEADER);
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith({
      where: { txHash: TX_HASH, status: 'confirmed' },
      select: { id: true, payerAddress: true },
    });
  });

  it('grants the paid tier only when the hash maps to a confirmed payment', async () => {
    (prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({ id: 'pay-1', payerAddress: null });
    const guard = makeGuard();

    await guard.canActivate(makeContext({ 'x-payment-hash': TX_HASH }, CLIENT_IP));

    const key = evalKey();
    expect(key).toContain(':paid:');
    expect(key).toContain(CLIENT_IP);
  });

  it('keys the paid tier by wallet address when RATE_LIMIT_BY_WALLET=true', async () => {
    const WALLET = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
    (prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({
      id: 'pay-2',
      payerAddress: WALLET,
    });

    // Set the config flag
    const { setConfig, loadConfig } = jest.requireActual('@x402/config');
    const base = loadConfig();
    setConfig({ ...base, security: { ...base.security, rateLimitByWallet: true } });

    const guard = makeGuard();
    await guard.canActivate(makeContext({ 'x-payment-hash': TX_HASH }, CLIENT_IP));

    const key = evalKey();
    expect(key).toContain(':paid:');
    expect(key).toContain(WALLET);
    expect(key).not.toContain(CLIENT_IP);

    // Reset config
    setConfig(base);
  });

  it('falls back to IP when RATE_LIMIT_BY_WALLET=true but payerAddress is null', async () => {
    (prismaMock.payment.findFirst as jest.Mock).mockResolvedValue({
      id: 'pay-3',
      payerAddress: null,
    });

    const { setConfig, loadConfig } = jest.requireActual('@x402/config');
    const base = loadConfig();
    setConfig({ ...base, security: { ...base.security, rateLimitByWallet: true } });

    const guard = makeGuard();
    await guard.canActivate(makeContext({ 'x-payment-hash': TX_HASH }, CLIENT_IP));

    const key = evalKey();
    expect(key).toContain(':paid:');
    expect(key).toContain(CLIENT_IP);

    // Reset config
    setConfig(base);
  });

  it('throws a 429 when the rate limit is exceeded', async () => {
    (redisMock.eval as jest.Mock).mockResolvedValueOnce(0);
    const guard = makeGuard();

    await expect(guard.canActivate(makeContext({}, CLIENT_IP))).rejects.toThrow(
      'Rate limit exceeded',
    );
  });

  it('allows the request when the limit is not exceeded', async () => {
    const guard = makeGuard();

    await expect(guard.canActivate(makeContext({}, CLIENT_IP))).resolves.toBe(true);
  });
});
