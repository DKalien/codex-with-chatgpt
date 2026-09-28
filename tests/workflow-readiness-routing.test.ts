import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  clearChatPointer,
  conversationChatKnown,
  currentCodexThreadId,
  mergeSession,
  projectChatBinding,
  projectChatForCurrentThread,
  projectChatOwnerFingerprint,
  readSession,
  upsertProjectChat,
  writeSession,
  PROJECT_CHATS_MAX,
} from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { collectWorkflowReadinessInput } from "../src/cli/workflow.js";
import {
  formatWorkflowReadinessHuman,
  resolveWorkflowReadiness,
  type WorkflowReadinessInput,
} from "../src/workflow/readiness.js";
import { desktopFile } from "../src/desktop/store.js";
import { remoteFile } from "../src/remote/store.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { DesktopError } from "../src/desktop/store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import {
  PROJECT,
  CHAT_A,
  CHAT_B,
  THREAD_A,
  THREAD_B,
  WS,
  BINDING_THREAD,
  BINDING_PROJECT,
  BINDING_ID,
  root,
  baseInput,
  saveProjectChat,
  writeDesktopFixture,
  writeRemoteFixture,
} from "./workflow-readiness-fixtures.js";

describe("G2 desktopRoute saved_binding vs current_context", () => {
  function healthyConversation() {
    return {
      mode: "project" as const,
      projectReady: true,
      chatKnown: false,
      chatBinding: "none" as const,
      checkpoint: "none" as const,
      sessionCorrupt: false,
    };
  }
  function connection() {
    return {
      running: "running" as const,
      runtimeUpgrade: "current" as const,
      authorization: "authorized" as const,
      connectorContract: "current" as const,
      desktopCompatibility: "current" as const,
    };
  }
  function remoteOffline() {
    return { enabled: false, controller: "offline" as const, activeWork: false, needsReconciliation: false };
  }
  function remoteOnline() {
    return { enabled: true, controller: "online" as const, activeWork: false, needsReconciliation: false };
  }
  function desktop(overrides: Partial<WorkflowReadinessInput["desktop"]> = {}): WorkflowReadinessInput["desktop"] {
    return {
      configured: true,
      enabled: true,
      currentTarget: "unavailable",
      bindingAvailability: "available",
      unresolvedDelivery: false,
      ...overrides,
    };
  }
  function input(
    desktopFacts: WorkflowReadinessInput["desktop"],
    remote = remoteOffline(),
    conversation = healthyConversation(),
  ): WorkflowReadinessInput {
    return {
      workspaceId: "2582910bf0d2",
      workspaceName: "ws",
      connection: connection(),
      conversation,
      desktop: desktopFacts,
      remote,
      now: 1,
    };
  }

  it("MCP saved_binding + available → ready_local even without currentTarget exact", () => {
    const r = resolveWorkflowReadiness(input(desktop()), {
      desktopRoute: "saved_binding",
      currentConversation: "available",
      remoteControl: "current",
    });
    expect(r.overall).toBe("ready_local");
    expect(r.nextAction).toBe("reuse");
    expect(r.desktop.currentTarget).toBe("unavailable");
  });

  it("same facts without request policy (CLI current_context) → needs_desktop_bind", () => {
    const r = resolveWorkflowReadiness(input(desktop()), { currentConversation: "available" });
    expect(r.overall).toBe("needs_desktop_bind");
    expect(r.nextAction).toBe("bind_current");
  });

  it("new current_context thread binds locally without opening ChatGPT", () => {
    for (const desktopFacts of [
      desktop({ configured: false, enabled: false, currentTarget: "unavailable" }),
      desktop({ configured: true, enabled: false, currentTarget: "unavailable" }),
      desktop({ configured: true, enabled: false, currentTarget: "exact", bindingAvailability: "available" }),
      desktop({ configured: true, enabled: true, currentTarget: "different" }),
    ]) {
      const r = resolveWorkflowReadiness(input(desktopFacts), { currentConversation: "unavailable" });
      expect(r.overall).toBe("needs_desktop_bind");
      expect(r.nextAction).toBe("bind_current");
      expect(r.nextAction).not.toBe("open_project_chat");
    }
  });

  it("exact local Desktop is ready without a same-thread Project chat", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "available" }), remoteOffline(), {
        ...healthyConversation(),
        chatBinding: "other_thread",
      }),
      { currentConversation: "unavailable" },
    );
    expect(r.overall).toBe("ready_local");
    expect(r.nextAction).toBe("reuse");
  });

  it("missing first-time Project still requires bind_project before local readiness", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "available" }), remoteOffline(), {
        ...healthyConversation(),
        projectReady: false,
        chatBinding: "none",
      }),
      { currentConversation: "unavailable" },
    );
    expect(r.overall).toBe("needs_project");
    expect(r.nextAction).toBe("bind_project");
  });

  it("unavailable current target binds before opening a missing Project chat", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "unavailable", bindingAvailability: "available" })),
      { currentConversation: "unavailable" },
    );
    expect(r.overall).toBe("needs_desktop_bind");
    expect(r.nextAction).toBe("bind_current");
    expect(r.blockers).toContainEqual({ code: "desktop_unavailable", detail: "available" });
  });

  it("exact target keeps busy/unknown strict and routes unavailable with a request conversation", () => {
    const busy = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "busy" }), remoteOnline()),
      { currentConversation: "unavailable" },
    );
    expect(busy.overall).toBe("busy");
    expect(busy.nextAction).toBe("wait_current_task");
    expect(busy.nextAction).not.toBe("bind_current");
    expect(busy.nextAction).not.toBe("open_project_chat");

    const unknown = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unknown" }), remoteOnline()),
      { currentConversation: "unavailable" },
    );
    expect(unknown.overall).toBe("blocked");
    expect(unknown.nextAction).toBe("stop_unknown");
    expect(unknown.blockers).toContainEqual({ code: "desktop_delivery_unknown" });

    const unavailable = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOnline()),
      { currentConversation: "available" },
    );
    expect(unavailable.overall).toBe("ready_remote");
    expect(unavailable.nextAction).toBe("use_remote");
  });

  it("exact unavailable uses safely-ready Remote with current request scopes", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOnline()),
      { currentConversation: "available", remoteControl: "current" },
    );
    expect(r.overall).toBe("ready_remote");
    expect(r.nextAction).toBe("use_remote");
  });

  it("exact unavailable + Remote ready requires missing/incomplete request scopes", () => {
    for (const remoteControl of ["none", "incomplete"] as const) {
      const r = resolveWorkflowReadiness(
        input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOnline()),
        { currentConversation: "available", remoteControl },
      );
      expect(r.overall).toBe("needs_authorization");
      expect(r.nextAction).toBe("resume_authorization");
      expect(r.blockers.some((blocker) => blocker.code.startsWith("remote_request_scope_"))).toBe(true);
    }
  });

  it("exact unavailable + Remote offline stays blocked", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOffline()),
      { currentConversation: "available", remoteControl: "current" },
    );
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
    expect(r.blockers).toContainEqual({ code: "desktop_delivery_unavailable" });
  });

  it("Remote-ready and saved_binding routes preserve their existing conversation strategy", () => {
    const remote = resolveWorkflowReadiness(
      input(desktop({ configured: false, enabled: false }), remoteOnline()),
      { currentConversation: "unavailable", remoteControl: "current" },
    );
    expect(remote.nextAction).toBe("open_project_chat");

    const saved = resolveWorkflowReadiness(
      input(desktop({ configured: false, enabled: false }), remoteOffline()),
      { desktopRoute: "saved_binding", currentConversation: "unavailable" },
    );
    expect(saved.nextAction).toBe("open_project_chat");
  });

  it("MCP saved_binding busy → busy/wait_current_task", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "busy" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("busy");
    expect(r.nextAction).toBe("wait_current_task");
  });

  it("MCP saved_binding unknown → blocked/stop_unknown", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unknown" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
  });

  it("MCP saved_binding unavailable + remote ready + scopes current → ready_remote fallback", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unavailable" }), remoteOnline()),
      { desktopRoute: "saved_binding", currentConversation: "available", remoteControl: "current" },
    );
    expect(r.overall).toBe("ready_remote");
    expect(r.nextAction).toBe("use_remote");
  });

  it("MCP saved_binding unavailable + remote ready without scopes → needs_authorization", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unavailable" }), remoteOnline()),
      { desktopRoute: "saved_binding", currentConversation: "available", remoteControl: "none" },
    );
    expect(r.overall).toBe("needs_authorization");
  });

  it("MCP saved_binding unavailable + remote offline → blocked", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unavailable" }), remoteOffline()),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("blocked");
  });

  it("unresolved delivery still blocks highest priority on saved_binding route", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ unresolvedDelivery: true })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("resolve_unconfirmed_delivery");
  });

  it("configured=false / enabled=false on saved_binding still needs_desktop_bind when no remote", () => {
    const unconfigured = resolveWorkflowReadiness(
      input(desktop({ configured: false, enabled: false, bindingAvailability: "unavailable" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(unconfigured.overall).toBe("needs_desktop_bind");
    expect(unconfigured.nextAction).toBe("bind_current");

    const disabled = resolveWorkflowReadiness(
      input(desktop({ configured: true, enabled: false, bindingAvailability: "unavailable" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(disabled.overall).toBe("needs_desktop_bind");
  });

  it("currentTarget=different does not affect MCP saved_binding; still affects local current_context", () => {
    const differentAvailable = desktop({ currentTarget: "different", bindingAvailability: "available" });
    const mcp = resolveWorkflowReadiness(
      input(differentAvailable),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(mcp.overall).toBe("ready_local");

    const cli = resolveWorkflowReadiness(
      input(differentAvailable),
      { currentConversation: "available" },
    );
    expect(cli.overall).toBe("needs_desktop_bind");
  });
});
describe("G1a resolver + human (kept + review)", () => {
  it("authorization unknown → blocked; missing → needs_authorization; desktopCompatibility none → needs_authorization", () => {
    expect(resolveWorkflowReadiness(baseInput({
      connection: { ...baseInput().connection, authorization: "unknown" },
    })).overall).toBe("blocked");
    expect(resolveWorkflowReadiness(baseInput({
      connection: { ...baseInput().connection, authorization: "missing" },
    })).overall).toBe("needs_authorization");
    expect(resolveWorkflowReadiness(baseInput({
      connection: { ...baseInput().connection, desktopCompatibility: "none" },
    })).overall).toBe("needs_authorization");
  });

  it("Bridge stopped + unreadable admin facts → needs_connection, not blocked", () => {
    const r = resolveWorkflowReadiness(baseInput({
      connection: {
        running: "stopped",
        runtimeUpgrade: "unknown",
        authorization: "unknown",
        connectorContract: "unknown",
        desktopCompatibility: "unknown",
      },
    }));
    expect(r.overall).toBe("needs_connection");
    expect(r.nextAction).toBe("repair_connection");
  });

  it("Bridge unknown → blocked / stop_unknown (not stopped)", () => {
    const r = resolveWorkflowReadiness(baseInput({
      connection: {
        running: "unknown",
        runtimeUpgrade: "unknown",
        authorization: "unknown",
        connectorContract: "unknown",
        desktopCompatibility: "unknown",
      },
    }));
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
  });

  it("exact + available → ready_local/reuse", () => {
    const r = resolveWorkflowReadiness(baseInput());
    expect(r.overall).toBe("ready_local");
    expect(r.nextAction).toBe("reuse");
  });

  it("exact + busy → busy / wait_current_task", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "busy" },
    }));
    expect(r.overall).toBe("busy");
  });

  it("exact + unknown → blocked / stop_unknown (not soft ready_local)", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "unknown" },
    }));
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
    const human = formatWorkflowReadinessHuman(r);
    expect(human).not.toContain("Ready.");
    expect(human).not.toContain("ready_local");
  });

  it("exact + unavailable + Remote disabled → blocked", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "unavailable" },
      remote: { enabled: false, controller: "offline", activeWork: false, needsReconciliation: false },
    }));
    expect(r.overall).toBe("blocked");
  });

  it("exact + unavailable + Remote online idle → ready_remote / use_remote", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "unavailable" },
      remote: { enabled: true, controller: "online", activeWork: false, needsReconciliation: false },
    }));
    expect(r.overall).toBe("ready_remote");
    expect(r.nextAction).toBe("use_remote");
  });
});
