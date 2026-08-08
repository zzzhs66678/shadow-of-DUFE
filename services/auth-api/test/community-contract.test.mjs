import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCommentCreate,
  validateCommentUpdate,
  validateTopicCreate,
  validateTopicUpdate,
  validateVersionedDelete,
} from "../src/community-contract.mjs";

const commentId = "00000000-0000-4000-8000-000000000031";

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
