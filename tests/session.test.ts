import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  clearChatPointer,
  mergeSession,
  normalizeProjectUrl,
  projectIdFromUrl,
  projectChatOwnerFingerprint,
  projectChatBinding,
  conversationChatKnown,
  readSession,
  resolveConversation,
  updateSession,
  writeSession,
} from "../src/session/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const CHAT = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHAT_B = "https://chatgpt.com/c/bbbbbbbb-2222-4222-8222-222222222222";
const THREAD_A = "11111111-1111-7111-8111-111111111111";
const THREAD_B = "22222222-2222-7222-8222-222222222222";
const WS = "sessowner000001";

describe("normalizeProjectUrl", () => {
  it("accepts the collection URL and strips extras", () => {
    expect(normalizeProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
    expect(normalizeProjectUrl("https://www.chatgpt.com/g/g-p-abc123/project?foo=1")).toBe(
      "https://chatgpt.com/g/g-p-abc123/project"
    );
    expect(projectIdFromUrl(PROJECT)).toBe("g-p-6a94399430e08191860ab5364b7748b8");
  });

  it("rejects a normal chat URL or a guessed name", () => {
    expect(normalizeProjectUrl("https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeNull();
    expect(normalizeProjectUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeProjectUrl("https://example.com/g/g-p-abc/project")).toBeNull();
  });
});

describe("resolveConversation", () => {
  it("treats a missing file as a new workspace (Project by default)", () => {
    const view = resolveConversation(null);
    expect(view.mode).toBe("project");
    expect(view.reason).toBe("new-workspace");
    expect(view.reuseSavedChat).toBe(false);
    expect(view.projectReady).toBe(false);
  });

  it("keeps a legacy session file on long-chat and does not migrate", () => {
    const view = resolveConversation({
      url: "https://chatgpt.com/c/old-chat",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reason).toBe("existing-long-chat");
    expect(view.reuseSavedChat).toBe(true);
    expect(view.chatUrl).toBe("https://chatgpt.com/c/old-chat");
  });

  it("lets an explicit long-chat opt-out win over a leftover collection URL", () => {
    const view = resolveConversation({
      conversationMode: "long-chat",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/keep",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("long-chat");
    expect(view.reuseSavedChat).toBe(true);
  });

  it("uses Project when a collection URL is stored", () => {
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/thread-1",
      connectorName: "Codex with ChatGPT · Demo",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("project");
    expect(view.projectReady).toBe(true);
    expect(view.reuseSavedChat).toBe(false);
    expect(view.connectorName).toBe("Codex with ChatGPT · Demo");
  });
});

describe("mergeSession", () => {
  it.each(["project", "long-chat"] as const)("Conversation Rebind 的 %s 只更新聊天 URL", (mode) => {
    const previous = mergeSession(null, {
      conversationMode: mode, projectUrl: PROJECT, connectorName: "Exact connector",
      url: "https://chatgpt.com/c/old", taskId: "c2c_keep", iteration: 4, lastState: "EXECUTED",
      checkpoint: { taskId: "c2c_keep", iteration: 4, protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW", chatUrl: "https://chatgpt.com/c/old", projectUrl: PROJECT },
    });
    const next = mergeSession(previous, { url: "https://chatgpt.com/c/rebound" });
    expect(next).toEqual({ ...previous, url: "https://chatgpt.com/c/rebound", savedAt: expect.any(String) });
    expect(next.checkpoint).toEqual(previous.checkpoint);
    expect(previous.url).toBe("https://chatgpt.com/c/old");
  });

  it("keeps Project fields when only the chat URL is updated", () => {
    const next = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        connectorName: "Codex with ChatGPT · Demo",
        url: "https://chatgpt.com/c/old",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { url: "https://chatgpt.com/c/new", taskId: "c2c_ab12", iteration: 1 }
    );
    expect(next.projectUrl).toBe(PROJECT);
    expect(next.conversationMode).toBe("project");
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.connectorName).toBe("Codex with ChatGPT · Demo");
    expect(next.taskId).toBe("c2c_ab12");
  });

  it("writes and clears a checkpoint without dropping the chat URL", () => {
    const withCheckpoint = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
          nextExpectedStep: "wait for review",
        },
      }
    );
    expect(withCheckpoint.url).toBe("https://chatgpt.com/c/keep");
    expect(withCheckpoint.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(withCheckpoint.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(withCheckpoint.checkpoint?.taskId).toBe("c2c_ab12");
    const cleared = mergeSession(withCheckpoint, { clearCheckpoint: true });
    expect(cleared.checkpoint).toBeUndefined();
    expect(cleared.url).toBe("https://chatgpt.com/c/keep");
  });

  it("keeps an existing checkpoint when only the chat URL is updated", () => {
    const previous = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
        },
      }
    );
    const next = mergeSession(previous, { url: "https://chatgpt.com/c/new" });
    expect(next.url).toBe("https://chatgpt.com/c/new");
    expect(next.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(next.checkpoint?.originalGoal).toBe("dark mode");
  });

  it("caps checkpoint text so it cannot become a log dump", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/keep",
        taskId: "c2c_ab12",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          originalGoal: "x".repeat(600),
        },
      }
    );
    expect(next.checkpoint?.originalGoal?.length).toBeLessThanOrEqual(501);
    expect(next.checkpoint?.originalGoal?.endsWith("…")).toBe(true);
  });

  it("leaves legacy sessions without a checkpoint unchanged", () => {
    const next = mergeSession(
      {
        url: "https://chatgpt.com/c/old",
        taskId: "c2c_aa01",
        iteration: 2,
        lastState: "EXECUTED",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { iteration: 3, lastState: "EXECUTED" }
    );
    expect(next.checkpoint).toBeUndefined();
    expect(next.taskId).toBe("c2c_aa01");
  });

  it("rejects a non-collection project URL", () => {
    expect(() =>
      mergeSession(null, {
        conversationMode: "project",
        projectUrl: "https://chatgpt.com/c/nope",
      })
    ).toThrow(/project URL/);
  });
});

describe("clearChatPointer", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("keeps the collection binding in Project mode", () => {
    const dir = makeTmpDir("session-clear");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SESSION_ID;
    writeSession("abc123abc123", {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/gone",
      connectorName: "Codex with ChatGPT · Demo",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        originalGoal: "dark mode",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("abc123abc123")).toEqual({ cleared: true, keptProject: true });
    const saved = readSession("abc123abc123");
    expect(saved?.projectUrl).toBe(PROJECT);
    expect(saved?.url).toBeUndefined();
    expect(saved?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
  });

  it("deletes a legacy long-chat file", () => {
    const dir = makeTmpDir("session-clear-legacy");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    writeSession("def456def456", {
      url: "https://chatgpt.com/c/legacy",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("def456def456")).toEqual({ cleared: true, keptProject: false });
    expect(readSession("def456def456")).toBeNull();
  });
});

describe("project chatOwnerFingerprint + multi-thread map", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SESSION_ID;
  });

  it("stores fingerprint + map on project url write; preserves on checkpoint", () => {
    const dir = makeTmpDir("session-chat-owner");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const fpA = projectChatOwnerFingerprint(WS, THREAD_A);
    const session = mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT,
      chatOwnerFingerprint: fpA,
    });
    expect(session.chatOwnerFingerprint).toBe(fpA);
    expect(session.projectChats?.find((e) => e.ownerFingerprint === fpA)?.url).toBe(CHAT);
    const next = mergeSession(session, {
      taskId: "task_g1a_1",
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" },
    });
    expect(next.projectChats?.length).toBe(1);
    writeSession(WS, next);
    process.env.CODEX_THREAD_ID = THREAD_A;
    process.env.CODEX_SESSION_ID = THREAD_A;
    expect(projectChatBinding(readSession(WS), WS)).toBe("same_thread");
    process.env.CODEX_THREAD_ID = THREAD_B;
    process.env.CODEX_SESSION_ID = THREAD_B;
    expect(projectChatBinding(readSession(WS), WS)).toBe("other_thread");
  });

  it("readSession throws on malformed / duplicate / oversized / null projectChats; update fails closed", () => {
    const dir = makeTmpDir("session-chat-corrupt");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    const sessionPath = `${dir}/sessions/${WS}.json`;
    fs.mkdirSync(`${dir}/sessions`, { recursive: true });

    const writeRaw = (projectChats: unknown) => {
      fs.writeFileSync(sessionPath, JSON.stringify({
        savedAt: "2026-01-01T00:00:00.000Z",
        conversationMode: "project",
        projectUrl: PROJECT,
        url: CHAT,
        projectChats,
      }));
    };

    writeRaw(null);
    expect(() => readSession(WS)).toThrow();

    writeRaw([{ ownerFingerprint: "bad", url: CHAT }]);
    expect(() => readSession(WS)).toThrow();

    const fp = projectChatOwnerFingerprint(WS, THREAD_A);
    writeRaw([{ ownerFingerprint: fp, url: CHAT }, { ownerFingerprint: fp, url: CHAT_B }]);
    const beforeDup = fs.readFileSync(sessionPath, "utf8");
    expect(() => readSession(WS)).toThrow();
    expect(() => updateSession(WS, (prev) => mergeSession(prev, {
      taskId: "t",
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" },
    }))).toThrow();
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(beforeDup);

    writeRaw(Array.from({ length: 129 }, (_, i) => ({
      ownerFingerprint: i.toString(16).padStart(64, "0"),
      url: `https://chatgpt.com/c/${i}`,
    })));
    expect(() => readSession(WS)).toThrow();
  });

  it("conversationChatKnown is true only for same_thread project chat", () => {
    const fp = projectChatOwnerFingerprint(WS, THREAD_A);
    const session = mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT,
      chatOwnerFingerprint: fp,
    });
    process.env.CODEX_THREAD_ID = THREAD_A;
    expect(conversationChatKnown(session, WS).chatKnown).toBe(true);
    process.env.CODEX_THREAD_ID = THREAD_B;
    expect(conversationChatKnown(session, WS).chatKnown).toBe(false);
    delete process.env.CODEX_THREAD_ID;
    expect(conversationChatKnown(session, WS).chatKnown).toBe(false);
  });
});
