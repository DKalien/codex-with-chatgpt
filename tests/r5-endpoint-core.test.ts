import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EndpointSchemaError,
  PluginRegistryError,
  assertDeliveryTargetMatchesBinding,
  assertSendTargetImmutable,
  assertTrustedEvidenceAllowed,
  createExecutorBinding,
  createExecutorPluginRegistry,
  createPluginRegistry,
  createWebSinkBinding,
  freezeExecutorDeliveryTarget,
  freezeWebSinkSendTarget,
  parseExecutorBinding,
  parseExecutorBindingCandidate,
  parseExecutorDeliveryAcceptance,
  parseExecutorExecutionEvidence,
  parseExecutorPluginDescriptor,
  parseWebSinkBinding,
  parseWebSinkSendTargetSnapshot,
  validateExecutorPlugin,
  type ExecutorDeliveryAcceptance,
  type ExecutorDeliveryRequest,
  type ExecutorExecutionEvidence,
  type ExecutorPlugin,
  type ExecutorPluginCapabilities,
  type ExecutorPluginDescriptor,
  type ExecutorBinding,
  type ExecutorBindingCandidate,
  type ExecutorDeliveryTargetSnapshot,
  type WebSinkBinding,
} from "../src/endpoints/index.js";
import {
  CODEX_DESKTOP_EXECUTOR_ID,
  CodexDesktopAdapter,
  CodexDesktopExecutorPlugin,
  CodexTargetTranslationError,
  codexDesktopAdapter,
  codexDesktopExecutorPlugin,
  createExecutorRegistry,
  executorRegistry,
  getExecutor,
  projectCodexDesktopTargetToExecutorBindingCandidate,
  type ExecutorCapabilities,
  type ExecutorConnection,
  type ExecutorDescriptor,
  type ExecutorTarget,
} from "../src/executor/index.js";
import { updateDesktop } from "../src/desktop/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const workspaceId = "2582910bf0d2";
const workspaceRoot = "D:\\python\\codex-with-chatgpt";
const instant = "2026-09-29T00:00:00.000Z";
const runtimeFence = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

function validCandidate(overrides: Partial<ExecutorBindingCandidate> = {}): ExecutorBindingCandidate {
  return parseExecutorBindingCandidate({
    pluginId: "plugin-alpha",
    workspaceId,
    workspaceRoot,
    instanceId: "instance.1",
    sessionId: "session-abc_123",
    locator: { token: "value-1" },
    ...overrides,
  });
}

function validExecutorBinding(overrides: Partial<ExecutorBinding> = {}): ExecutorBinding {
  return createExecutorBinding(validCandidate({ pluginId: overrides.pluginId ?? "plugin-alpha" }), {
    bindingId: overrides.bindingId ?? "exec-binding-1",
    epoch: overrides.epoch ?? 3,
    boundAt: overrides.boundAt ?? instant,
  });
}

function validWebSinkBinding(overrides: Partial<WebSinkBinding> = {}): WebSinkBinding {
  return createWebSinkBinding(
    {
      pluginId: overrides.pluginId ?? "surface-alpha",
      surfaceId: overrides.surfaceId ?? "surface-alpha",
      workspaceId: overrides.workspaceId ?? workspaceId,
      canonicalUrl: overrides.canonicalUrl ?? "https://example.com/path",
    },
    {
      bindingId: overrides.bindingId ?? "sink-binding-1",
      epoch: overrides.epoch ?? 2,
      boundAt: overrides.boundAt ?? instant,
    },
  );
}

const boundedCapabilities = (overrides: Partial<ExecutorPluginCapabilities> = {}): ExecutorPluginCapabilities => ({
  bindExistingSession: true,
  createSession: true,
  delivery: true,
  activeExecutionInspection: true,
  approvalVisibility: true,
  trustedTerminalReceipt: false,
  cancellationInterrupt: true,
  resume: false,
  ...overrides,
});

function fakePlugin(id: string, capabilities = boundedCapabilities()): ExecutorPlugin {
  const descriptor = parseExecutorPluginDescriptor({
    pluginId: id,
    kind: "fake",
    name: `Fake ${id}`,
    capabilities,
  });
  const candidate = validCandidate({ pluginId: id, sessionId: `sess_${id}` });
  return {
    descriptor,
    async discoverCurrent() {
      return candidate;
    },
    async inspectSession() {
      return { sessionId: candidate.sessionId, instanceId: candidate.instanceId, locator: candidate.locator };
    },
    async deliver() {
      return { status: "accepted", deliveryId: `deliv_${id}` };
    },
  };
}

describe("R5a generic endpoint schema", () => {
  it("creates binding only via Bridge stamp over plugin candidate", () => {
    const candidate = validCandidate();
    expect("bindingId" in candidate).toBe(false);
    expect("epoch" in candidate).toBe(false);
    expect("boundAt" in candidate).toBe(false);
    const binding = createExecutorBinding(candidate, {
      bindingId: "bridge-bind-1",
      epoch: 7,
      boundAt: instant,
    });
    expect(binding.bindingId).toBe("bridge-bind-1");
    expect(binding.epoch).toBe(7);
    expect(binding.sessionId).toBe(candidate.sessionId);
    expect(Object.keys(binding).sort()).toEqual([
      "bindingId",
      "boundAt",
      "epoch",
      "instanceId",
      "locator",
      "pluginId",
      "sessionId",
      "version",
      "workspaceId",
      "workspaceRoot",
    ]);
  });

  it("rejects invalid workspace id and non-absolute workspace root", () => {
    expect(() => validCandidate({ workspaceId: "NOTHEX!!" })).toThrow(EndpointSchemaError);
    expect(() => validCandidate({ workspaceId: "abc" })).toThrow(EndpointSchemaError);
    expect(() => validCandidate({ workspaceRoot: "relative/path" })).toThrow(EndpointSchemaError);
    expect(() => validCandidate({ workspaceRoot: "" })).toThrow(EndpointSchemaError);
  });

  it("rejects overlong locator values and excessive locator keys", () => {
    expect(() => validCandidate({ locator: { k: "x".repeat(257) } })).toThrow(EndpointSchemaError);
    const tooMany: Record<string, string> = {};
    for (let index = 0; index < 9; index += 1) tooMany[`k${index}`] = "v";
    expect(() => validCandidate({ locator: tooMany })).toThrow(EndpointSchemaError);
  });

  it("rejects invalid epoch values at stamp time", () => {
    const candidate = validCandidate();
    expect(() => createExecutorBinding(candidate, { bindingId: "b1", epoch: 0, boundAt: instant })).toThrow(EndpointSchemaError);
    expect(() => createExecutorBinding(candidate, { bindingId: "b1", epoch: -1, boundAt: instant })).toThrow(EndpointSchemaError);
    expect(() => createExecutorBinding(candidate, { bindingId: "b1", epoch: 1.5, boundAt: instant })).toThrow(EndpointSchemaError);
  });

  it("round-trips generic executor binding through freeze/parse", () => {
    const binding = validExecutorBinding();
    const snapshot = freezeExecutorDeliveryTarget(binding, instant);
    expect(snapshot.sessionId).toBe(binding.sessionId);
    expect(snapshot.frozenAt).toBe(instant);
    const again = parseExecutorBinding(JSON.parse(JSON.stringify(binding)));
    expect(again).toEqual(binding);
  });

  it("accepts non-UUID opaque sessionId/instanceId", () => {
    const binding = validExecutorBinding();
    const candidate = validCandidate({
      sessionId: "my.local.session::42",
      instanceId: "host_instance-9",
    });
    const stamped = createExecutorBinding(candidate, { bindingId: "b-x", epoch: 1, boundAt: instant });
    expect(stamped.sessionId).toBe("my.local.session::42");
    expect(stamped.instanceId).toBe("host_instance-9");
    expect(binding.sessionId).toBe("session-abc_123");
  });

  it("parses generic web sink HTTPS URL and rejects unsafe/non-http URLs", () => {
    const binding = validWebSinkBinding();
    expect(binding.canonicalUrl).toBe("https://example.com/path");
    expect(() => validWebSinkBinding({ canonicalUrl: "http://example.com" })).toThrow(EndpointSchemaError);
    expect(() => validWebSinkBinding({ canonicalUrl: "javascript:alert(1)" })).toThrow(EndpointSchemaError);
    expect(() => validWebSinkBinding({ canonicalUrl: "file:///etc/passwd" })).toThrow(EndpointSchemaError);
    expect(() => validWebSinkBinding({ canonicalUrl: "data:text/html,hi" })).toThrow(EndpointSchemaError);
    expect(() => validWebSinkBinding({ canonicalUrl: "https://" })).toThrow(EndpointSchemaError);
    expect(() => validWebSinkBinding({ canonicalUrl: `https://example.com/${"a".repeat(2100)}` })).toThrow(EndpointSchemaError);
  });

  it("keeps web sink and executor schemas without shared product identity fields", () => {
    const sinkKeys = Object.keys(validWebSinkBinding());
    const execKeys = Object.keys(validExecutorBinding());
    expect(sinkKeys).not.toContain("sessionId");
    expect(sinkKeys).not.toContain("instanceId");
    expect(sinkKeys).not.toContain("locator");
    expect(execKeys).not.toContain("canonicalUrl");
    expect(execKeys).not.toContain("surfaceId");
  });

  it("freezes web sink send target including workspaceId and detects mutation", () => {
    const binding = validWebSinkBinding();
    const snapshot = freezeWebSinkSendTarget(binding, instant);
    expect(snapshot.workspaceId).toBe(workspaceId);
    const roundTrip = parseWebSinkSendTargetSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(roundTrip).toEqual(snapshot);

    const expected = {
      bindingId: binding.bindingId,
      pluginId: binding.pluginId,
      surfaceId: binding.surfaceId,
      workspaceId: binding.workspaceId,
      canonicalUrl: binding.canonicalUrl,
      epoch: binding.epoch,
    };
    expect(() =>
      assertSendTargetImmutable(
        { attemptId: "a1", target: { ...snapshot, pluginId: "other-plugin" }, reservedAt: instant, begunAt: instant },
        expected,
      ),
    ).toThrow(/begin-send 后被改变/);
    expect(() =>
      assertSendTargetImmutable(
        { attemptId: "a1", target: { ...snapshot, surfaceId: "other-surface" }, reservedAt: instant, begunAt: instant },
        expected,
      ),
    ).toThrow(/begin-send 后被改变/);
    expect(() =>
      assertSendTargetImmutable(
        { attemptId: "a1", target: { ...snapshot, workspaceId: "aaaaaaaaaaaa" }, reservedAt: instant, begunAt: instant },
        expected,
      ),
    ).toThrow(/begin-send 后被改变/);
    expect(() =>
      assertSendTargetImmutable(
        { attemptId: "a1", target: { ...snapshot, canonicalUrl: "https://other.example/" }, reservedAt: instant, begunAt: instant },
        expected,
      ),
    ).toThrow(/begin-send 后被改变/);
    expect(() =>
      assertSendTargetImmutable(
        { attemptId: "a1", target: { ...snapshot, epoch: snapshot.epoch + 1 }, reservedAt: instant, begunAt: instant },
        expected,
      ),
    ).toThrow(/begin-send 后被改变/);
    expect(() =>
      assertSendTargetImmutable(
        { attemptId: "a1", target: snapshot, reservedAt: instant, begunAt: instant },
        expected,
      ),
    ).not.toThrow();
  });

  it("rejects unknown extra fields (fail closed)", () => {
    expect(() =>
      parseExecutorBinding({
        ...validExecutorBinding(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        threadId: "should-fail",
      } as any),
    ).toThrow(EndpointSchemaError);
  });
});

describe("R5a generic plugin registry", () => {
  it("rejects duplicate plugin registration", () => {
    expect(() => createPluginRegistry([fakePlugin("p1"), fakePlugin("p1")])).toThrow(PluginRegistryError);
  });

  it("rejects unknown plugin lookup", () => {
    const registry = createPluginRegistry([fakePlugin("p1")]);
    expect(() => registry.get("nope")).toThrow(PluginRegistryError);
    expect(registry.has("nope")).toBe(false);
    expect(registry.ids()).toEqual(["p1"]);
  });

  it("rejects invalid plugin IDs at runtime", () => {
    expect(() => createPluginRegistry([{ pluginId: "has space" }])).toThrow(/PLUGIN_ID_INVALID|safe ID/);
    expect(() => createPluginRegistry([{ pluginId: "bad/slash" }])).toThrow(/PLUGIN_ID_INVALID|safe ID/);
    expect(() => createPluginRegistry([{ pluginId: "x".repeat(129) }])).toThrow(/PLUGIN_ID_INVALID|safe ID/);
    expect(() => createPluginRegistry([{ pluginId: "" }])).toThrow(/PLUGIN_ID_INVALID|safe ID/);
  });

  it("accepts a fake second executor plugin in an isolated test registry", () => {
    const registry = createPluginRegistry([fakePlugin("alpha"), fakePlugin("beta")]);
    expect(registry.get("beta").descriptor.pluginId).toBe("beta");
    expect(registry.list()).toHaveLength(2);
  });

  it("does not infer capabilities from plugin name", () => {
    const named = fakePlugin("trusted-looking-name", boundedCapabilities({ trustedTerminalReceipt: false }));
    expect(named.descriptor.capabilities.trustedTerminalReceipt).toBe(false);
    const registry = createPluginRegistry([named]);
    expect(registry.get("trusted-looking-name").descriptor.capabilities.trustedTerminalReceipt).toBe(false);
  });

  it("validates descriptor pluginId consistency", () => {
    expect(() =>
      createPluginRegistry([{ pluginId: "alpha", descriptor: { pluginId: "beta" } }]),
    ).toThrow(/PLUGIN_ID_INVALID|不一致/);
  });

  it("allows trustedTerminalReceipt capability to be false and enforces evidence boundary", () => {
    const plugin = fakePlugin("no-trust", boundedCapabilities({ trustedTerminalReceipt: false }));
    const evidence: ExecutorExecutionEvidence[] = [
      { evidenceId: "e1", pluginId: "no-trust", kind: "terminal", createdAt: instant, trusted: true },
    ];
    expect(() => assertTrustedEvidenceAllowed(plugin.descriptor, evidence)).toThrow(/trustedTerminalReceipt/);
    expect(() =>
      assertTrustedEvidenceAllowed(plugin.descriptor, [
        { evidenceId: "e2", pluginId: "no-trust", kind: "terminal", createdAt: instant, trusted: false },
      ]),
    ).not.toThrow();
  });

  it("rejects wrong pluginId even for trusted-capable descriptor", () => {
    const plugin = fakePlugin("trust-capable", boundedCapabilities({ trustedTerminalReceipt: true }));
    expect(() =>
      assertTrustedEvidenceAllowed(plugin.descriptor, [
        { evidenceId: "e1", pluginId: "other-plugin", kind: "terminal", createdAt: instant, trusted: true },
      ]),
    ).toThrow(/不一致/);
  });

  it("rejects malformed runtime descriptors before accepting trusted evidence", () => {
    const goodEvidence = [
      { evidenceId: "e1", pluginId: "p1", kind: "terminal", createdAt: instant, trusted: true },
    ];
    // trustedTerminalReceipt: "yes"（非 boolean）
    expect(() =>
      assertTrustedEvidenceAllowed(
        {
          pluginId: "p1",
          kind: "fake",
          name: "P1",
          capabilities: { ...boundedCapabilities({ trustedTerminalReceipt: true }), trustedTerminalReceipt: "yes" },
        },
        goodEvidence,
      ),
    ).toThrow();
    // missing capability
    expect(() =>
      assertTrustedEvidenceAllowed(
        {
          pluginId: "p1",
          kind: "fake",
          name: "P1",
          capabilities: {
            bindExistingSession: true,
            createSession: true,
            delivery: true,
            activeExecutionInspection: true,
            approvalVisibility: true,
            cancellationInterrupt: true,
            resume: false,
          },
        },
        goodEvidence,
      ),
    ).toThrow();
    // invalid pluginId
    expect(() =>
      assertTrustedEvidenceAllowed(
        {
          pluginId: "bad id",
          kind: "fake",
          name: "P1",
          capabilities: boundedCapabilities({ trustedTerminalReceipt: true }),
        },
        [{ evidenceId: "e1", pluginId: "bad id", kind: "terminal", createdAt: instant, trusted: true }],
      ),
    ).toThrow();
  });

  it("rejects overlong detail and malformed timestamp", () => {
    expect(() =>
      parseExecutorExecutionEvidence({
        evidenceId: "e1",
        pluginId: "p1",
        kind: "terminal",
        createdAt: instant,
        trusted: false,
        detail: "x".repeat(1025),
      }),
    ).toThrow(EndpointSchemaError);
    expect(() =>
      parseExecutorExecutionEvidence({
        evidenceId: "e1",
        pluginId: "p1",
        kind: "terminal",
        createdAt: "not-a-timestamp",
        trusted: false,
      }),
    ).toThrow(EndpointSchemaError);
  });
});

describe("R5a executor plugin registration trust gate", () => {
  it("rejects malformed descriptor at registration", () => {
    expect(() =>
      createExecutorPluginRegistry([
        {
          descriptor: {
            pluginId: "p1",
            kind: "fake",
            name: "P1",
            capabilities: { ...boundedCapabilities(), trustedTerminalReceipt: "yes" },
          },
          discoverCurrent: async () => validCandidate({ pluginId: "p1" }),
          inspectSession: async () => ({ sessionId: "s", instanceId: "i", locator: {} }),
          deliver: async () => ({ status: "accepted", deliveryId: "d1" }),
        },
      ]),
    ).toThrow();
  });

  it("rejects missing deliver/discoverCurrent/inspectSession", () => {
    const base = {
      descriptor: parseExecutorPluginDescriptor({
        pluginId: "p1",
        kind: "fake",
        name: "P1",
        capabilities: boundedCapabilities(),
      }),
    };
    expect(() =>
      validateExecutorPlugin({
        ...base,
        discoverCurrent: async () => validCandidate({ pluginId: "p1" }),
        inspectSession: async () => ({ sessionId: "s", instanceId: "i", locator: {} }),
      }),
    ).toThrow(/deliver/);
    expect(() =>
      validateExecutorPlugin({
        ...base,
        inspectSession: async () => ({ sessionId: "s", instanceId: "i", locator: {} }),
        deliver: async () => ({ status: "accepted", deliveryId: "d1" }),
      }),
    ).toThrow(/discoverCurrent/);
    expect(() =>
      validateExecutorPlugin({
        ...base,
        discoverCurrent: async () => validCandidate({ pluginId: "p1" }),
        deliver: async () => ({ status: "accepted", deliveryId: "d1" }),
      }),
    ).toThrow(/inspectSession/);
  });

  it("accepts valid fake executor and does not infer capability from name", () => {
    const registry = createExecutorPluginRegistry([
      fakePlugin("trusted-looking-name", boundedCapabilities({ trustedTerminalReceipt: false })),
      fakePlugin("beta"),
    ]);
    expect(registry.get("trusted-looking-name").descriptor.capabilities.trustedTerminalReceipt).toBe(false);
    expect(registry.get("beta").descriptor.pluginId).toBe("beta");
    expect(registry.ids().sort()).toEqual(["beta", "trusted-looking-name"]);
  });
});

describe("R5a delivery snapshot immutability", () => {
  it("rejects delivery when any frozen identity field drifts", () => {
    const binding = validExecutorBinding();
    const snapshot = freezeExecutorDeliveryTarget(binding, instant);
    const request: ExecutorDeliveryRequest = {
      request: "req-1",
      target: snapshot,
      payload: "hello",
    };
    expect(() => assertDeliveryTargetMatchesBinding(request, binding)).not.toThrow();

    expect(() =>
      assertDeliveryTargetMatchesBinding(
        { ...request, target: { ...snapshot, sessionId: "other-session" } },
        binding,
      ),
    ).toThrow(/不一致/);
    expect(() =>
      assertDeliveryTargetMatchesBinding(
        { ...request, target: { ...snapshot, epoch: snapshot.epoch + 1 } },
        binding,
      ),
    ).toThrow(/不一致/);
    expect(() =>
      assertDeliveryTargetMatchesBinding(
        { ...request, target: { ...snapshot, workspaceRoot: "D:\\other\\root" } },
        binding,
      ),
    ).toThrow(/不一致/);
    expect(() =>
      assertDeliveryTargetMatchesBinding(
        { ...request, target: { ...snapshot, locator: { token: "changed" } } },
        binding,
      ),
    ).toThrow(/不一致/);
    expect(() =>
      assertDeliveryTargetMatchesBinding(
        { ...request, target: { ...snapshot, locator: { extra: "v", token: "value-1" } } },
        binding,
      ),
    ).toThrow(/不一致/);
    expect(() =>
      assertDeliveryTargetMatchesBinding(
        { ...request, target: { ...snapshot, bindingId: "other-binding" } },
        binding,
      ),
    ).toThrow(/不一致/);
  });
});

describe("R5a delivery acceptance contract", () => {
  it("accepts non-UUID bounded delivery IDs and rejects malformed acceptance", () => {
    const accepted = parseExecutorDeliveryAcceptance({ status: "accepted", deliveryId: "local.exec-42:abc" });
    expect(accepted).toEqual({ status: "accepted", deliveryId: "local.exec-42:abc" });
    expect(() => parseExecutorDeliveryAcceptance({ status: "accepted" })).toThrow();
    expect(() => parseExecutorDeliveryAcceptance({ status: "accepted", deliveryId: "" })).toThrow();
    expect(() =>
      parseExecutorDeliveryAcceptance({ status: "rejected", reasonCode: "ok reason" }),
    ).toThrow();
    const rejected = parseExecutorDeliveryAcceptance({
      status: "rejected",
      reasonCode: "session_mismatch",
      reason: "returned session identity does not match",
    });
    expect(rejected.status).toBe("rejected");
  });
});

describe("R5a Codex Desktop adapter compatibility", () => {
  const target: ExecutorTarget = {
    threadId: "01a0d6cd-09f3-73e3-9726-4bd65df196d3",
    hostId: "local",
    projectId: "e6c3c73a-44fe-4254-bda9-edfc5ddb6389",
    workspaceRoot,
  };

  it("retains existing executor adapter APIs", () => {
    expect(CODEX_DESKTOP_EXECUTOR_ID).toBe("codex-desktop");
    expect(codexDesktopAdapter).toBeInstanceOf(CodexDesktopAdapter);
    expect(getExecutor()).toBe(codexDesktopAdapter);
    expect(getExecutor("codex-desktop")).toBe(codexDesktopAdapter);
    expect(executorRegistry.get("codex-desktop")).toBe(codexDesktopAdapter);
    expect(() => executorRegistry.get("missing")).toThrow();
    const registry = createExecutorRegistry();
    expect(registry.list().map((d: ExecutorDescriptor) => d.id)).toEqual(["codex-desktop"]);
    const capabilities: ExecutorCapabilities = codexDesktopAdapter.descriptor.capabilities;
    expect(capabilities.trustedTerminalReceipt).toBe(true);
    expect(typeof codexDesktopAdapter.inspect).toBe("function");
    expect(typeof codexDesktopAdapter.currentIdentity).toBe("function");
    expect(typeof codexDesktopAdapter.confirmCurrent).toBe("function");
    expect(typeof codexDesktopAdapter.prepare).toBe("function");
    expect(typeof codexDesktopAdapter.inspectActiveExecution).toBe("function");
  });

  it("projects Codex Desktop target into generic candidate without Bridge binding metadata", () => {
    const candidate = projectCodexDesktopTargetToExecutorBindingCandidate({
      target,
      workspaceId,
      instanceId: "local-host-1",
    });
    expect(candidate).toEqual({
      pluginId: "codex-desktop",
      workspaceId,
      workspaceRoot,
      instanceId: "local-host-1",
      sessionId: target.threadId,
      locator: { executorProjectId: target.projectId },
    });
    expect(Object.keys(candidate).sort()).toEqual([
      "instanceId",
      "locator",
      "pluginId",
      "sessionId",
      "workspaceId",
      "workspaceRoot",
    ]);
    expect("bindingId" in candidate).toBe(false);
    expect("epoch" in candidate).toBe(false);
    expect("boundAt" in candidate).toBe(false);
  });

  it("uses generic plugin descriptor capabilities independently of legacy adapter flags", () => {
    expect(codexDesktopExecutorPlugin.descriptor.pluginId).toBe(CODEX_DESKTOP_EXECUTOR_ID);
    expect(codexDesktopExecutorPlugin.descriptor.capabilities.trustedTerminalReceipt).toBe(true);
    expect(codexDesktopExecutorPlugin.descriptor.capabilities.resume).toBe(false);
    expect(() => parseExecutorPluginDescriptor(codexDesktopExecutorPlugin.descriptor)).not.toThrow();
  });
});

describe("R5a Codex deliver with injected fake adapter", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = makeTmpDir("r5-endpoint-core-state");
    vi.stubEnv("C2C_STATE_DIR", stateDir);
    updateDesktop(workspaceId, () => ({
      state: {
        version: 1,
        workspaceId,
        workspaceRoot,
        enabled: false,
        binding: null,
        runtimeFence,
        deliveries: [],
      },
      result: undefined,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup(stateDir);
  });

  const target: ExecutorTarget = {
    threadId: "01a0d6cd-09f3-73e3-9726-4bd65df196d3",
    hostId: "local",
    projectId: "e6c3c73a-44fe-4254-bda9-edfc5ddb6389",
    workspaceRoot,
  };

  function fakeAdapter(sendImpl: (message: string) => Promise<{ threadId: string; turnId: string }>): {
    adapter: ConstructorParameters<typeof CodexDesktopExecutorPlugin>[0];
    closed: { count: number };
  } {
    const closed = { count: 0 };
    const connection: ExecutorConnection = {
      async send(message: string) {
        return sendImpl(message);
      },
      close() {
        closed.count += 1;
      },
    };
    return {
      closed,
      adapter: {
        descriptor: codexDesktopAdapter.descriptor,
        async inspect() {
          return { ...target, title: "t" };
        },
        async currentIdentity() {
          return { ...target, title: "t" };
        },
        async confirmCurrent() {
          return { ...target, title: "t" };
        },
        async prepare() {
          return connection;
        },
        async inspectActiveExecution() {
          return { ...target, activeTurnId: "turn-1" };
        },
      },
    };
  }

  const candidate = projectCodexDesktopTargetToExecutorBindingCandidate({
    target,
    workspaceId,
    instanceId: "local",
  });
  const binding = createExecutorBinding(candidate, {
    bindingId: "codex-bind-1",
    epoch: 2,
    boundAt: instant,
  });
  const targetSnapshot = freezeExecutorDeliveryTarget(binding, instant);
  const request: ExecutorDeliveryRequest = {
    request: "req-codex",
    target: targetSnapshot,
    payload: "hello",
  };

  it("returns accepted generic delivery identity when session matches and always closes", async () => {
    const { adapter, closed } = fakeAdapter(async () => ({
      threadId: target.threadId,
      turnId: "turn-abc.42",
    }));
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    const acceptance: ExecutorDeliveryAcceptance = await plugin.deliver(request);
    expect(acceptance).toEqual({ status: "accepted", deliveryId: "turn-abc.42" });
    expect(closed.count).toBe(1);
  });

  it("fails closed on session mismatch and still closes", async () => {
    const { adapter, closed } = fakeAdapter(async () => ({
      threadId: "other-session",
      turnId: "turn-x",
    }));
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    const acceptance = await plugin.deliver(request);
    expect(acceptance.status).toBe("rejected");
    if (acceptance.status === "rejected") {
      expect(acceptance.reasonCode).toBe("session_mismatch");
    }
    expect(closed.count).toBe(1);
  });

  function countingAdapter() {
    const counts = { prepare: 0, inspect: 0, inspectActive: 0, close: 0 };
    const connection: ExecutorConnection = {
      async send() {
        return { threadId: target.threadId, turnId: "turn-1" };
      },
      close() {
        counts.close += 1;
      },
    };
    const adapter = {
      descriptor: codexDesktopAdapter.descriptor,
      async inspect() {
        counts.inspect += 1;
        return { ...target, title: "t" };
      },
      async currentIdentity() {
        return { ...target, title: "t" };
      },
      async confirmCurrent() {
        return { ...target, title: "t" };
      },
      async prepare() {
        counts.prepare += 1;
        return connection;
      },
      async inspectActiveExecution() {
        counts.inspectActive += 1;
        return { ...target, activeTurnId: "turn-1" };
      },
    };
    return { adapter, counts };
  }

  function snapshotWith(overrides: Partial<ExecutorDeliveryTargetSnapshot>) {
    return freezeExecutorDeliveryTarget(
      createExecutorBinding(
        {
          pluginId: overrides.pluginId ?? candidate.pluginId,
          workspaceId,
          workspaceRoot: overrides.workspaceRoot ?? workspaceRoot,
          instanceId: overrides.instanceId ?? "local",
          sessionId: overrides.sessionId ?? target.threadId,
          locator: overrides.locator ?? candidate.locator,
        },
        { bindingId: "codex-bind-1", epoch: 2, boundAt: instant },
      ),
      instant,
    );
  }

  it("rejects foreign pluginId before adapter.prepare", async () => {
    const { adapter, counts } = countingAdapter();
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    const acceptance = await plugin.deliver({
      request: "r",
      target: snapshotWith({ pluginId: "other-plugin", sessionId: "sess-other" }),
      payload: "x",
    });
    expect(acceptance.status).toBe("rejected");
    expect(counts.prepare).toBe(0);
    expect(counts.close).toBe(0);
  });

  it("rejects missing executorProjectId before adapter.prepare", async () => {
    const { adapter, counts } = countingAdapter();
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    const acceptance = await plugin.deliver({
      request: "r",
      target: snapshotWith({ locator: {} }),
      payload: "x",
    });
    expect(acceptance.status).toBe("rejected");
    expect(counts.prepare).toBe(0);
  });

  it("rejects extra locator key before adapter.prepare", async () => {
    const { adapter, counts } = countingAdapter();
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    const acceptance = await plugin.deliver({
      request: "r",
      target: snapshotWith({
        locator: { executorProjectId: target.projectId, extraKey: "nope" },
      }),
      payload: "x",
    });
    expect(acceptance.status).toBe("rejected");
    expect(counts.prepare).toBe(0);
  });

  it("rejects foreign/malformed binding in inspectSession and inspectActiveExecution before adapter", async () => {
    const { adapter, counts } = countingAdapter();
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    const foreign = createExecutorBinding(
      {
        pluginId: "other-plugin",
        workspaceId,
        workspaceRoot,
        instanceId: "local",
        sessionId: "sess-x",
        locator: { executorProjectId: target.projectId },
      },
      { bindingId: "b1", epoch: 1, boundAt: instant },
    );
    await expect(plugin.inspectSession(foreign)).rejects.toBeInstanceOf(CodexTargetTranslationError);
    await expect(plugin.inspectActiveExecution(foreign)).rejects.toBeInstanceOf(CodexTargetTranslationError);
    const badLocator = createExecutorBinding(
      {
        pluginId: CODEX_DESKTOP_EXECUTOR_ID,
        workspaceId,
        workspaceRoot,
        instanceId: "local",
        sessionId: target.threadId,
        locator: { wrongKey: "x" },
      },
      { bindingId: "b2", epoch: 1, boundAt: instant },
    );
    await expect(plugin.inspectSession(badLocator)).rejects.toBeInstanceOf(CodexTargetTranslationError);
    await expect(plugin.inspectActiveExecution(badLocator)).rejects.toBeInstanceOf(CodexTargetTranslationError);
    expect(counts.inspect).toBe(0);
    expect(counts.inspectActive).toBe(0);
    expect(counts.prepare).toBe(0);
  });

  it("valid Codex target keeps accepted delivery behavior", async () => {
    const { adapter, counts } = countingAdapter();
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    const acceptance = await plugin.deliver(request);
    expect(acceptance).toEqual({ status: "accepted", deliveryId: "turn-1" });
    expect(counts.prepare).toBe(1);
    expect(counts.close).toBe(1);
    const session = await plugin.inspectSession(binding);
    expect(session.sessionId).toBe(target.threadId);
    expect(counts.inspect).toBe(1);
    const active = await plugin.inspectActiveExecution(binding);
    expect(active).toEqual({ active: true, executionId: "turn-1" });
    expect(counts.inspectActive).toBe(1);
  });

  it.each([
    ["idle", 0, "idle"], ["active", 0, "busy"], ["inProgress", 0, "busy"], ["idle", 1, "approval_required"],
    ["unknown", 0, "unknown"], [undefined, undefined, "unknown"],
  ])("read-only activity maps %s / %s conservatively", async (runtimeStatus, requestsCount, activity) => {
    const { adapter } = countingAdapter();
    adapter.inspect = async () => ({ ...target, title: "t", runtimeStatus, requestsCount });
    const plugin = new CodexDesktopExecutorPlugin(adapter);
    expect((await plugin.inspectSession(binding)).activity).toBe(activity);
  });
});
