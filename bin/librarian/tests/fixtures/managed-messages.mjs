import assert from "node:assert/strict";

export const first = {
  prompt: "请读取甲样区记录。",
  answer: "甲样区记录了十二只白鹭。",
  model: "field-observer",
  level: "low",
};
export const comparison = {
  prompt: "和乙样区相比呢？",
  answer: "乙样区十九只，较甲样区多七只。",
  model: "field-compare",
  level: "high",
};
export const materialTurn = {
  ...first,
  prompt: "请读取预算和会议文件，核对两个数字。",
  answer: "预算为七十，复核数字为四十二。",
};
export const acrossSpaces = {
  ...first,
  prompt: "比较田野笔记和河口调查的普查记录，给出两处来源。",
  answer: "田野笔记记录十只，河口调查记录二十只。",
};
export const followUpAcrossSpaces = {
  ...first,
  prompt: "两处相差多少？",
  answer: "河口调查比田野笔记多十只。",
};
const thought = "PRIVATE_FIXTURE_THINKING_2B87";
const signature = "PRIVATE_FIXTURE_SIGNATURE_41AD";
const toolPhase = "PRIVATE_FIXTURE_TOOL_STAGE_763E";
const fixtureCredential = "provider-fixture-only";
export const privateMarkers = [thought, signature, toolPhase, fixtureCredential];
const roundsBeforeAnswer = new Map([
  [first, 3],
  [comparison, 4],
  [materialTurn, 5],
  [acrossSpaces, 6],
  [followUpAcrossSpaces, 1],
]);
const precedingTurn = new Map([
  [comparison, first],
  [followUpAcrossSpaces, acrossSpaces],
]);

function toolResult(body, id) {
  const result = body.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === "tool_result" && b.tool_use_id === id);
  assert.ok(result && !result.is_error, "Expected successful tool receipt " + id);
  return JSON.parse(Array.isArray(result.content) ? result.content[0].text : result.content);
}

export function createMessagesScenario(message) {
  const gates = new Map();
  const finished = [];
  let failure;
  async function respond({ body, headers, url }, res) {
    try {
      assert.equal(
        headers["x-api-key"],
        fixtureCredential,
        "Runner did not send the fixture credential",
      );
      assert.equal(url, "/anthropic/v1/messages");
      assert.equal(body.stream, true);
      const input = JSON.parse(body.messages[0].content[0].text);
      const turn = [...roundsBeforeAnswer.keys()].find((t) => input.prompt === t.prompt);
      assert.ok(turn, "Unexpected current prompt");
      assert.equal(body.model, turn.model);
      assert.deepEqual(body.thinking, { type: "enabled" });
      assert.deepEqual(body.output_config, { effort: turn.level });
      const round = body.messages.filter((m) => m.role === "assistant").length;
      if (round === 0) {
        assert.deepEqual(
          body.messages.map((m) => m.role),
          ["user"],
        );
        const previous = precedingTurn.get(turn);
        assert.deepEqual(
          input.history,
          previous ? [{ prompt: previous.prompt, answer: previous.answer }] : [],
        );
        for (const marker of privateMarkers) assert.ok(!JSON.stringify(input).includes(marker));
        assert.ok(!gates.has(turn), "Duplicate initial provider request");
        gates.set(turn, Promise.withResolvers());
      }
      // The provider requires exact signatures on SAME-turn tool continuations.
      for (const assistant of body.messages.filter((m) => m.role === "assistant"))
        assert.deepEqual(assistant.content[0], { type: "thinking", thinking: thought, signature });
      const send = (fields) => message(res, { thought, signature, ...fields });
      const tool = (id, name, args) => {
        assert.ok(
          body.tools?.some((t) => t.name === name),
          "Managed runner did not register " + name,
        );
        return send({ tool: name, toolId: id, args });
      };
      if (!body.tools) {
        // A script cannot supply an answer before the previous tool receipts were validated.
        assert.equal(round, roundsBeforeAnswer.get(turn));
        await send({ text: turn.answer, beforeEnd: () => gates.get(turn).promise });
        finished.push(turn);
        return;
      }
      if (turn === followUpAcrossSpaces) return send({ text: toolPhase });
      if (turn === acrossSpaces) {
        if (round === 0) return tool("spaces", "list_workspaces", {});
        const { workspaces } = toolResult(body, "spaces");
        const workspace = workspaces.find(
          (item) => item.name === (round < 3 ? "田野笔记" : "河口调查"),
        );
        assert.ok(workspace);
        if (round === 1 || round === 3) {
          if (round === 3) assert.match(toolResult(body, "read-field").markdown, /记录十只。/);
          return tool("find-" + workspace.id, "search_workspace", {
            workspaceId: workspace.id,
            query: "普查记录",
          });
        }
        if (round === 2 || round === 4) {
          const { documents } = toolResult(body, "find-" + workspace.id);
          const doc = documents.find((item) => item.path === "普查记录.md");
          assert.ok(doc);
          return tool(round === 2 ? "read-field" : "read-river", "read_document", {
            documentId: doc.id,
          });
        }
        assert.match(toolResult(body, "read-river").markdown, /记录二十只。/);
      } else if (turn === materialTurn) {
        const files = input.materials;
        assert.equal(files?.length, 2, "Expected selected material metadata");
        const file = files.find((f) => f.name === (round < 2 ? "budget.pdf" : "meeting.docx"));
        if (round === 0 || round === 2) {
          if (round === 2)
            assert.ok(JSON.stringify(toolResult(body, "pdf-read")).includes("预算为七十。"));
          return tool(round === 0 ? "pdf-list" : "docx-list", "list_material_segments", {
            materialId: file.id,
            query: round === 0 ? "预算" : "复核",
          });
        }
        if (round === 1 || round === 3) {
          const kind = round === 1 ? "pdf" : "docx";
          const { items } = toolResult(body, kind + "-list");
          assert.equal(items.length, 1);
          return tool(kind + "-read", "read_material", {
            materialId: file.id,
            segmentId: items[0].segmentId,
          });
        }
        assert.ok(JSON.stringify(toolResult(body, "docx-read")).includes("复核数字为四十二。"));
      } else {
        if (round === 0)
          return tool("find-documents", "search_workspace", {
            query: turn === first ? "甲样区" : "样区",
          });
        const docs = toolResult(body, "find-documents").documents;
        if (round === 1) {
          const doc = docs.find((d) => d.path === "甲样区.md");
          assert.ok(doc, "Workspace search did not return 甲样区.md");
          return tool("read-A", "read_document", { documentId: doc.id });
        }
        assert.match(toolResult(body, "read-A").markdown, /甲样区记录十二只白鹭。/);
        if (turn === comparison && round === 2) {
          const doc = docs.find((d) => d.path === "乙样区.md");
          assert.ok(doc, "Workspace search did not return 乙样区.md");
          return tool("read-B", "read_document", { documentId: doc.id });
        }
        if (turn === comparison)
          assert.match(toolResult(body, "read-B").markdown, /乙样区记录十九只白鹭。/);
      }
      return send({ text: toolPhase });
    } catch (error) {
      failure = error.message;
      res.destroy();
    }
  }
  return { respond, gates, finished, failure: () => failure };
}
