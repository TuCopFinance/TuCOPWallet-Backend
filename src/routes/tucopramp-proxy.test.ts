import { createHash } from "crypto";
import request from "supertest";
import { _resetParsedEnvForTests } from "../lib/env";

const REAL_FETCH = global.fetch;

// Capture every outbound upstream call the proxy makes so per-test
// assertions can inspect method / url / headers / body without a
// real network hop.
interface CapturedCall {
  url: string;
  init: {
    method?: string;
    headers?: Headers;
    body?: Buffer | undefined;
  };
}
let captured: CapturedCall[] = [];
let nextUpstreamResponse: {
  status: number;
  body: Buffer;
  headers: Record<string, string>;
} = {
  status: 200,
  body: Buffer.from("{}"),
  headers: { "Content-Type": "application/json" },
};

async function bodyToBuffer(body: unknown): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  // Node fetch may hand off a ReadableStream when the request body is
  // wrapped by Headers/Blob. In this test suite we always send Buffers
  // directly so this branch is defensive; drain and concat.
  if (typeof (body as { getReader?: unknown }).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
  return undefined;
}

function installMockFetch(): void {
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : (input as { toString(): string }).toString();
    captured.push({
      url,
      init: {
        method: init?.method,
        headers:
          init?.headers instanceof Headers
            ? init.headers
            : new Headers(init?.headers),
        body: await bodyToBuffer(init?.body),
      },
    });
    return new Response(nextUpstreamResponse.body, {
      status: nextUpstreamResponse.status,
      headers: nextUpstreamResponse.headers,
    });
  }) as typeof global.fetch;
}

// Env is validated + frozen at first `env` access. Reset the parsed
// cache before each test so per-test env flips take effect.
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  _resetParsedEnvForTests();
}

beforeEach(() => {
  captured = [];
  nextUpstreamResponse = {
    status: 200,
    body: Buffer.from("{}"),
    headers: { "Content-Type": "application/json" },
  };
  installMockFetch();
  setEnv({
    TUCOPRAMP_PROXY_ENABLED: "true",
    TUCOPRAMP_UPSTREAM_URL: "https://api.ramp.tucop.xyz",
    TUCOPRAMP_CONSUMER_KEY_PROD: "tcr_prod_test_key_cafebabe",
  });
});

afterEach(() => {
  global.fetch = REAL_FETCH;
  setEnv({
    TUCOPRAMP_PROXY_ENABLED: undefined,
    TUCOPRAMP_UPSTREAM_URL: undefined,
    TUCOPRAMP_CONSUMER_KEY_PROD: undefined,
  });
});

// Import AFTER installMockFetch runs in beforeEach: app.ts is loaded
// once per suite, but its route handlers close over the current
// global.fetch reference (Node fetch does not bind at module load).
import { app } from "../app";

describe("GET /health/tucopramp-proxy", () => {
  it("exposes enabled + upstream but never the consumer key", async () => {
    const res = await request(app).get("/health/tucopramp-proxy");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      upstream: "https://api.ramp.tucop.xyz",
    });
    // Whitelist assertion: no key field, no key value, at any depth.
    const asString = JSON.stringify(res.body);
    expect(asString).not.toContain("tcr_");
    expect(asString).not.toContain("key");
  });

  it("shape stays the same when the kill switch is OFF (enabled:false, upstream still visible)", async () => {
    setEnv({ TUCOPRAMP_PROXY_ENABLED: "false" });
    const res = await request(app).get("/health/tucopramp-proxy");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      upstream: "https://api.ramp.tucop.xyz",
    });
  });
});

describe("ALL /api/tucopramp/p2p/*", () => {
  it("T1: GET passes wallet-signed headers unchanged + injects X-TuCOPRamp-Key", async () => {
    // Wallet spec §3: X-Wallet-Address, X-Wallet-Timestamp,
    // X-Wallet-Signature, Idempotency-Key MUST reach upstream verbatim.
    // Backend injects X-TuCOPRamp-Key with the consumer key.
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks?limit=10")
      .set("X-Wallet-Address", "0x81dCf9160237D0EF0d4db27CFb2EA9743547f882")
      .set("X-Wallet-Timestamp", "1735689600")
      .set("X-Wallet-Signature", "0xdeadbeef")
      .set("Idempotency-Key", "idem-abc-123");
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://api.ramp.tucop.xyz/p2p/banks?limit=10");
    expect(call.init.method).toBe("GET");
    const h = call.init.headers!;
    expect(h.get("X-Wallet-Address")).toBe(
      "0x81dCf9160237D0EF0d4db27CFb2EA9743547f882",
    );
    expect(h.get("X-Wallet-Timestamp")).toBe("1735689600");
    expect(h.get("X-Wallet-Signature")).toBe("0xdeadbeef");
    expect(h.get("Idempotency-Key")).toBe("idem-abc-123");
    expect(h.get("X-TuCOPRamp-Key")).toBe("tcr_prod_test_key_cafebabe");
  });

  it("T2: POST with JSON body forwards bytes verbatim (SHA256 identical)", async () => {
    // Guard against a middleware that JSON.parse + re-stringify the
    // request body, which would reorder keys / re-quote strings /
    // rewrite whitespace and break the EIP-191 signature check
    // upstream. SHA256 of the wallet-sent bytes must match SHA256 of
    // the bytes the proxy forwarded.
    // Intentionally non-canonical JSON (space after colon, trailing
    // newline) to prove the proxy does NOT round-trip through
    // JSON.parse. Send as a string with an explicit octet-stream
    // Content-Type so supertest / superagent do not JSON-serialise
    // the payload behind our back; the assertion cares about what
    // the proxy FORWARDS, not the specific Content-Type on the wire
    // for the test scaffolding (a real wallet posts with
    // application/json + the wallet's exact bytes).
    const payloadString =
      '{"orderId":"ord_123", "amountCop":50000 ,"walletAddress":"0x81dc"}\n';
    const payload = Buffer.from(payloadString);
    const expectedHash = createHash("sha256").update(payload).digest("hex");

    const res = await request(app)
      .post("/api/tucopramp/p2p/orders")
      .set("Content-Type", "application/octet-stream")
      .set("X-Wallet-Address", "0x81dc")
      .set("X-Wallet-Signature", "0xsig")
      .send(payload);
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const forwardedBody = captured[0]!.init.body;
    expect(forwardedBody).toBeDefined();
    const forwardedHash = createHash("sha256")
      .update(forwardedBody!)
      .digest("hex");
    expect(forwardedHash).toBe(expectedHash);
    expect(forwardedBody!.equals(payload)).toBe(true);
  });

  it("T3: multipart forwards Content-Type with boundary intact + body bytes verbatim", async () => {
    // Multipart proof upload (POST /orders/{id}/proof). Content-Type
    // carries the boundary marker the wallet chose; if the proxy
    // reassembles the multipart body, the boundary will not match
    // what the header advertises and the upstream parser fails.
    const boundary = "----WalletBoundary_9a8b7c6d5e4f3a2b";
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(
        'Content-Disposition: form-data; name="proof"; filename="receipt.jpg"\r\n',
      ),
      Buffer.from("Content-Type: image/jpeg\r\n\r\n"),
      // Fake JPEG magic bytes + tiny payload
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const expectedHash = createHash("sha256")
      .update(multipartBody)
      .digest("hex");

    const res = await request(app)
      .post("/api/tucopramp/p2p/orders/ord_123/proof")
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .set("X-Wallet-Address", "0x81dc")
      .set("X-Wallet-Signature", "0xsig")
      .send(multipartBody);
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    // Content-Type WITH boundary passed verbatim.
    expect(call.init.headers!.get("Content-Type")).toBe(
      `multipart/form-data; boundary=${boundary}`,
    );
    // Body bytes byte-identical to what the wallet sent.
    const forwardedBody = call.init.body;
    expect(forwardedBody).toBeDefined();
    expect(forwardedBody!.equals(multipartBody)).toBe(true);
    expect(createHash("sha256").update(forwardedBody!).digest("hex")).toBe(
      expectedHash,
    );
  });

  it('T4: kill switch OFF returns 503 { code: "proxy_disabled" } without touching upstream', async () => {
    setEnv({ TUCOPRAMP_PROXY_ENABLED: "false" });
    const res = await request(app)
      .post("/api/tucopramp/p2p/orders")
      .set("X-Wallet-Address", "0x81dc")
      .send({ any: "payload" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: "proxy_disabled" });
    // Critical: zero upstream calls when disabled.
    expect(captured).toHaveLength(0);
  });

  it("T5: upstream 4xx / 5xx forwards status + body without modifying the error envelope", async () => {
    // Simulate upstream returning a canonical error envelope with a
    // request_id (backend logs but does NOT rewrite / strip it).
    const errorEnvelope = {
      code: "insufficient_liquidity",
      message: "no counterparty at this size in the current window",
      request_id: "req_upstream_abc123",
    };
    nextUpstreamResponse = {
      status: 422,
      body: Buffer.from(JSON.stringify(errorEnvelope)),
      headers: { "Content-Type": "application/json", "Retry-After": "17" },
    };
    const res = await request(app)
      .post("/api/tucopramp/p2p/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", "0x81dc")
      .send({ orderId: "ord_new" });
    expect(res.status).toBe(422);
    // Body byte-identical.
    expect(res.body).toEqual(errorEnvelope);
    // Retry-After echoed for the wallet's backoff logic.
    expect(res.headers["retry-after"]).toBe("17");
    // Content-Type passed through so the wallet parses as JSON.
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("T6: missing consumer key returns proxy_misconfigured (guard against silent-degrade)", async () => {
    setEnv({ TUCOPRAMP_CONSUMER_KEY_PROD: undefined });
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks")
      .set("X-Wallet-Address", "0x81dc");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: "proxy_misconfigured" });
    expect(captured).toHaveLength(0);
  });

  it("T7: missing upstream URL returns proxy_misconfigured", async () => {
    setEnv({ TUCOPRAMP_UPSTREAM_URL: undefined });
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks")
      .set("X-Wallet-Address", "0x81dc");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: "proxy_misconfigured" });
    expect(captured).toHaveLength(0);
  });

  it("T8: paths outside the allowlist fall through to the app 404 handler (never reach upstream)", async () => {
    // Wallet spec §2 + §7 scope the proxy to the P2P ramp plus the platform
    // API. Any other path under /api/tucopramp/* must NOT proxy: it should
    // hit the app's 404 handler so consumer-key budget is not spent on a
    // wallet mistake.
    const res = await request(app)
      .get("/api/tucopramp/admin/reset")
      .set("X-Wallet-Address", "0x81dc");
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it("T9: forwards HTTP cache-semantic response headers (Cache-Control, ETag, Last-Modified, Vary)", async () => {
    // TuCOPRamp `GET /p2p/limits` and `GET /p2p/banks`
    // emit `Cache-Control: public, max-age=<n>`. Consumers that respect
    // HTTP caching semantics need the header to serve conditional or
    // fresh responses correctly; dropping it silently forces every hit
    // to round-trip and defeats the upstream cache hint. `ETag` +
    // `Last-Modified` support conditional GET. `Vary` keeps caches
    // honest when the response differs by consumer key.
    nextUpstreamResponse = {
      status: 200,
      body: Buffer.from(
        JSON.stringify({
          min_order_cop: 100000,
          max_order_cop: 500000,
          max_daily_cop: 1000000,
          max_monthly_cop: 3000000,
        }),
      ),
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        ETag: 'W/"abc123"',
        "Last-Modified": "Wed, 02 Sep 2026 22:40:00 GMT",
        Vary: "X-TuCOPRamp-Key",
      },
    };
    const res = await request(app).get("/api/tucopramp/p2p/limits");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.headers["etag"]).toBe('W/"abc123"');
    expect(res.headers["last-modified"]).toBe("Wed, 02 Sep 2026 22:40:00 GMT");
    expect(res.headers["vary"]).toBe("X-TuCOPRamp-Key");
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("T10: cache-semantic headers absent upstream are absent downstream (no synthesis)", async () => {
    // Passthrough discipline: the proxy MUST NOT invent cache headers
    // the upstream did not emit. Otherwise a wallet-side cache could
    // incorrectly hold onto data the upstream considered dynamic.
    nextUpstreamResponse = {
      status: 200,
      body: Buffer.from('{"ok":true}'),
      headers: { "Content-Type": "application/json" },
    };
    const res = await request(app).get("/api/tucopramp/p2p/banks");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.headers["etag"]).toBeUndefined();
    expect(res.headers["last-modified"]).toBeUndefined();
    expect(res.headers["vary"]).toBeUndefined();
  });
});

describe("ALL /api/tucopramp platform routes (Bridge-backed ramp)", () => {
  it("forwards a party session request with its session header + the consumer key", async () => {
    const res = await request(app)
      .get("/api/tucopramp/parties/me")
      .set("X-TuCOPRamp-Party-Session", "tps_session_token");
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://api.ramp.tucop.xyz/parties/me");
    expect(call.init.headers!.get("X-TuCOPRamp-Party-Session")).toBe(
      "tps_session_token",
    );
    expect(call.init.headers!.get("X-TuCOPRamp-Key")).toBe(
      "tcr_prod_test_key_cafebabe",
    );
  });

  it("does not forward TuCOPRamp-Version (upstream reads no version header)", async () => {
    // Upstream serves a single API version and reads no version header; its
    // own OpenAPI marks the response header deprecated. Forwarding it
    // suggested a pinning behaviour that never existed.
    const res = await request(app)
      .get("/api/tucopramp/withdrawals/wdr_1")
      .set("X-TuCOPRamp-Party-Session", "tps_session_token")
      .set("TuCOPRamp-Version", "2026-10-08");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.get("TuCOPRamp-Version")).toBeNull();
  });

  it.each([
    ["POST", "/sessions/wallet/nonce"],
    ["POST", "/sessions/wallet"],
    ["POST", "/parties"],
    ["GET", "/destinations"],
    ["POST", "/destinations/dst_1/confirm"],
    ["POST", "/quotes"],
    ["GET", "/payments/op_1"],
    ["POST", "/withdrawals"],
    ["GET", "/deposits/dep_1"],
  ])("%s %s reaches upstream at the same path", async (method, path) => {
    const verb = method.toLowerCase() as "get" | "post";
    const call = request(app)[verb](`/api/tucopramp${path}`);
    const req = call.set("X-TuCOPRamp-Party-Session", "tps_session_token");
    const res =
      method === "POST"
        ? await req.set("Content-Type", "application/json").send("{}")
        : await req;
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(`https://api.ramp.tucop.xyz${path}`);
    expect(captured[0]!.init.method).toBe(method);
  });

  it.each([
    ["POST", "/parties"],
    ["GET", "/parties/me"],
    ["GET", "/destinations"],
    ["POST", "/quotes"],
    ["POST", "/payments"],
    ["GET", "/withdrawals/wdr_1"],
    ["POST", "/deposits"],
  ])(
    "%s %s without a party session never reaches upstream with the consumer key",
    async (method, path) => {
      const req = request(app)[method.toLowerCase() as "get" | "post"](
        `/api/tucopramp${path}`,
      );
      const res =
        method === "POST"
          ? await req.set("Content-Type", "application/json").send("{}")
          : await req;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("party_session_required");
      expect(captured).toHaveLength(0);
    },
  );

  it("revokes a party session through DELETE /sessions/current", async () => {
    const res = await request(app)
      .delete("/api/tucopramp/sessions/current")
      .set("X-TuCOPRamp-Party-Session", "tps_session_token");
    expect(res.status).toBe(200);
    expect(captured[0]!.url).toBe(
      "https://api.ramp.tucop.xyz/sessions/current",
    );
    expect(captured[0]!.init.method).toBe("DELETE");
    expect(captured[0]!.init.headers!.get("X-TuCOPRamp-Party-Session")).toBe(
      "tps_session_token",
    );
  });

  it.each([
    "/admin/orders",
    "/consumers/me",
    "/events",
    "/prereg/status",
    "/partiesx",
    "/rates",
  ])("%s is not proxied", async (path) => {
    const res = await request(app).get(`/api/tucopramp${path}`);
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });
});

describe("ALL /api/tucopramp/v1/* (retired version prefix)", () => {
  it.each([
    "/v1/p2p/banks",
    "/v1/p2p/onramp/orders",
    "/v1/sessions/wallet",
    "/v1/parties/me",
  ])("%s answers 410 without touching upstream", async (path) => {
    // Upstream deleted its /v1 alias, so forwarding would spend consumer-key
    // budget on a guaranteed 404. 410 names the real problem instead: the
    // caller is a build from before the paths lost their version.
    const res = await request(app).get(`/api/tucopramp${path}`);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ code: "versioned_path_removed" });
    expect(captured).toHaveLength(0);
  });

  it("answers 410 on the bare /v1 path", async () => {
    const res = await request(app).get("/api/tucopramp/v1");
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ code: "versioned_path_removed" });
    expect(captured).toHaveLength(0);
  });

  it("answers 410 on a POST too, body and all", async () => {
    const res = await request(app)
      .post("/api/tucopramp/v1/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .send('{"wallet_address":"0x1111111111111111111111111111111111111111"}');
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ code: "versioned_path_removed" });
    expect(captured).toHaveLength(0);
  });

  it("answers 410 even with the kill switch OFF", async () => {
    // An old client deserves the same clear signal whether or not the ramp
    // is up; the answer does not depend on the switch.
    setEnv({ TUCOPRAMP_PROXY_ENABLED: "false" });
    const res = await request(app).get("/api/tucopramp/v1/p2p/banks");
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ code: "versioned_path_removed" });
    expect(captured).toHaveLength(0);
  });

  it("leaves /v10 alone: only the exact /v1 segment is retired", async () => {
    const res = await request(app).get("/api/tucopramp/v10/p2p/banks");
    expect(res.status).toBe(404);
    expect(res.body).not.toEqual({ code: "versioned_path_removed" });
    expect(captured).toHaveLength(0);
  });
});

describe("upstream prefix allowlist (unversioned)", () => {
  it.each([
    ["/p2p/banks", false],
    ["/sessions/wallet/nonce", true],
    ["/parties/me", true],
    ["/destinations", true],
    ["/quotes/qt_1", true],
    ["/payments/op_1", true],
    ["/withdrawals/wdr_1", true],
    ["/deposits/dep_1", true],
    ["/document-types", false],
  ] as ReadonlyArray<[string, boolean]>)(
    "%s forwards to upstream at the same path",
    async (path, needsSession) => {
      const call = request(app).get(`/api/tucopramp${path}`);
      const res = needsSession
        ? await call.set("X-TuCOPRamp-Party-Session", "tps_session_token")
        : await call;
      expect(res.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe(`https://api.ramp.tucop.xyz${path}`);
    },
  );
});

describe("X-TuCOPRamp-Client-IP", () => {
  it("forwards the end-user address on a p2p route", async () => {
    // Upstream treats this backend as a trusted relay and keys its per-IP
    // limits on this header; without it every user shares one bucket.
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks")
      .set("X-Forwarded-For", "8.8.8.8");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.get("X-TuCOPRamp-Client-IP")).toBe(
      "8.8.8.8",
    );
  });

  it("forwards it on platform routes too, not just the session ones", async () => {
    const res = await request(app)
      .get("/api/tucopramp/withdrawals/wdr_1")
      .set("X-TuCOPRamp-Party-Session", "tps_session_token")
      .set("X-Forwarded-For", "1.1.1.1");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.get("X-TuCOPRamp-Client-IP")).toBe(
      "1.1.1.1",
    );
  });

  it("forwards it on a POST as well", async () => {
    const res = await request(app)
      .post("/api/tucopramp/p2p/orders/ord_1/cancel")
      .set("Content-Type", "application/json")
      .set("X-Forwarded-For", "8.8.8.8")
      .send("{}");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.get("X-TuCOPRamp-Client-IP")).toBe(
      "8.8.8.8",
    );
  });

  it.each(["10.0.0.5", "192.168.1.9", "127.0.0.1", "169.254.1.1"])(
    "sends no header when the resolved address is private (%s)",
    async (ip) => {
      // A private address collides distinct users into one bucket AND tells
      // upstream something false, which is worse than saying nothing.
      const res = await request(app)
        .get("/api/tucopramp/p2p/banks")
        .set("X-Forwarded-For", ip);
      expect(res.status).toBe(200);
      expect(
        captured[0]!.init.headers!.has("X-TuCOPRamp-Client-IP"),
      ).toBe(false);
    },
  );

  it("sends no header when the resolved address is malformed", async () => {
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks")
      .set("X-Forwarded-For", "not-an-ip");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.has("X-TuCOPRamp-Client-IP")).toBe(false);
  });

  it("sends no header for a loopback connection with no forwarded address", async () => {
    const res = await request(app).get("/api/tucopramp/p2p/banks");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.has("X-TuCOPRamp-Client-IP")).toBe(false);
  });

  it("never forwards a client-supplied X-TuCOPRamp-Client-IP", async () => {
    // The whole attack: upstream trusts this relay's word on the header, so a
    // client that could set it would scatter its traffic over made-up
    // addresses. The value must come from the connection, never from the
    // request.
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks")
      .set("X-TuCOPRamp-Client-IP", "203.0.113.7")
      .set("X-Forwarded-For", "8.8.8.8");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.get("X-TuCOPRamp-Client-IP")).toBe(
      "8.8.8.8",
    );
  });

  it("drops a spoofed header entirely when the connection yields no public address", async () => {
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks")
      .set("X-TuCOPRamp-Client-IP", "203.0.113.7");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.has("X-TuCOPRamp-Client-IP")).toBe(false);
  });

  it("never forwards the caller's X-Forwarded-For", async () => {
    const res = await request(app)
      .get("/api/tucopramp/p2p/banks")
      .set("X-Forwarded-For", "8.8.8.8");
    expect(res.status).toBe(200);
    expect(captured[0]!.init.headers!.has("X-Forwarded-For")).toBe(false);
  });
});

describe("GET /p2p/onramp/orders (consumer-wide listing)", () => {
  it("is blocked backend-side with a 404 and never reaches upstream", async () => {
    // The upstream route lists EVERY on-ramp order of the whole consumer,
    // across all wallets, and takes no wallet filter. Exposing it to a client
    // is third-party data disclosure.
    const res = await request(app)
      .get("/api/tucopramp/p2p/onramp/orders")
      .set("X-Wallet-Address", "0x1111111111111111111111111111111111111111");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found" });
    expect(captured).toHaveLength(0);
  });

  it("stays blocked with a trailing slash", async () => {
    // Upstream routes with `strict routing` off, so `/orders/` is answered as
    // `/orders`. A raw path comparison would wave this straight through.
    const res = await request(app).get("/api/tucopramp/p2p/onramp/orders/");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found" });
    expect(captured).toHaveLength(0);
  });

  it("stays blocked with a query string", async () => {
    const res = await request(app).get(
      "/api/tucopramp/p2p/onramp/orders?wallet_address=0x1111111111111111111111111111111111111111",
    );
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it("does not block the wallet-scoped GET /p2p/orders", async () => {
    const res = await request(app).get("/api/tucopramp/p2p/orders");
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.ramp.tucop.xyz/p2p/orders");
  });

  it("does not block GET /p2p/onramp/receiving-account", async () => {
    const res = await request(app).get(
      "/api/tucopramp/p2p/onramp/receiving-account",
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });
});

describe("POST /p2p/onramp/orders destination", () => {
  const SIGNER = "0x1111111111111111111111111111111111111111";
  const OTHER = "0x2222222222222222222222222222222222222222";

  it("forwards when the destination is the signing wallet", async () => {
    // Sent as a string, not a Buffer: superagent JSON-serialises a Buffer
    // under an application/json Content-Type, which would rewrite the bytes
    // before they ever reach the proxy.
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .set("X-Wallet-Signature", "0xsig")
      .send(`{"wallet_address":"${SIGNER}", "gross_amount_cop":50000 }\n`);
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("forwards the body byte-identically despite parsing it to validate", async () => {
    // The destination check parses a COPY. If it ever re-serialised the body,
    // the EIP-191 signature would break upstream -- the same invariant T2 and
    // T3 protect, asserted here on the one route that now reads the body.
    // Intentionally non-canonical JSON (space after colon, space before the
    // comma, trailing newline): if anything round-tripped the body through
    // JSON.parse + stringify, these bytes would not survive.
    const payloadString = `{"wallet_address":"${SIGNER}", "gross_amount_cop":50000 ,"cedula":"123"}\n`;
    const payload = Buffer.from(payloadString);
    const expectedHash = createHash("sha256").update(payload).digest("hex");

    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send(payloadString);
    expect(res.status).toBe(200);
    const forwardedBody = captured[0]!.init.body;
    expect(forwardedBody).toBeDefined();
    expect(createHash("sha256").update(forwardedBody!).digest("hex")).toBe(
      expectedHash,
    );
    expect(forwardedBody!.equals(payload)).toBe(true);
  });

  it("rejects a destination that is not the signer, without touching upstream", async () => {
    // Upstream deliberately does not compare the two: on-ramping to someone
    // else's wallet is a case it supports. Our product does not offer it.
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send(`{"wallet_address":"${OTHER}"}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("onramp_destination_mismatch");
    expect(captured).toHaveLength(0);
  });

  it("compares addresses case-insensitively", async () => {
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", "0x1111111111111111111111111111111111111111")
      .send('{"wallet_address":"0x1111111111111111111111111111111111111111"}');
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("accepts a checksummed header against a lowercase body", async () => {
    const checksummed = "0xAbC1111111111111111111111111111111111111";
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", checksummed)
      .send(`{"wallet_address":"${checksummed.toLowerCase()}"}`);
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("rejects a non-JSON body with 400 invalid_json", async () => {
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send("not json at all");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: "invalid_json" });
    expect(captured).toHaveLength(0);
  });

  it("rejects a request with no X-Wallet-Address", async () => {
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .send(`{"wallet_address":"${SIGNER}"}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("onramp_destination_mismatch");
    expect(captured).toHaveLength(0);
  });

  it("rejects a body with no wallet_address", async () => {
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send('{"gross_amount_cop":50000}');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("onramp_destination_mismatch");
    expect(captured).toHaveLength(0);
  });

  it("rejects a non-string wallet_address instead of throwing", async () => {
    // A crafted body must not turn into a 500 inside the gate.
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send('{"wallet_address":12345}');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("onramp_destination_mismatch");
    expect(captured).toHaveLength(0);
  });

  it("enforces the check on the trailing-slash form too", async () => {
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/orders/")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send(`{"wallet_address":"${OTHER}"}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("onramp_destination_mismatch");
    expect(captured).toHaveLength(0);
  });

  it("leaves POST /p2p/offramp/orders alone", async () => {
    // The off-ramp sends COPm FROM the signer; there is no destination wallet
    // to compare, and the gate must not touch it.
    const res = await request(app)
      .post("/api/tucopramp/p2p/offramp/orders")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send('{"gross_amount_copm":"50000"}');
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("leaves POST /p2p/onramp/quote alone", async () => {
    const res = await request(app)
      .post("/api/tucopramp/p2p/onramp/quote")
      .set("Content-Type", "application/json")
      .set("X-Wallet-Address", SIGNER)
      .send('{"gross_amount_cop":50000,"cedula":"123"}');
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });
});

describe("GET /document-types", () => {
  it("forwards on the consumer key alone, with no party session", async () => {
    // Upstream serves this catalogue behind the key only. Requiring a party
    // session here would make it unreachable before a session exists, which
    // is exactly when the wallet needs it to render the document picker.
    const res = await request(app).get("/api/tucopramp/document-types");
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.ramp.tucop.xyz/document-types");
    expect(captured[0]!.init.headers!.get("X-TuCOPRamp-Key")).toBe(
      "tcr_prod_test_key_cafebabe",
    );
  });

  it("forwards a country query string byte-identically", async () => {
    const res = await request(app).get("/api/tucopramp/document-types?country=CO");
    expect(res.status).toBe(200);
    expect(captured[0]!.url).toBe(
      "https://api.ramp.tucop.xyz/document-types?country=CO",
    );
  });

  it("passes upstream cache headers through so the wallet can cache it", async () => {
    nextUpstreamResponse = {
      status: 200,
      body: Buffer.from('{"document_types":[{"code":"CC"}]}'),
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        ETag: 'W/"doctypes-1"',
      },
    };
    const res = await request(app).get("/api/tucopramp/document-types");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.headers["etag"]).toBe('W/"doctypes-1"');
  });
});
