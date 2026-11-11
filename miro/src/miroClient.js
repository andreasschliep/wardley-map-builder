'use strict';

/**
 * Minimal Miro REST API v2 client: only the calls the Wardley renderer needs.
 *
 * - Spaces requests out (~90 per minute) to stay below Miro's rate limit.
 * - Retries 429 and 5xx responses, timeouts and network errors with backoff
 *   (honours Retry-After). Other 4xx errors fail immediately.
 * - `fetch`, `sleep` and `now` can be injected, which keeps tests offline.
 */

const DEFAULT_BASE_URL = 'https://api.miro.com/v2';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_BOARD_NAME = 60; // Miro rejects longer board names

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Map simple cap names to Miro API values.
const CAPS = { none: 'none', arrow: 'stealth', arrow_open: 'open_arrow', circle: 'filled_circle' };

class MiroApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'MiroApiError';
    this.status = status;
    this.body = body;
  }
}

class MiroClient {
  /**
   * @param {string} accessToken - Miro access token with boards:read and boards:write
   * @param {object} [options]
   * @param {Function} [options.fetch] - fetch implementation (default: global fetch)
   * @param {number} [options.requestDelayMs=650] - minimum gap between requests
   * @param {number} [options.timeoutMs=20000] - per-request timeout
   * @param {number} [options.maxAttempts=5] - attempts per request, including the first
   * @param {number} [options.retryBaseDelayMs=2000] - backoff step (attempt n waits n * step)
   */
  constructor(accessToken, options = {}) {
    if (!accessToken) throw new Error('A Miro access token is required (set MIRO_ACCESS_TOKEN).');
    this.accessToken = accessToken;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.fetch = options.fetch || globalThis.fetch;
    this.requestDelayMs = options.requestDelayMs ?? 650;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 2000;
    this.sleep = options.sleep || realSleep;
    this.now = options.now || Date.now;
    this.warn = options.warn || ((msg) => console.warn(msg));
    this.lastRequestAt = -Infinity;
  }

  async rateLimit() {
    const wait = this.lastRequestAt + this.requestDelayMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  async request(method, path, body) {
    for (let attempt = 1; ; attempt += 1) {
      await this.rateLimit();
      let response;
      let networkError;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        networkError = err;
      }

      if (response && response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : {};
      }

      const status = response ? response.status : undefined;
      const retryable = Boolean(networkError) || RETRYABLE_STATUS.has(status);
      if (!retryable || attempt >= this.maxAttempts) {
        const detail = response ? await response.text().catch(() => '') : networkError.message;
        throw new MiroApiError(`${method} ${path} failed${status ? ` with ${status}` : ''}: ${detail}`, status, detail);
      }

      const retryAfter = response ? Number(response.headers?.get?.('retry-after')) : NaN;
      const delay = retryAfter > 0 ? retryAfter * 1000 : this.retryBaseDelayMs * attempt;
      this.warn(`  ${method} ${path} failed (${status ?? networkError.message}), `
        + `retry ${attempt}/${this.maxAttempts - 1} in ${Math.round(delay / 1000)}s`);
      await this.sleep(delay);
    }
  }

  /** Cheap authenticated call to fail fast on a bad token. */
  async verifyConnection() {
    await this.request('GET', '/boards?limit=1');
    return true;
  }

  /** Create a board with Miro's default (private) sharing settings. */
  async createBoard(name) {
    return this.request('POST', '/boards', { name: String(name).slice(0, MAX_BOARD_NAME) });
  }

  async createFrame(boardId, { title, x, y, width, height }) {
    return this.request('POST', `/boards/${encodeURIComponent(boardId)}/frames`, {
      data: { title, type: 'freeform' },
      position: { x, y },
      geometry: { width, height },
    });
  }

  /**
   * Create a shape. With `parentId`, x/y are relative to the frame's top-left corner.
   * @param {string} boardId
   * @param {{content?: string, shape?: string, x: number, y: number, width: number, height: number,
   *          parentId?: string, style?: object}} item
   */
  async createShape(boardId, { content = '', shape = 'rectangle', x, y, width, height, parentId, style = {} }) {
    const html = style.fontColor && content ? `<span style="color: ${style.fontColor}">${content}</span>` : content;
    const payload = {
      data: { content: html, shape },
      style: {
        fillColor: style.fillColor || '#ffffff',
        borderColor: style.borderColor || '#1a1a1a',
        borderWidth: String(style.borderWidth || '1'),
        fontSize: String(style.fontSize || '14'),
        textAlign: style.textAlign || 'center',
      },
      position: { x, y },
      geometry: { width, height },
    };
    if (parentId) payload.parent = { id: parentId };
    return this.request('POST', `/boards/${encodeURIComponent(boardId)}/shapes`, payload);
  }

  /** Connect two existing items. Caps: none | arrow | arrow_open | circle. */
  async createConnector(boardId, { startItemId, endItemId, shape = 'straight', startCap = 'none',
    endCap = 'arrow', color = '#808080', strokeWidth = 2, strokeStyle = 'normal' }) {
    return this.request('POST', `/boards/${encodeURIComponent(boardId)}/connectors`, {
      startItem: { id: startItemId },
      endItem: { id: endItemId },
      shape,
      style: {
        strokeColor: color,
        strokeWidth: String(strokeWidth),
        strokeStyle,
        startStrokeCap: CAPS[startCap] || startCap,
        endStrokeCap: CAPS[endCap] || endCap,
      },
    });
  }
}

module.exports = { MiroClient, MiroApiError, MAX_BOARD_NAME };
