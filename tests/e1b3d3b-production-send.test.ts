import { describe, expect, it } from "vitest";

import fs from "node:fs";

import path from "node:path";

import vm from "node:vm";

import { fileURLToPath } from "node:url";

import {
  hasExactAttemptMarker,
  findCanonicalUserTurn,
  buildTurnObservationDiagnostic,
  sanitizeObservationDiagnostic,
  buildMarkerRepresentationDiagnostic,
  sanitizeMarkerRepresentation,
  TURN_DIAGNOSTIC_LIMITS,
  collectBoundedDescendants,
  canonicalTurnBodyMatch,
  hasExactVisibleBodyDescendant,
  snapshotUserTurns,
} from "../browser-companion/turn-observer.js";

import { normalizeCanonicalDomText } from "../browser-companion/dom-adapter.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const companionRoot = path.join(projectRoot, "browser-companion");

const distCompanion = path.join(projectRoot, "dist", "browser-companion");

const EVENT_ID = "e".repeat(32);

const RES_ID = "11111111-1111-4111-8111-111111111111";

const ATTEMPT = "22222222-2222-4222-8222-222222222222";

const MESSAGE = `[C2C_CONTROL]\nSTATE: EXECUTED\nEVENT_ID: ${EVENT_ID}\nATTEMPT_ID: ${ATTEMPT}\n`;

describe("E1b3d3b observation diagnostic (read-only)", () => {
  function docWithTurns(texts: string[]) {
    return {
      querySelectorAll: () =>
        texts.map((text, i) => ({
          getAttribute: (n: string) =>
            n === "data-message-author-role"
              ? "user"
              : n === "data-testid"
                ? `conversation-turn-${i}`
                : null,
          textContent: text,
          innerText: text,
          closest: () => ({ getAttribute: () => `conversation-turn-${i}` }),
          querySelector: () => null,
        })),
    } as never;
  }

  it("not_observed diagnostic is bounded and has no raw text", () => {
    const doc = docWithTurns(["hello world", "other"]);
    const rec = findCanonicalUserTurn(doc, {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
    const d = (rec as { diagnostic?: Record<string, unknown> }).diagnostic;
    expect(d).toBeTruthy();
    expect(d?.candidateCount).toBe(2);
    expect(d?.exactTextMatchCount).toBe(0);
    expect(d?.exactAttemptMarkerCount).toBe(0);
    expect(d?.targetLength).toBe(MESSAGE.length);
    expect(Array.isArray(d?.candidateLengths)).toBe(true);
    expect((d?.candidateLengths as number[]).length).toBeLessThanOrEqual(
      TURN_DIAGNOSTIC_LIMITS.maxCandidatesReported,
    );
    const dump = JSON.stringify(d ?? {});
    expect(dump).not.toContain(MESSAGE);
    expect(dump).not.toContain("hello world");
    expect(dump).not.toContain("message");
    expect(dump).not.toContain("credential");
    expect(dump).not.toContain("secret");
  });

  it("ambiguous diagnostic reports match counts without text", () => {
    const doc = docWithTurns([MESSAGE, MESSAGE]);
    const rec = findCanonicalUserTurn(doc, {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("ambiguous");
    const d = (rec as { diagnostic?: Record<string, unknown> }).diagnostic;
    expect(d?.exactTextMatchCount).toBe(2);
    expect(d?.exactAttemptMarkerCount).toBe(2);
    expect(d?.ambiguousCount).toBe(2);
    expect(JSON.stringify(d ?? {})).not.toContain(MESSAGE);
  });

  it("exact match success diagnostic has counts only", () => {
    const doc = docWithTurns(["nope", MESSAGE]);
    const rec = findCanonicalUserTurn(doc, {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
    const d = (rec as { diagnostic?: Record<string, unknown> }).diagnostic;
    expect(d?.candidateCount).toBe(2);
    expect(d?.exactTextMatchCount).toBe(1);
    expect(d?.exactAttemptMarkerCount).toBe(1);
    expect(d?.ambiguousCount).toBe(0);
    expect(JSON.stringify(d ?? {})).not.toContain(MESSAGE);
  });

  it("buildTurnObservationDiagnostic reports role evidence and firstMismatchIndex", () => {
    const turns = [
      { text: "aaa", node: { getAttribute: () => "user", querySelector: () => null } },
      { text: MESSAGE, node: { getAttribute: () => "user", querySelector: () => null } },
    ];
    const d = buildTurnObservationDiagnostic({
      message: MESSAGE,
      attemptId: ATTEMPT,
      turns,
      matches: [],
    });
    expect(d.candidateCount).toBe(2);
    expect(d.firstMismatchIndex).toBe(0);
    expect(d.candidates[0]?.directRole).toBe("user");
    expect(d.candidates[0]?.nestedUser).toBe(false);
  });

  it("sanitizeObservationDiagnostic allowlists and caps", () => {
    const safe = sanitizeObservationDiagnostic({
      candidateCount: 1,
      message: MESSAGE,
      credential: "x",
      secret: "y",
      candidateLengths: [1, 2, 3, 4, 5, 6],
      candidates: [
        { directRole: "user", nestedUser: false, text: MESSAGE },
        { directRole: "assistant", nestedUser: false },
      ],
      targetLength: 9,
    });
    expect(safe).toBeTruthy();
    expect(safe?.message).toBeUndefined();
    expect((safe as Record<string, unknown>).credential).toBeUndefined();
    expect((safe as Record<string, unknown>).secret).toBeUndefined();
    expect(safe?.candidateLengths?.length).toBeLessThanOrEqual(5);
    expect(safe?.candidates?.length).toBeLessThanOrEqual(5);
    expect(safe?.candidates?.[0]).toEqual({ directRole: "user", nestedUser: false });
  });
});

describe("E1b3d3b2 exact message-body observation", () => {
  const canonical = normalizeCanonicalDomText(MESSAGE);

  function userNode(opts: {
    innerText?: string;
    textContent?: string;
    children?: unknown[];
    role?: string;
  }) {
    return {
      innerText: opts.innerText ?? "",
      textContent: opts.textContent !== undefined ? opts.textContent : (opts.innerText ?? ""),
      children: opts.children ?? [],
      getAttribute: (n: string) =>
        n === "data-message-author-role" ? (opts.role ?? "user") : n === "data-testid" ? "conversation-turn" : null,
      closest: () => null,
    };
  }

  function docOf(nodes: unknown[]) {
    return { querySelectorAll: () => nodes } as never;
  }

  function modernTurn(text: string, key: string, legacyRole = false) {
    const host = {
      tagName: "DIV",
      innerText: `你说：\n${text}`,
      textContent: `你说：\n${text}`,
      children: [] as unknown[],
      getAttribute: (name: string) => name === "data-turn-key" ? key
        : name === "data-message-author-role" && legacyRole ? "user" : null,
      closest: (selector: string) => selector === "[data-turn-key]" ? host : null,
      querySelector: () => null,
    };
    const bubble = {
      tagName: "DIV",
      innerText: text,
      textContent: text,
      children: [] as unknown[],
      getAttribute: (name: string) => name === "data-user-message-bubble" ? "true" : null,
      closest: (selector: string) => selector === "[data-turn-key]" ? host : null,
    };
    return { host, bubble };
  }

  it("R3s. modern USER bubble is one exact candidate with turn-key identity", () => {
    const { host, bubble } = modernTurn(MESSAGE, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const doc = docOf([host, bubble]);
    const turns = snapshotUserTurns(doc);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: canonical, node: bubble });
    const rec = findCanonicalUserTurn(doc, { message: MESSAGE, attemptId: ATTEMPT, baseline: [] });
    expect(rec.ok).toBe(true);
    expect(rec.diagnostic?.candidateCount).toBe(1);
  });

  it("R3s. different modern ATTEMPT_ID lines select only the exact target", () => {
    const first = modernTurn(MESSAGE, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const second = modernTurn(MESSAGE.replace(ATTEMPT, "33333333-3333-4333-8333-333333333333"),
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const rec = findCanonicalUserTurn(docOf([first.host, first.bubble, second.host, second.bubble]), {
      message: MESSAGE, attemptId: ATTEMPT, baseline: [],
    });
    expect(rec.ok).toBe(true);
    expect(rec.turn?.node).toBe(first.bubble);
    expect(rec.diagnostic?.candidateCount).toBe(2);
    expect(rec.diagnostic?.exactAttemptMarkerCount).toBe(1);
  });

  it("R3s. identical modern USER bubbles on different turns fail ambiguous", () => {
    const first = modernTurn(MESSAGE, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const second = modernTurn(MESSAGE, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const rec = findCanonicalUserTurn(docOf([first.host, first.bubble, second.host, second.bubble]), {
      message: MESSAGE, attemptId: ATTEMPT, baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("ambiguous");
    expect(rec.diagnostic?.candidateCount).toBe(2);
  });

  it("R3s. virtualized ghost without USER bubble has zero candidates", () => {
    const { host } = modernTurn(MESSAGE, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const rec = findCanonicalUserTurn(docOf([host]), {
      message: MESSAGE, attemptId: ATTEMPT, baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
    expect(rec.diagnostic?.candidateCount).toBe(0);
  });

  it("R3s. hybrid legacy and modern nodes under one turn-key are one bubble candidate", () => {
    const { host, bubble } = modernTurn(MESSAGE, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    const turns = snapshotUserTurns(docOf([host, bubble]));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.node).toBe(bubble);
    expect(turns[0]?.text).toBe(canonical);
  });

  it("A. parent exact fast path still succeeds", () => {
    const parent = userNode({ innerText: canonical, textContent: canonical });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
  });

  it("B. live-like parent + 2 exact nested descendants → one turn, not ambiguous", () => {
    const chrome = `${canonical}Copy`;
    const child1 = userNode({ innerText: canonical });
    const child2 = userNode({ innerText: canonical });
    const parent = userNode({
      innerText: chrome,
      textContent: chrome,
      children: [child1, child2],
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
  });

  it("C. three exact descendants in one user turn still count as one match", () => {
    const kids = Array.from({ length: 3 }, () => userNode({ innerText: canonical }));
    const parent = userNode({
      innerText: `${canonical}UI`,
      children: kids,
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
  });

  it("D. two different user turns each with exact body → ambiguous", () => {
    const makeTurn = () => {
      const child = userNode({ innerText: canonical });
      return userNode({
        innerText: `${canonical}UI`,
        children: [child],
      });
    };
    const rec = findCanonicalUserTurn(docOf([makeTurn(), makeTurn()]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("ambiguous");
  });

  it("E. descendant textContent exact but innerText not → not_observed", () => {
    const child = {
      innerText: "",
      textContent: canonical,
      children: [],
      getAttribute: (n: string) => (n === "data-message-author-role" ? "user" : null),
    };
    const parent = userNode({
      innerText: `${canonical}UI`,
      textContent: `${canonical}UI`,
      children: [child],
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
  });

  it("F. parent without exact ATTEMPT marker → not_observed even if child exact", () => {
    const noMarker = "STATE: EXECUTED\nBODY\n";
    const child = userNode({ innerText: canonical });
    const parent = userNode({
      innerText: `${noMarker}UI`,
      children: [child],
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
  });

  it("G. exact descendant beyond 64th visit → not_observed, no unbounded scan", () => {
    const maxDesc = TURN_DIAGNOSTIC_LIMITS.maxDescendantsScanned;
    const readIds = new Set<number>();
    const kids = Array.from({ length: 200 }, (_, i) => ({
      get innerText() {
        readIds.add(i);
        return i === maxDesc + 10 ? canonical : `x-${i}`;
      },
      get textContent() {
        readIds.add(i);
        return i === maxDesc + 10 ? canonical : `x-${i}`;
      },
      children: [] as unknown[],
    }));
    const parent = userNode({
      innerText: `${canonical}UI`,
      children: kids,
    });
    // Parent marker is exact (canonical includes ATTEMPT_ID).
    expect(hasExactAttemptMarker(parent.innerText, ATTEMPT).ok).toBe(true);
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
    expect(readIds.has(maxDesc + 10)).toBe(false);
  });

  it("H. baseline excludes same parent turn identity even with exact descendant", () => {
    const child = userNode({ innerText: canonical });
    const parent = userNode({
      innerText: `${canonical}UI`,
      children: [child],
      getAttribute: (n: string) =>
        n === "data-message-author-role" ? "user" : n === "data-turn-id" ? "turn-1" : null,
    });
    const turns = snapshotUserTurns(docOf([parent]));
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: turns,
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
  });

  it("I. assistant turn never succeeds", () => {
    const child = userNode({ innerText: canonical });
    const assistant = userNode({
      innerText: `${canonical}UI`,
      children: [child],
      role: "assistant",
    });
    const rec = findCanonicalUserTurn(docOf([assistant]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
  });

  it("source stays full-equality: no substring/trim authority", () => {
    const src = fs.readFileSync(path.join(companionRoot, "turn-observer.js"), "utf8");
    const bodyStart = src.indexOf("export function canonicalTurnBodyMatch");
    const bodyEnd = src.indexOf("export function findCanonicalUserTurn");
    const body = src.slice(bodyStart, bodyEnd);
    expect(body).toMatch(/turn\.text === want/);
    expect(body).toMatch(/hasExactAttemptMarker\(turn\.text, attemptId\)/);
    expect(body).toMatch(/hasExactVisibleBodyDescendant/);
    expect(body).not.toMatch(/includes\(want\)|startsWith|endsWith|\.trim\(\)/);
    const findStart = src.indexOf("export function findCanonicalUserTurn");
    const findBody = src.slice(findStart, findStart + 2000);
    expect(findBody).toMatch(/canonicalTurnBodyMatch/);
    expect(findBody).not.toMatch(/includes\(want\)|startsWith\(want\)/);
  });
});

describe("command29 rich USER paragraph observation", () => {
  // Content-free live shape: one paragraph with SPAN/BR, an external link with
  // an empty block favicon, then a sibling spacer and collapse button. Desktop
  // message text is synthetic; neither user content nor runtime IDs are saved.
  const url = "https://example.test/health";
  const message = `${MESSAGE}Summary: healthy ${url}.\nDone.  Preserve  spaces.`;
  type Node = ReturnType<typeof element>;
  function text(value: string): any {
    return { nodeType: 3, nodeValue: value, textContent: value, childNodes: [] };
  }
  function element(tag: string, children: any[] = [], className = ""): any {
    const node: any = {
      nodeType: 1, tagName: tag, className, childNodes: children,
      style: { display: ["DIV", "P", "BUTTON", "svg"].includes(tag) ? "block" : "inline", visibility: "visible", opacity: "1", textTransform: "none" },
      attrs: {}, parentElement: null,
      classList: { contains: (name: string) => className.split(/\s+/).includes(name) },
      getAttribute(name: string) { return this.attrs[name] ?? null; },
      closest: () => null,
      get children() { return this.childNodes.filter((child: any) => child.nodeType === 1); },
      get firstChild() { return this.childNodes[0]; },
      get textContent() { return this.childNodes.map((child: any) => child.textContent).join(""); },
      get innerText() { return this.rendered ?? (tag === "BR" ? "\n" : this.childNodes.map((child: any) => child.nodeType === 3 ? child.nodeValue : child.innerText).join("")); },
    };
    for (const child of children) child.parentElement = node;
    node.ownerDocument = { defaultView: { getComputedStyle: (child: any) => child.style } };
    return node;
  }
  function fixture() {
    const label = element("SPAN", [element("SPAN", [text(url)])], "Label-example");
    const icon = element("SPAN", [element("SPAN", [element("SPAN", [element("svg", [element("path")])]), element("IMG")])], "IconContainer-example");
    const link = element("A", [element("SPAN", [icon, label], "Mention-example")], "ExternalMarkdownLink-example InlineMentionFocusRing-example");
    link.attrs["aria-hidden"] = "true"; // Actual visible link is AT-hidden, not CSS-hidden.
    const lines = message.split("\n"), nodes: Node[] = [];
    for (const [i, line] of lines.entries()) {
      if (i) nodes.push(element("BR"));
      if (line.includes(url)) {
        const [before, after] = line.split(url);
        nodes.push(element("SPAN", [text(before)]), link, text(after));
      } else nodes.push(element("SPAN", [text(line)]));
    }
    const paragraph = element("P", nodes);
    paragraph.rendered = message.replace(url, `\n${url}`); // Empty block favicon inserts a layout LF.
    const rich = element("DIV", [paragraph], "MarkdownRoot-example rich-text-user-turn");
    const spacer = element("SPAN", [text("+")]); spacer.style.display = "block";
    const bubble = element("DIV", [element("DIV", [element("DIV", [element("DIV", [rich]), spacer]), element("BUTTON", [text("More")])])]);
    bubble.attrs["data-user-message-bubble"] = "true";
    bubble.rendered = `${paragraph.innerText}\n\n+\nMore`;
    return { bubble, paragraph, rich, link, label, icon, doc: { querySelectorAll: () => [bubble] } as never };
  }
  const find = (f: ReturnType<typeof fixture>, expected = message) =>
    findCanonicalUserTurn(f.doc, { message: expected, attemptId: ATTEMPT });


  // 脱敏复刻：预格式正文直接含文本和 12 个 CODE，折叠 UI 是正文外的兄弟节点。
  const codeValues = Array.from({ length: 12 }, (_, i) => `item ${i + 1} → ready`);
  const plainPrefix = MESSAGE + Array.from({ length: 7 }, (_, i) => `FIELD_${i}: synthetic\n`).join("") + 'RAW_SUMMARY_JSON: "';
  const plainSuffix = '  preserve  spaces \\n literal"\n```text\nuntouched  fence\n```\nINSTRUCTION: observe only';
  const plainMessage = plainPrefix + codeValues.map(value => '`' + value + '`').join(", ") + plainSuffix;
  function plainFixture() {
    const codes = codeValues.map(value => element("CODE", [text(value)]));
    const nodes = [text(plainPrefix)];
    codes.forEach((code, i) => { if (i) nodes.push(text(", ")); nodes.push(code); });
    nodes.push(text(plainSuffix));
    const body = element("DIV", nodes, "text-size-chat whitespace-pre-wrap");
    body.style.whiteSpace = "pre-wrap";
    const clip = element("DIV", [element("DIV", [body])], "overflow-hidden");
    clip.attrs["data-search-result-target"] = "";
    clip.style.maxHeight = "494px";
    const spacer = element("SPAN", [text("…")], "block");
    spacer.attrs["aria-hidden"] = "true";
    const button = element("BUTTON", [element("SPAN", [text("显示更多")]), element("svg")]);
    button.attrs["data-markdown-copy"] = "exclude";
    button.attrs["data-thread-find-skip"] = "true";
    const bubble = element("DIV", [clip, spacer, button]);
    bubble.attrs["data-user-message-bubble"] = "true";
    bubble.rendered = body.innerText + "\n…\n显示更多";
    return { body, bubble, codes, doc: { querySelectorAll: () => [bubble] } as never };
  }
  const findPlain = (f: ReturnType<typeof plainFixture>, expected = plainMessage) =>
    findCanonicalUserTurn(f.doc, { message: expected, attemptId: ATTEMPT });

  it("pre-wrap direct text and 12 CODE restore only backticks, excluding collapse controls", () => {
    const f = plainFixture();
    expect(plainMessage.split("\n")).toHaveLength(16);
    expect(f.body.innerText).toBe(f.body.textContent);
    expect(f.body.innerText.length).toBe(plainMessage.length - 24);
    expect(f.bubble.innerText).not.toBe(plainMessage);
    expect(hasExactVisibleBodyDescendant(f.bubble, plainMessage, ATTEMPT)).toBe(false);
    const result = findPlain(f);
    expect(result.ok).toBe(true);
    expect(result.diagnostic?.representation).toMatchObject({ richBodyReasonCode: 0, richBodyCount: 1,
      richBodyRebuildSucceeded: true, richBodyExact: true, richBodyLengthDelta: 0, richBodyFirstMismatchIndex: -1 });
    const classic: Record<string, any> = { normalizeCanonicalDomText };
    vm.runInNewContext(fs.readFileSync(path.join(distCompanion, "turn-observer-global.js"), "utf8"), classic);
    expect(classic.findCanonicalUserTurn(f.doc, { message: plainMessage, attemptId: ATTEMPT })).toEqual(result);
  });

  it.each(["body_hidden", "body_transform", "body_inline", "collapse", "unknown_style", "wrong_class", "body_visible_mismatch",
    "code_hidden", "code_opacity", "code_transform", "code_block", "code_empty", "code_backtick", "code_newline", "code_nested", "code_visible_mismatch",
    "body_span", "body_comment", "changed_text", "marker_missing", "assistant"])("plain %s fails closed", kind => {
    const f = plainFixture();
    if (kind === "body_hidden") f.body.style.visibility = "hidden";
    if (kind === "body_transform") f.body.style.textTransform = "uppercase";
    if (kind === "body_inline") f.body.style.display = "inline";
    if (kind === "collapse") f.body.style.whiteSpace = "normal";
    if (kind === "unknown_style") delete f.body.style.whiteSpace;
    if (kind === "wrong_class") f.body.classList.contains = () => false;
    if (kind === "body_visible_mismatch") f.body.rendered = f.body.textContent + " ";
    if (kind === "code_hidden") f.codes[0].style.visibility = "hidden";
    if (kind === "code_opacity") f.codes[0].style.opacity = "0";
    if (kind === "code_transform") f.codes[0].style.textTransform = "uppercase";
    if (kind === "code_block") f.codes[0].style.display = "block";
    if (kind === "code_empty") f.codes[0].childNodes = [];
    if (kind === "code_backtick") f.codes[0].childNodes = [text("a`b")];
    if (kind === "code_newline") f.codes[0].childNodes = [text("a\nb")];
    if (kind === "code_nested") f.codes[0].childNodes = [element("SPAN", [text(codeValues[0])])];
    if (kind === "code_visible_mismatch") f.codes[0].rendered = "changed";
    if (kind === "body_span") f.body.childNodes.push(element("SPAN", [text("extra")]));
    if (kind === "body_comment") f.body.childNodes.push({ nodeType: 8, textContent: "", childNodes: [] });
    if (kind === "changed_text") f.body.childNodes[0].nodeValue += "changed";
    if (kind === "marker_missing") f.bubble.rendered = "no marker";
    if (kind === "assistant") { f.bubble.attrs["data-user-message-bubble"] = null; f.bubble.attrs["data-message-author-role"] = "assistant"; }
    expect(findPlain(f).ok).toBe(false);
  });

  it("plain exactness preserves spaces, literal slash-n, fence text and exact attempt", () => {
    const f = plainFixture();
    for (const expected of [plainMessage + " ", plainMessage.replace("preserve  spaces", "preserve spaces"),
      plainMessage.replace("\\n literal", "\n literal"), plainMessage.replace("```text", "`text"),
      plainMessage.replace(ATTEMPT, RES_ID)]) expect(findPlain(f, expected).ok).toBe(false);
  });

  it("counts separate plain or mixed bodies, but not a pre-wrap wrapper around rich DIV", () => {
    for (const extra of [plainFixture().body, fixture().rich]) {
      const f = plainFixture();
      f.bubble.childNodes.push(extra);
      const result = findPlain(f);
      expect(result.ok).toBe(false);
      expect(result.diagnostic?.representation).toMatchObject({ richBodyReasonCode: 5, richBodyCount: 2 });
    }
    const f = fixture();
    f.rich.parentElement.classList.contains = (name: string) => name === "whitespace-pre-wrap";
    expect(find(f).ok).toBe(true);
  });

  it("plain body preserves both bounded budgets, baseline exclusion and turn ambiguity", () => {
    const f = plainFixture();
    const count = (node: any): number => 1 + node.childNodes.reduce((sum: number, child: any) => sum + count(child), 0);
    f.body.childNodes.push(...Array.from({ length: 128 - count(f.body) }, () => text("")));
    expect(findPlain(f).diagnostic?.representation).toMatchObject({ richBodyReasonCode: 0, richBodyNodeScannedCount: 128 });
    f.body.childNodes.push(text(""));
    expect(findPlain(f).ok).toBe(false);
    expect(findPlain(f).diagnostic?.representation?.richBodyReasonCode).toBe(8);
    const wrappers = plainFixture();
    const base = findPlain(wrappers).diagnostic!.representation!.richBodyWrapperScannedCount;
    wrappers.bubble.childNodes.push(...Array.from({ length: 64 - base }, () => element("DIV")));
    expect(findPlain(wrappers).ok).toBe(true);
    wrappers.bubble.childNodes.push(element("DIV"));
    expect(findPlain(wrappers).diagnostic?.representation?.richBodyReasonCode).toBe(3);
    const a = plainFixture(), b = plainFixture();
    expect(findCanonicalUserTurn(a.doc, { message: plainMessage, attemptId: ATTEMPT, baseline: snapshotUserTurns(a.doc) }).ok).toBe(false);
    expect(findCanonicalUserTurn({ querySelectorAll: () => [a.bubble, b.bubble] } as never,
      { message: plainMessage, attemptId: ATTEMPT }).reason).toBe("ambiguous");
  });

  it("reconstructs real BRs and inline link text despite the favicon LF and outer controls", () => {
    const f = fixture();
    expect(f.paragraph.innerText.length - message.length).toBe(1);
    expect(f.bubble.innerText.length - message.length).toBe(9);
    expect(f.paragraph.textContent).toBe(message.replace(/\n/g, ""));
    expect(find(f).ok).toBe(true);
    const classic: Record<string, any> = { normalizeCanonicalDomText };
    vm.runInNewContext(fs.readFileSync(path.join(distCompanion, "turn-observer-global.js"), "utf8"), classic);
    expect(classic.findCanonicalUserTurn(f.doc, { message, attemptId: ATTEMPT }).ok).toBe(true);
  });

  it.each(["hidden", "opacity", "display", "transform", "inline_text", "unknown", "extra_paragraph", "missing_BR", "changed_text", "link_label", "hidden_link_text"])(
    "%s cannot be normalized into observed", kind => {
      const f = fixture();
      if (kind === "hidden") f.rich.style.visibility = "hidden";
      if (kind === "opacity") f.paragraph.style.opacity = "0";
      if (kind === "display") f.paragraph.childNodes[0].style.display = "block";
      if (kind === "transform") f.paragraph.style.textTransform = "uppercase";
      if (kind === "inline_text") f.paragraph.childNodes[0].rendered = "different";
      if (kind === "unknown") f.paragraph.childNodes[0].tagName = "EM";
      if (kind === "extra_paragraph") f.rich.childNodes.push(element("P", [text("extra")]));
      if (kind === "missing_BR") f.paragraph.childNodes.splice(1, 1);
      if (kind === "changed_text") f.paragraph.childNodes[0].childNodes[0].nodeValue = "[different]";
      if (kind === "link_label") f.label.childNodes[0].childNodes[0].nodeValue = "example.test";
      if (kind === "hidden_link_text") f.link.rendered = "";
      expect(find(f).ok).toBe(false);
    },
  );

  it("rich reader diagnostic preserves exact success and reports mismatch position only", () => {
    const f = fixture();
    const success = find(f);
    expect(success.ok).toBe(true);
    const rep = success.diagnostic?.representation;
    expect(rep).toMatchObject({ richBodyReasonCode: 0, richBodyCount: 1,
      richBodyRebuildSucceeded: true, richBodyExact: true,
      richBodyRebuiltLength: message.length, richBodyLengthDelta: 0, richBodyFirstMismatchIndex: -1 });
    const expected = message.replace("Preserve  spaces", "Preserve spaces");
    const mismatch = find(f, expected);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.diagnostic?.representation).toMatchObject({ richBodyReasonCode: 0,
      richBodyRebuildSucceeded: true, richBodyExact: false, richBodyLengthDelta: 1,
      richBodyFirstMismatchIndex: expected.indexOf("Preserve spaces") + "Preserve ".length });
    const classic: Record<string, any> = { normalizeCanonicalDomText };
    vm.runInNewContext(fs.readFileSync(path.join(distCompanion, "turn-observer-global.js"), "utf8"), classic);
    expect(classic.findCanonicalUserTurn(f.doc, { message, attemptId: ATTEMPT }).diagnostic.representation).toEqual(rep);
  });

  it("128 body nodes and 64 wrappers stay exact; the next node reports its separate limit", () => {
    const f = fixture();
    const count = (node: any): number => 1 + node.childNodes.reduce((sum: number, child: any) => sum + count(child), 0);
    f.paragraph.childNodes.push(...Array.from({ length: 128 - count(f.paragraph) }, () => text("")));
    expect(find(f).ok).toBe(true);
    expect(find(f).diagnostic?.representation).toMatchObject({ richBodyReasonCode: 0, richBodyNodeScannedCount: 128 });
    f.paragraph.childNodes.push(text(""));
    expect(find(f).ok).toBe(false);
    expect(find(f).diagnostic?.representation).toMatchObject({ richBodyReasonCode: 8, richBodyNodeScannedCount: 128, richBodyRebuildSucceeded: false });
    const wrappers = fixture();
    const base = find(wrappers).diagnostic!.representation!.richBodyWrapperScannedCount;
    wrappers.bubble.childNodes.push(...Array.from({ length: 64 - base }, () => element("DIV")));
    expect(find(wrappers).ok).toBe(true);
    expect(find(wrappers).diagnostic?.representation).toMatchObject({ richBodyReasonCode: 0, richBodyWrapperScannedCount: 64 });
    wrappers.bubble.childNodes.push(element("DIV"));
    const over = find(wrappers);
    expect(over.ok).toBe(false);
    expect(over.diagnostic?.representation).toMatchObject({ richBodyReasonCode: 3, richBodyRebuildSucceeded: false });
    expect(over.diagnostic?.representation?.richBodyWrapperScannedCount).toBeLessThanOrEqual(64);
  });

  it.each(["bodyshape", "hidden", "transform", "tag", "inline", "link", "node", "style_fault"])(
    "%s has a fixed reader refusal code without raw error text", kind => {
      const f = fixture();
      const codes: Record<string, number> = { bodyshape: 6, hidden: 7, transform: 10, tag: 13, inline: 14, link: 11, node: 9, style_fault: 15 };
      if (kind === "bodyshape") f.rich.childNodes.push(element("P"));
      if (kind === "hidden") f.rich.style.visibility = "hidden";
      if (kind === "transform") f.paragraph.style.textTransform = "uppercase";
      if (kind === "tag") f.paragraph.childNodes[0].tagName = "EM";
      if (kind === "inline") f.paragraph.childNodes[0].rendered = "different";
      if (kind === "link") f.link.rendered = "";
      if (kind === "node") f.paragraph.childNodes.push({ nodeType: 8, textContent: "", innerText: "", childNodes: [] });
      if (kind === "style_fault") f.bubble.ownerDocument.defaultView.getComputedStyle = () => { throw Error("credential secret"); };
      const result = find(f);
      expect(result.ok).toBe(false);
      expect(result.diagnostic?.representation).toMatchObject({ richBodyReasonCode: codes[kind], richBodyRebuildSucceeded: false, richBodyExact: false });
      expect(JSON.stringify(result.diagnostic?.representation)).not.toMatch(/credential|secret|ATTEMPT_ID|example\.test/);
    },
  );

  it("does not fold spaces, trim, trust href or take textContent as general authority", () => {
    const f = fixture();
    f.link.attrs.href = url;
    expect(find(f, message.replace("Preserve  spaces", "Preserve spaces")).ok).toBe(false);
    expect(find(f, message + " ").ok).toBe(false);
    f.label.childNodes[0].childNodes[0].nodeValue = "different";
    expect(find(f).ok).toBe(false);
  });

  it("requires modern USER proof, exact parent marker and one body", () => {
    const f = fixture();
    f.bubble.attrs["data-user-message-bubble"] = null;
    f.bubble.attrs["data-message-author-role"] = "assistant";
    expect(find(f).ok).toBe(false);
    f.bubble.attrs["data-user-message-bubble"] = "true";
    f.bubble.rendered = "no marker";
    expect(find(f).ok).toBe(false);
    f.bubble.rendered = `${message}UI`;
    f.bubble.childNodes.push(fixture().rich);
    expect(find(f).ok).toBe(false);
  });

  it("exhaustion, unknown styling and DOM faults fail closed", () => {
    const f = fixture();
    f.paragraph.childNodes.push(...Array.from({ length: 129 }, () => element("SPAN")));
    expect(find(f).ok).toBe(false);
    const large = fixture();
    large.bubble.childNodes.push(...Array.from({ length: 65 }, () => element("DIV")));
    expect(find(large).ok).toBe(false);
    const unknown = fixture();
    unknown.bubble.ownerDocument.defaultView.getComputedStyle = () => { throw Error("unknown"); };
    expect(find(unknown).ok).toBe(false);
  });

  it("baseline and ambiguous independent turns still reject", () => {
    const a = fixture(), b = fixture();
    expect(findCanonicalUserTurn(a.doc, { message, attemptId: ATTEMPT, baseline: snapshotUserTurns(a.doc) }).ok).toBe(false);
    expect(findCanonicalUserTurn({ querySelectorAll: () => [a.bubble, b.bubble] } as never, { message, attemptId: ATTEMPT }).reason).toBe("ambiguous");
  });
});

describe("E1b3d3b2 marker representation diagnostic", () => {
  function makeUserNode(opts: {
    innerText?: string;
    textContent?: string;
    children?: unknown[];
  }) {
    const children = opts.children ?? [];
    return {
      innerText: opts.innerText ?? "",
      textContent: opts.textContent !== undefined ? opts.textContent : (opts.innerText ?? ""),
      children,
      getAttribute: (n: string) => (n === "data-message-author-role" ? "user" : null),
      querySelector: () => null,
      closest: () => null,
    };
  }

  function docWithNodes(nodes: unknown[]) {
    return {
      querySelectorAll: () => nodes,
    } as never;
  }

  it("A. parent has extra UI chars, child exact → observed via message-body fallback", () => {
    // MESSAGE has trailing newline in source; normalize first for fake DOM.
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const child = makeUserNode({ innerText: canonical, textContent: canonical });
    const parent = makeUserNode({
      innerText: `${canonical}Copy\nShare`,
      textContent: `${canonical}Copy\nShare`,
      children: [child],
    });
    const rec = findCanonicalUserTurn(docWithNodes([parent]), {
      message: canonical,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
    const rep = (rec as { diagnostic?: { representation?: Record<string, unknown> } })
      .diagnostic?.representation;
    expect(rep).toBeTruthy();
    expect(rep?.exactInnerTextDescendantCount).toBe(1);
    expect(rep?.exactTextContentDescendantCount).toBe(1);
    expect(rep?.markerInnerTextExact).toBe(false);
    expect(rep?.markerTextContentExact).toBe(false);
    expect(rep?.markerCandidateNormalizedLength).toBeGreaterThan(0);
  });

  it("B. innerText mismatch vs textContent exact on parent", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const node = makeUserNode({
      innerText: `${canonical}Chrome`,
      textContent: canonical,
    });
    const turns = [
      { text: normalizeCanonicalDomText(node.innerText), node },
    ];
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns,
    });
    expect(rep).toBeTruthy();
    expect(rep?.markerInnerTextExact).toBe(false);
    expect(rep?.markerTextContentExact).toBe(true);
  });

  it("C. small char delta → length delta + prefix/suffix counts", () => {
    const canonical = "AAA\nATTEMPT_ID: 22222222-2222-4222-8222-222222222222\nBBB\n";
    const withExtra = "AAA\nATTEMPT_ID: 22222222-2222-4222-8222-222222222222\nBBB\nXXX";
    const node = makeUserNode({ innerText: withExtra, textContent: withExtra });
    const turns = [{ text: normalizeCanonicalDomText(withExtra), node }];
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: "22222222-2222-4222-8222-222222222222",
      turns,
    });
    expect(rep).toBeTruthy();
    expect(rep?.innerLengthDelta).toBe(3);
    expect(rep?.textContentLengthDelta).toBe(3);
    expect(rep?.innerCommonPrefixLength).toBeGreaterThan(0);
    expect(rep?.innerCommonSuffixLength).toBe(0);
  });

  it("D. 0 or >1 marker candidates → representation null (fail closed)", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const node = makeUserNode({ innerText: "no marker here" });
    expect(buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: "no marker here", node }],
    })).toBeNull();
    const n1 = makeUserNode({ innerText: canonical });
    const n2 = makeUserNode({ innerText: canonical });
    expect(buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [
        { text: normalizeCanonicalDomText(canonical), node: n1 },
        { text: normalizeCanonicalDomText(canonical), node: n2 },
      ],
    })).toBeNull();
  });

  it("E/A-review. >1000 descendants: DOM access hard-capped at 64, not just result array", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const readIds = new Set<number>();
    const maxDesc = TURN_DIAGNOSTIC_LIMITS.maxDescendantsScanned;
    const many = Array.from({ length: 1200 }, (_, i) => ({
      get innerText() {
        readIds.add(i);
        return `child-${i}`;
      },
      get textContent() {
        readIds.add(i);
        return `child-${i}`;
      },
      children: [] as unknown[],
    }));
    const parent = makeUserNode({
      innerText: canonical,
      textContent: canonical,
      children: many,
    });
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: normalizeCanonicalDomText(canonical), node: parent }],
    });
    expect(rep?.descendantScannedCount).toBe(maxDesc);
    expect(rep?.descendantScannedCount).toBeLessThanOrEqual(64);
    // Real DOM access bound: node id >= 64 must never be read.
    expect(readIds.size).toBeGreaterThan(0);
    expect(readIds.size).toBeLessThanOrEqual(maxDesc);
    for (const id of readIds) {
      expect(id).toBeLessThan(maxDesc);
    }
    expect(readIds.has(64)).toBe(false);
    expect(readIds.has(999)).toBe(false);
  });

  it("B-review. descendant innerText empty + textContent exact → independent counts", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const child = {
      get innerText() {
        return "";
      },
      get textContent() {
        return canonical;
      },
      children: [],
    };
    const parent = makeUserNode({
      innerText: `${canonical}Copy`,
      textContent: `${canonical}Copy`,
      children: [child],
    });
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: normalizeCanonicalDomText(parent.innerText), node: parent }],
    });
    expect(rep?.exactInnerTextDescendantCount).toBe(0);
    expect(rep?.exactTextContentDescendantCount).toBe(1);
  });

  it("C-review. descendant innerText exact + textContent mismatch → reverse counts", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const child = {
      get innerText() {
        return canonical;
      },
      get textContent() {
        return `${canonical}EXTRA`;
      },
      children: [],
    };
    const parent = makeUserNode({
      innerText: `${canonical}Copy`,
      textContent: `${canonical}Copy`,
      children: [child],
    });
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: normalizeCanonicalDomText(parent.innerText), node: parent }],
    });
    expect(rep?.exactInnerTextDescendantCount).toBe(1);
    expect(rep?.exactTextContentDescendantCount).toBe(0);
  });

  it("F. sanitizer strips raw text/DOM/credential", () => {
    const safe = sanitizeMarkerRepresentation({
      markerCandidateIndex: 0,
      markerInnerTextExact: false,
      markerTextContentExact: true,
      message: MESSAGE,
      html: "<div>secret</div>",
      credential: "x",
      documentId: "d",
      tabId: 1,
    });
    expect(safe).toBeTruthy();
    expect((safe as Record<string, unknown>).message).toBeUndefined();
    expect((safe as Record<string, unknown>).html).toBeUndefined();
    expect((safe as Record<string, unknown>).credential).toBeUndefined();
    expect(safe?.markerCandidateIndex).toBe(0);
    expect(safe?.markerTextContentExact).toBe(true);
    const dump = JSON.stringify(sanitizeObservationDiagnostic({
      candidateCount: 1,
      representation: {
        exactInnerTextDescendantCount: 1,
        markerInnerTextExact: false,
        text: MESSAGE,
        message: MESSAGE,
      },
    }));
    expect(dump).not.toContain(MESSAGE);
    expect(dump).not.toContain("ATTEMPT_ID");
  });

  it("review. turn-observer uses bounded children BFS, not querySelectorAll(*)", () => {
    const src = fs.readFileSync(path.join(companionRoot, "turn-observer.js"), "utf8");
    expect(src).toMatch(/collectBoundedDescendants/);
    expect(src).toMatch(/maxDescendantsScanned/);
    // Representation path must not use unbounded selector scan.
    const start = src.indexOf("export function buildMarkerRepresentationDiagnostic");
    const end = src.indexOf("export function sanitizeMarkerRepresentation");
    const body = src.slice(start, end);
    expect(body).toMatch(/collectBoundedDescendants/);
    expect(body).not.toMatch(/querySelectorAll\("\*"\)/);
    expect(body).not.toMatch(/rawInnerTextOf\(d\) \|\| rawTextContentOf/);
  });
});
