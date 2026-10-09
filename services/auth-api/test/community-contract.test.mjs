import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCommentCreate,
  validateCommentUpdate,
  validateCommunityReport,
  validateTopicCreate,
  validateTopicUpdate,
  validateVersionedDelete,
} from "../src/community-contract.mjs";

const commentId = "00000000-0000-4000-8000-000000000031";

test("body-first posts derive bounded Unicode titles while explicit titles retain the old minimum", () => {
  for (const title of [undefined, "", " \t "]) {
    assert.deepEqual(validateTopicCreate({ title, body: " 好 " }), {
      title: "好", body: "好", visibility: "public",
    });
  }
  assert.equal(validateTopicCreate({ body: "😀" }).title, "😀");
  assert.equal(validateTopicCreate({ body: "\u200b\n  第一行\n第二行" }).title, "第一行");
  assert.equal(validateTopicCreate({ body: "ＡＢＣＤ\r\n第二行", visibility: "unlisted" }).title, "ABCD");
  for (const title of ["好", "三个字", "😀😀", null, 123, "\u200b".repeat(4)]) {
    assert.equal(validateTopicCreate({ title, body: "有效正文" }), null);
  }
  for (const body of ["", " \n\t", "\u200b\u200d\u2060", "\u0301", "\u2800", "\u3164", "\ud800", "\u0085"]) {
    assert.equal(validateTopicCreate({ title: "这是标题", body }), null, JSON.stringify(body));
  }
  const long = validateTopicCreate({ body: "字".repeat(119) + "😀正文" });
  assert.equal(long.title, "字".repeat(119));
  assert.equal(validateTopicCreate({ body: "😀".repeat(61) }).title, "😀".repeat(60));
  assert.equal(validateTopicCreate({ body: "\u0301".repeat(121) + "好" }).title, "好");
  assert.equal(validateTopicUpdate({ title: "", body: "好", version: 1 }), null);
  assert.equal(validateTopicUpdate({ body: "好", version: 1 }).title, undefined);
  assert.equal(validateTopicCreate({ body: "好", lastReplyAt: "2026-01-01" }), null);
});

test("community topic input is normalized, bounded, and rejects mass assignment", () => {
  assert.deepEqual(
    validateTopicCreate({
      title: "  图书馆\t闭馆后去哪？ ",
      body: " 第一行\r\n第二行 ",
      visibility: "public",
    }),
    {
      title: "图书馆 闭馆后去哪?",
      body: "第一行\n第二行",
      visibility: "public",
    },
  );
  assert.equal(
    validateTopicCreate({ title: "一个主题", body: "正文", status: "published" }),
    null,
  );
  assert.equal(
    validateTopicCreate({ title: "一个主题", body: "x".repeat(5_001) }),
    null,
  );
  assert.deepEqual(
    validateTopicUpdate({ body: "更新正文", version: 2 }),
    {
      title: undefined,
      body: "更新正文",
      visibility: undefined,
      expectedVersion: 2,
    },
  );
  assert.equal(validateTopicUpdate({ version: 2 }), null);
});

test("community comment and delete input require exact versioned contracts", () => {
  assert.deepEqual(
    validateCommentCreate({ body: "回复内容", replyToCommentId: commentId }),
    { body: "回复内容", replyToCommentId: commentId },
  );
  assert.equal(
    validateCommentCreate({ body: "回复", replyToCommentId: "not-a-uuid" }),
    null,
  );
  assert.deepEqual(validateCommentUpdate({ body: "修改", version: 3 }), {
    body: "修改",
    expectedVersion: 3,
  });
  assert.equal(validateVersionedDelete({ version: 1, force: true }), null);
  assert.deepEqual(validateVersionedDelete({ version: 1 }), {
    expectedVersion: 1,
  });
});

test("community reports accept only known targets, reasons, and meaningful detail", () => {
  assert.deepEqual(
    validateCommunityReport({
      targetType: "comment",
      targetId: commentId,
      reasonCode: "harassment",
      detail: "  持续发布针对个人的攻击内容。 ",
    }),
    {
      targetType: "comment",
      targetId: commentId,
      reasonCode: "harassment",
      detail: "持续发布针对个人的攻击内容。",
    },
  );
  assert.equal(
    validateCommunityReport({
      targetType: "comment",
      targetId: commentId,
      reasonCode: "other",
    }),
    null,
  );
  assert.equal(
    validateCommunityReport({
      targetType: "comment",
      targetId: commentId,
      reasonCode: "spam",
      detail: "太短",
    }),
    null,
  );
  assert.equal(
    validateCommunityReport({
      targetType: "comment",
      targetId: commentId,
      reasonCode: "spam",
      status: "resolved",
    }),
    null,
  );
});
