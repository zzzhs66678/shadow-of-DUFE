import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createAcademicConnector,
  parseExamHtml,
  parseTimetableHtml,
  parseWeeks,
} from "../services/auth-api/src/academic-access.mjs";

const timetableHtml = `<!doctype html>
<html><body>
  <nav>2026-2027学年第一学期 第5周</nav>
  <table><tr><th>节次/时间</th><th>星期一</th></tr></table>
  <table>
    <thead><tr>
      <th>课程号</th><th>课程名</th><th>课序号</th><th>学分</th>
      <th>课程属性</th><th>课程类别</th><th>考试类型</th><th>教师</th>
      <th>修读方式</th><th>选课状态</th><th>时间</th><th>地点</th>
    </tr></thead>
    <tbody>
      <tr>
        <td>31131862</td><td>内部审计</td><td>01</td><td>2</td>
        <td>必修</td><td>专业必修</td><td>考试</td><td>姜博*</td>
        <td>正常</td><td>选中</td>
        <td>1-9周 / 星期一 / 1-2节<br>10-18周 / 星期三 / 5-7节</td>
        <td>校本部 / 之远楼 / (5＃)516<br>校本部 / 笃行楼 / 403</td>
      </tr>
      <tr>
        <td>51132062</td><td>数字化管理会计</td><td>02</td><td>2</td>
        <td>限选</td><td>专业选修</td><td>考试</td><td>谭袁月* 宋淑琴</td>
        <td>正常</td><td>抽中</td>
        <td>2-18 周 / 星期四 / 8-9节</td>
        <td>校本部 / 播慧楼 / J4-3</td>
      </tr>
    </tbody>
  </table>
</body></html>`;

const examHtml = `<!doctype html>
<html><body>
  <div>2026-2027 第一学期</div>
  <table>
    <tr><th>课程编号</th><th>课程名称</th><th>课序号</th><th>考试类型</th><th>考试时间</th><th>考场</th><th>座位号</th><th>状态</th></tr>
    <tr><td>31131862</td><td>内部审计</td><td>01</td><td>期末</td><td>2027年01月08日 09:00-11:00</td><td>校本部 / 梅园 / 201</td><td>18</td><td>已安排</td></tr>
  </table>
</body></html>`;

test("week parser preserves ranges and odd/even week sets", () => {
  assert.deepEqual(parseWeeks("1-9周"), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseWeeks("9-18周"), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(parseWeeks("1-8周(单周)"), [1, 3, 5, 7]);
});

test("timetable parser keeps teaching sections and multiple meetings", () => {
  const parsed = parseTimetableHtml(timetableHtml);
  assert.equal(parsed.term.id, "2026-2027-fall");
  assert.equal(parsed.sections.length, 2);
  assert.deepEqual(parsed.sections[0].teachers, ["姜博"]);
  assert.equal(parsed.sections[0].meetings.length, 2);
  assert.deepEqual(parsed.sections[0].meetings[0].periods, [1, 2]);
  assert.deepEqual(parsed.sections[0].meetings[0].weeks, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(parsed.sections[0].meetings[1].block, 3);
  assert.equal(parsed.sections[0].meetings[1].room, "403");
  assert.deepEqual(parsed.sections[1].teachers, ["谭袁月", "宋淑琴"]);
});

test("exam parser accepts combined date/time and location fields", () => {
  const term = parseTimetableHtml(timetableHtml).term;
  const exams = parseExamHtml(examHtml, term);
  assert.equal(exams.length, 1);
  assert.equal(exams[0].date, "2027-01-08");
  assert.equal(exams[0].startTime, "09:00");
  assert.equal(exams[0].endTime, "11:00");
  assert.equal(exams[0].building, "梅园");
  assert.equal(exams[0].seat, "18");
});

test("exam parser distinguishes an explicit empty result from an unknown page", () => {
  const term = parseTimetableHtml(timetableHtml).term;
  assert.deepEqual(
    parseExamHtml("<html><body>暂无考试安排</body></html>", term),
    [],
  );
  assert.throws(
    () => parseExamHtml("<html><body>登录状态失效</body></html>", term),
    { code: "ACADEMIC_EXAM_FORMAT_CHANGED" },
  );
});

function rsaChallengeXml() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const modulus = Buffer.from(
    jwk.n.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((jwk.n.length + 3) % 4),
    "base64",
  ).toString("hex");
  return `<?xml version="1.0"?><Auth><ErrorCode>1</ErrorCode><CSRF_RAND_CODE>123456789</CSRF_RAND_CODE><RSA_ENCRYPT_KEY>${modulus}</RSA_ENCRYPT_KEY><RSA_ENCRYPT_EXP>65537</RSA_ENCRYPT_EXP></Auth>`;
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

test("connector performs encrypted login and imports both official pages", async () => {
  const challenge = rsaChallengeXml();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ parsed, options });
    if (parsed.pathname === "/por/login_auth.csp") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("svpn_name"), "20260001");
      assert.notEqual(form.get("svpn_password"), "test-password");
      assert.ok(!String(options.body).includes("test-password"));
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>", {
        headers: { "set-cookie": "SVPNCOOKIE=session; Path=/" },
      });
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      assert.match(options.headers.Cookie, /SVPNCOOKIE=session/u);
      return response(timetableHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({
    fetchImpl,
    now: () => Date.parse("2026-09-28T01:02:03.000Z"),
  });
  const result = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(result.status, "imported");
  assert.equal(result.snapshot.id, "2026-2027-fall");
  assert.equal(result.snapshot.sections.length, 2);
  assert.equal(result.snapshot.exams.length, 1);
  assert.equal(result.snapshot.importedAt, "2026-09-28T01:02:03.000Z");
  assert.equal(requests.length, 5);
});

test("connector uses the official single-bound-phone SMS endpoints", async () => {
  const challenge = rsaChallengeXml();
  const paths = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (parsed.pathname === "/por/login_auth.csp") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
        { headers: { "set-cookie": "SVPNCOOKIE=session; Path=/" } },
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("phone_number"), "");
      assert.equal(form.get("phone_index"), "0");
      return response("<Auth><ErrorCode>1</ErrorCode><SmsSendInterval>60</SmsSendInterval></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      const code = new URLSearchParams(options.body).get("svpn_inputsms");
      return response(
        code === "123456"
          ? "<Auth><ErrorCode>1</ErrorCode></Auth>"
          : "<Auth><ErrorCode>20012</ErrorCode></Auth>",
      );
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      return response(timetableHtml);
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(started.status, "sms_required");
  assert.equal(started.maskedPhone, "138****0000");
  assert.equal(connector.pendingCount(), 1);
  await assert.rejects(
    connector.verifySms({
      transactionId: started.transactionId,
      code: "654321",
      principalKey: "device:test",
    }),
    { code: "ACADEMIC_SMS_INVALID" },
  );
  assert.equal(connector.pendingCount(), 1);
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.ok(paths.includes("/por/post_sms.csp"));
  assert.ok(paths.includes("/por/login_sms1.csp"));
  assert.ok(!paths.includes("/por/get_sms.csp"));
  assert.ok(!paths.includes("/por/login_sms2.csp"));
  assert.equal(connector.pendingCount(), 0);
});

test("connector requests a phone only when the school account has none", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode><USER_PHONE></USER_PHONE></Auth>");
    }
    if (parsed.pathname === "/por/get_sms.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("phone_number"), "13800000000");
      assert.equal(form.get("phone_index"), "0");
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms2.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) return response(timetableHtml);
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(started.status, "sms_destination_required");
  assert.equal(started.destination, "enter");
  assert.deepEqual(started.phoneOptions, []);
  const sent = await connector.sendSms({
    transactionId: started.transactionId,
    phone: "13800000000",
    principalKey: "device:test",
  });
  assert.equal(sent.status, "sms_required");
  assert.equal(sent.maskedPhone, "138****0000");
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
});

test("connector lets users choose among multiple school phone records", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>139****1111;138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/get_sms.csp") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("phone_number"), "138****0000");
      assert.equal(form.get("phone_index"), "1");
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms2.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) return response(timetableHtml);
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const started = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(started.status, "sms_destination_required");
  assert.equal(started.destination, "choose");
  assert.deepEqual(started.phoneOptions, [
    { index: 0, label: "139****1111" },
    { index: 1, label: "138****0000" },
  ]);
  await connector.sendSms({
    transactionId: started.transactionId,
    phoneIndex: "1",
    principalKey: "device:test",
  });
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
});

test("connector maps invalid school credentials without retaining a transaction", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp" || parsed.pathname === "/public/psw_config") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    return response(
      "<Auth><ErrorCode>20004</ErrorCode><Message>Invalid username or password!</Message></Auth>",
    );
  };
  const connector = createAcademicConnector({ fetchImpl });
  await assert.rejects(
    connector.start({
      username: "invalid",
      password: "invalid",
      principalKey: "device:test",
    }),
    { code: "ACADEMIC_INVALID_CREDENTIALS" },
  );
  assert.equal(connector.pendingCount(), 0);
});
