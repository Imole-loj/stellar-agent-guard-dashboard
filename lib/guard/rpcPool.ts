import {
  NETWORK,
  probeReadOnlyEndpoint,
  type ReadOnlyProbeResult,
  redactDiagnosticText,
} from "./network.ts";
import type { RpcProbeOptions } from "../rpc/timeouts.ts";

export interface EndpointContinuityContext {
  endpoint: string;
  passphrase?: string;
  network?: string;
}

export class RpcPool {
  primaryUrl: string;
  fallbackUrls: string[];
  currentUrl: string;
  currentNetwork: string;
  failureCount: number = 0;
  rtt: number = 0;
  private healthCheckTimer: any;
  /** Cursors mapped by endpoint URL or network name. */
  private cursors: Map<string, string | null> = new Map();
  private endpointListeners: Array<(newUrl: string, oldUrl: string) => void> = [];
  private networkListeners: Array<(newNetwork: string, oldNetwork: string) => void> = [];

  constructor(primaryUrl: string, fallbackUrls: string[], network: string = NETWORK.name) {
    this.primaryUrl = primaryUrl;
    this.fallbackUrls = fallbackUrls;
    this.currentUrl = primaryUrl;
    this.currentNetwork = network;
  }

  /**
   * Retrieve the active cursor for a specific endpoint or network context.
   * Defaults to `this.currentUrl`.
   */
  getCursor(endpointOrNetwork?: string): string | null {
    const key = endpointOrNetwork ?? this.currentUrl;
    return this.cursors.get(key) ?? null;
  }

  /**
   * Associate a cursor with a specific endpoint or network context.
   */
  setCursor(cursor: string | null, endpointOrNetwork?: string): void {
    const key = endpointOrNetwork ?? this.currentUrl;
    this.cursors.set(key, cursor);
  }

  /**
   * Clear tracked cursors for a given endpoint/network scope, or all cursors if omitted.
   * Essential when switching networks or endpoints to prevent stale event attribution.
   */
  clearCursors(scope?: string): void {
    if (scope) {
      this.cursors.delete(scope);
    } else {
      this.cursors.clear();
    }
  }

  /**
   * Validate whether a cursor from `source` can safely carry over to `target`.
   * Cross-network or mismatched-passphrase transitions NEVER have continuity.
   * Separate endpoints without explicit synchronization require a cursor reset.
   */
  validateContinuity(
    source: EndpointContinuityContext,
    target: EndpointContinuityContext,
  ): boolean {
    if (source.passphrase && target.passphrase && source.passphrase !== target.passphrase) {
      return false;
    }
    if (source.network && target.network && source.network !== target.network) {
      return false;
    }
    if (source.endpoint !== target.endpoint) {
      return false;
    }
    return true;
  }

  /**
   * Switch the active endpoint.
   * Unless explicit continuity is validated, network-specific cursors are reset
   * to guarantee that events from the new endpoint are not skipped or misattributed.
   */
  switchEndpoint(
    newUrl: string,
    options: { resetCursor?: boolean; targetNetwork?: string } = {},
  ): void {
    const oldUrl = this.currentUrl;
    this.currentUrl = newUrl;
    if (options.targetNetwork) {
      this.currentNetwork = options.targetNetwork;
    }
    const shouldReset = options.resetCursor ?? true;
    if (shouldReset) {
      this.cursors.delete(oldUrl);
      this.cursors.delete(newUrl);
    }
    for (const listener of this.endpointListeners) {
      try {
        listener(newUrl, oldUrl);
      } catch {
        // Safe listener execution
      }
    }
  }

  /**
   * Switch the active network context.
   * This immediately wipes all cursors, since cursors from one network
   * must NEVER be sent to or interpreted by another network.
   */
  switchNetwork(newNetwork: string, newUrl?: string): void {
    const oldNetwork = this.currentNetwork;
    this.currentNetwork = newNetwork;
    if (newUrl) {
      this.currentUrl = newUrl;
    }
    this.clearCursors();
    for (const listener of this.networkListeners) {
      try {
        listener(newNetwork, oldNetwork);
      } catch {
        // Safe listener execution
      }
    }
  }

  onEndpointChange(listener: (newUrl: string, oldUrl: string) => void): () => void {
    this.endpointListeners.push(listener);
    return () => {
      this.endpointListeners = this.endpointListeners.filter((l) => l !== listener);
    };
  }

  onNetworkChange(listener: (newNetwork: string, oldNetwork: string) => void): () => void {
    this.networkListeners.push(listener);
    return () => {
      this.networkListeners = this.networkListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Execute an operator-controlled read-only probe of an endpoint using `getNetwork`.
   */
  async probeEndpoint(url?: string, options?: RpcProbeOptions): Promise<ReadOnlyProbeResult> {
    return probeReadOnlyEndpoint(url ?? this.currentUrl, options);
  }

  async fetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.currentUrl}${endpoint}`, options);
      this.rtt = Date.now() - start;

      if (response.status === 429 || response.status === 503) {
        this.handleFailure();
      } else {
        this.failureCount = 0;
      }
      return response;
    } catch (error) {
      this.handleFailure();
      const msg = error instanceof Error ? error.message : String(error);
      const safeMsg = redactDiagnosticText(msg);
      if (error instanceof Error && error.message !== safeMsg) {
        error.message = safeMsg;
      }
      throw error;
    }
  }

  private handleFailure() {
    this.failureCount++;
    if (this.failureCount >= 3) {
      this.failover();
    }
  }

  private failover() {
    this.failureCount = 0;
    const oldUrl = this.currentUrl;
    const nextUrl = this.fallbackUrls.shift();
    if (nextUrl) {
      this.fallbackUrls.push(this.currentUrl);
      this.currentUrl = nextUrl;
      // Failover endpoint change clears cursor to avoid stale pagination
      this.cursors.delete(oldUrl);
      this.cursors.delete(nextUrl);
      for (const listener of this.endpointListeners) {
        try {
          listener(nextUrl, oldUrl);
        } catch {
          // Safe listener execution
        }
      }
    }
  }

  startHealthCheck(interval: number = 10000) {
    if (this.healthCheckTimer) clearTimeout(this.healthCheckTimer);
    this.healthCheckTimer = setTimeout(() => {
      this.fetch("/health").catch(() => {});
      this.startHealthCheck(interval);
    }, interval);
  }

  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}
