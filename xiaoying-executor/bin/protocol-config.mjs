#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  applyTraceIntProtocolConfig,
  loadTraceIntProtocolConfig,
  rollbackTraceIntProtocolConfig,
} from "../src/traceint-protocol-config.mjs";

const configPath =
  process.env.XIAOYING_TRACEINT_PROTOCOL_PATH ??
  fileURLToPath(new URL("../.local-data/traceint-protocol.json", import.meta.url));
const [command = "show", argument] = process.argv.slice(2);

function print(state) {
  process.stdout.write(
    `${JSON.stringify(
      {
        configPath,
        activeVersion: state.activeVersion,
        source: state.source,
        updatedAt: state.updatedAt,
        history: state.history,
        protocol: state.protocol,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  if (command === "show") {
    print(await loadTraceIntProtocolConfig(configPath));
  } else if (command === "apply") {
    if (!argument) throw new Error("请提供协议配置 JSON 文件路径");
    const input = JSON.parse(await readFile(argument, "utf8"));
    print(await applyTraceIntProtocolConfig(configPath, input));
  } else if (command === "rollback") {
    if (!argument) throw new Error("请提供要恢复的协议版本");
    print(await rollbackTraceIntProtocolConfig(configPath, argument));
  } else {
    throw new Error("命令只支持 show、apply 或 rollback");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
