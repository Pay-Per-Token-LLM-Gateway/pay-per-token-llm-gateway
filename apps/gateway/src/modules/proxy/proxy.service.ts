import { Injectable, Optional } from '@nestjs/common';
import type { Response } from 'express';
import type { ChatCompletionRequest, ChatCompletionResponse, RouteConfig } from '@x402/types';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { retry, NonRetryableError } from '@x402/shared';
import { LoadBalancerService } from '../../common/load-balancer.service';

// ── Circuit Breaker ──────────────────────────

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  open: boolean;
}

/**
 * Simple in-memory circuit breaker per upstream URL.
 *
 * After N consecutive failures, the circuit opens and immediately rejects
 * all calls for a cooldown period. After the cooldown, one test call is
 * allowed (half-open). If it succeeds, the circuit closes.
 */
class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  /**
   * Check if a request to `upstreamUrl` is allowed.
   * Throws if the circuit is open.
   */
  checkCircuit(upstreamUrl: string): void {
    const circuit = this.circuits.get(upstreamUrl);
    if (!circuit?.open) return;

    const elapsed = Date.now() - circuit.lastFailureTime;
    if (elapsed >= this.cooldownMs) {
      // Half-open: allow one test call
      circuit.open = false;
      logger.warn('Circuit half-open — allowing test call', { upstreamUrl });
      return;
    }

    const retryIn = Math.ceil((this.cooldownMs - elapsed) / 1000);
    throw new Error(`Circuit breaker open for ${upstreamUrl}. Retry in ${retryIn}s.`);
  }

  /** Record a successful call — reset the circuit. */
  recordSuccess(upstreamUrl: string): void {
    this.circuits.delete(upstreamUrl);
  }

  /** Record a failed call — increment failure count and possibly open circuit. */
  recordFailure(upstreamUrl: string): void {
    const circuit = this.circuits.get(upstreamUrl) || {
      failures: 0,
      lastFailureTime: 0,
      open: false,
    };

    circuit.failures++;
    circuit.lastFailureTime = Date.now();

    if (circuit.failures >= this.failureThreshold) {
      circuit.open = true;
      logger.error('Circuit breaker opened', {
        upstreamUrl,
        failures: circuit.failures,
        cooldownMs: this.cooldownMs,
      });
    }

    this.circuits.set(upstreamUrl, circuit);
  }
}

// ── Proxy Service ────────────────────────────

@Injectable()
export class ProxyService {
  private readonly circuitBreaker = new CircuitBreaker();

  constructor(@Optional() private readonly loadBalancer?: LoadBalancerService) {}

  async forwardBalancedRequest(
    request: ChatCompletionRequest,
    route: RouteConfig,
    apiKey?: string,
    traceId?: string,
  ): Promise<{ response: ChatCompletionResponse; responseTime: number; upstreamUrl: string }> {
    if (!route.loadBalancing || !this.loadBalancer) {
      const result = await this.forwardRequest(request, route.upstreamUrl, apiKey, traceId);
      return { ...result, upstreamUrl: route.upstreamUrl };
    }

    const maxAttempts = route.loadBalancing.upstreams.length;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const selected = this.loadBalancer.selectUpstream(route.id, route.loadBalancing);
      const start = Date.now();
      const endpointApiKey = selected.endpoint.apiKeyEnv
        ? process.env[selected.endpoint.apiKeyEnv]
        : apiKey;

      try {
        const result = await this.forwardRequest(
          request,
          selected.endpoint.url,
          endpointApiKey,
          traceId,
        );
        this.loadBalancer.recordSuccess(route.id, selected.endpoint, Date.now() - start);
        return { ...result, upstreamUrl: selected.endpoint.url };
      } catch (error) {
        lastError = error;
        this.loadBalancer.recordFailure(
          route.id,
          selected.endpoint,
          error,
          route.loadBalancing.failureThreshold,
        );
        logger.warn('Load-balanced upstream failed, trying next provider', {
          traceId,
          routeId: route.id,
          upstreamUrl: selected.endpoint.url,
          attempt: attempt + 1,
          maxAttempts,
          error: String(error),
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async forwardBalancedStreamRequest(
    request: ChatCompletionRequest,
    route: RouteConfig,
    res: Response,
    apiKey?: string,
    traceId?: string,
    onDone?: (totalTokens?: number) => void,
  ): Promise<{ upstreamUrl: string }> {
    if (!route.loadBalancing || !this.loadBalancer) {
      await this.forwardStreamRequest(request, route.upstreamUrl, res, apiKey, traceId, onDone);
      return { upstreamUrl: route.upstreamUrl };
    }

    const maxAttempts = route.loadBalancing.upstreams.length;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const selected = this.loadBalancer.selectUpstream(route.id, route.loadBalancing);
      const start = Date.now();
      const endpointApiKey = selected.endpoint.apiKeyEnv
        ? process.env[selected.endpoint.apiKeyEnv]
        : apiKey;

      try {
        await this.forwardStreamRequest(
          request,
          selected.endpoint.url,
          res,
          endpointApiKey,
          traceId,
          onDone,
        );
        this.loadBalancer.recordSuccess(route.id, selected.endpoint, Date.now() - start);
        return { upstreamUrl: selected.endpoint.url };
      } catch (error) {
        lastError = error;
        this.loadBalancer.recordFailure(
          route.id,
          selected.endpoint,
          error,
          route.loadBalancing.failureThreshold,
        );
        if (res.headersSent) {
          throw error;
        }
        logger.warn('Streaming upstream failed before headers, trying next provider', {
          traceId,
          routeId: route.id,
          upstreamUrl: selected.endpoint.url,
          attempt: attempt + 1,
          maxAttempts,
          error: String(error),
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Forward a request to the upstream LLM endpoint (non-streaming).
   */
  async forwardRequest(
    request: ChatCompletionRequest,
    upstreamUrl: string,
    apiKey?: string,
    traceId?: string,
  ): Promise<{ response: ChatCompletionResponse; responseTime: number }> {
    const config = getConfig();
    const startTime = Date.now();

    // Circuit breaker check — fast-fail if the upstream has been failing
    this.circuitBreaker.checkCircuit(upstreamUrl);

    try {
      const response = await retry(
        async () => {
          const res = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(traceId ? { 'X-Request-Trace-Id': traceId } : {}),
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(config.llm.requestTimeout),
          });

          if (!res.ok) {
            const errorBody = await res.text();
            // 4xx errors are client/config errors — retrying them wastes
            // upstream quota and adds latency. Only 5xx/network/timeouts retry.
            if (res.status >= 400 && res.status < 500) {
              throw new NonRetryableError(`Upstream error: ${res.status} ${errorBody}`);
            }
            throw new Error(`Upstream error: ${res.status} ${errorBody}`);
          }

          return res;
        },
        {
          maxAttempts: config.llm.maxRetries,
          baseDelayMs: 1000,
          onRetry: (attempt, error) => {
            logger.warn(`Retrying upstream call (attempt ${attempt})`, { error: error.message });
          },
        },
      );

      this.circuitBreaker.recordSuccess(upstreamUrl);

      const data = (await response.json()) as ChatCompletionResponse;
      const responseTime = Date.now() - startTime;

      logger.info('Upstream request completed', {
        model: request.model,
        responseTime,
        tokens: data.usage?.total_tokens,
      });

      return { response: data, responseTime };
    } catch (error) {
      this.circuitBreaker.recordFailure(upstreamUrl);
      throw error;
    }
  }

  /**
   * Forward a streaming request to the upstream LLM and pipe SSE chunks
   * directly to the client response. Handles client disconnection gracefully
   * and extracts usage tokens from the final stream chunk.
   *
   * On completion, calls `onDone` with the total token count (if available).
   */
  async forwardStreamRequest(
    request: ChatCompletionRequest,
    upstreamUrl: string,
    res: Response,
    apiKey?: string,
    traceId?: string,
    onDone?: (totalTokens?: number) => void,
  ): Promise<void> {
    const config = getConfig();
    const startTime = Date.now();

    // Circuit breaker check — fast-fail if the upstream has been failing
    this.circuitBreaker.checkCircuit(upstreamUrl);

    // Use configured streaming timeout (defaults to 10 minutes)
    const streamTimeout = config.llm.streamTimeout ?? 600_000;

    // AbortController for client-disconnect propagation to upstream
    const abortController = new AbortController();

    let upstreamResponse: globalThis.Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(traceId ? { 'X-Request-Trace-Id': traceId } : {}),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ ...request, stream: true }),
        signal: abortController.signal,
      });
    } catch (err) {
      this.circuitBreaker.recordFailure(upstreamUrl);
      throw err;
    }

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      this.circuitBreaker.recordFailure(upstreamUrl);
      throw new Error(`Upstream error: ${upstreamResponse.status} ${errorBody}`);
    }

    this.circuitBreaker.recordSuccess(upstreamUrl);

    if (!upstreamResponse.body) {
      throw new Error('Upstream returned no response body for streaming');
    }

    // Set SSE headers on the client response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders(); // send headers immediately

    const reader = upstreamResponse.body.getReader();
    let totalTokens: number | undefined;
    let aborted = false;

    // Handle client disconnection → abort upstream fetch + reader
    const onClientClose = () => {
      aborted = true;
      abortController.abort();
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
    };
    res.on('close', onClientClose);

    // Safety timeout: if upstream hangs, close the stream
    const safetyTimer = setTimeout(() => {
      if (!aborted && !res.writableEnded) {
        logger.warn('Stream timeout reached, closing connection', { model: request.model });
        abortController.abort();
        try {
          reader.cancel();
        } catch {
          /* ignore */
        }
        onClientClose();
      }
    }, streamTimeout);

    try {
      const decoder = new TextDecoder();
      let lineBuffer = '';

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        // Forward raw bytes to the client immediately
        res.write(value);

        // Parse individual SSE lines to extract usage from the last valid chunk
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;

          try {
            const jsonStr = trimmed.slice(6);
            const parsed = JSON.parse(jsonStr);
            // Capture usage from any chunk that has it (typically the last)
            if (parsed.usage?.total_tokens != null) {
              totalTokens = parsed.usage.total_tokens;
            }
          } catch {
            /* skip unparseable lines */
          }
        }
      }
    } catch (err) {
      if (!aborted) {
        this.circuitBreaker.recordFailure(upstreamUrl);
        logger.error('Stream forwarding error', { error: String(err) });
        if (!res.writableEnded) {
          try {
            res.write(
              `data: ${JSON.stringify({ error: { message: 'Stream interrupted', type: 'gateway_error' } })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
          } catch {
            /* client may have disconnected */
          }
        }
      }
    } finally {
      clearTimeout(safetyTimer);
      reader.releaseLock();
      res.removeListener('close', onClientClose);

      if (!res.writableEnded) {
        res.end();
      }

      const responseTime = Date.now() - startTime;
      logger.info('Streaming request completed', {
        model: request.model,
        responseTime,
        tokens: totalTokens,
        aborted,
      });

      onDone?.(totalTokens);
    }
  }

  /**
   * Validate that the incoming request has the expected format.
   */
  validateRequest(request: unknown): request is ChatCompletionRequest {
    if (!request || typeof request !== 'object') return false;
    const r = request as Record<string, unknown>;
    return (
      typeof r.model === 'string' &&
      Array.isArray(r.messages) &&
      (r.messages as unknown[]).length > 0
    );
  }
}
