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

const rowspanTimetableHtml = `<!doctype html>
<html><body>
  <div>2026-2027学年第一学期</div>
  <table class="layout"><tr><td>
    <table class="curriculum">
      <thead><tr>
        <th>序号</th><th>课程号</th><th>课程名</th><th>课序号</th>
        <th>学分</th><th>课程属性</th><th>考试类型</th><th>教师</th>
        <th>修读方式</th><th>选课状态</th><th>周次</th><th>星期</th>
        <th>节次</th><th>节数</th><th>校区</th><th>教学楼</th><th>教室</th>
      </tr></thead>
      <tbody>
        <tr>
          <td rowspan=2>1</td><td rowspan=2>31131862</td>
          <td rowspan=2>内部审计</td><td rowspan=2>01</td><td rowspan=2>2</td>
          <td rowspan=2>必修</td><td rowspan=2>考试</td><td rowspan=2>姜博*</td>
          <td rowspan=2>正常</td><td rowspan=2>选中</td>
          <td>1-9周</td><td>1</td><td>1</td><td>2</td>
          <td>校本部</td><td>之远楼</td><td>(5＃)516</td>
        </tr>
        <tr>
          <td>10-18周</td><td>星期三</td><td>5</td><td>3</td>
          <td>校本部</td><td>笃行楼</td><td>403</td>
        </tr>
        <tr>
          <td>2</td><td>51132062</td><td>数字化管理会计</td><td>02</td><td>2</td>
          <td>限选</td><td>考试</td><td>谭袁月* 宋淑琴</td>
          <td>正常</td><td>抽中</td><td>全周</td><td>四</td><td>8-9节</td><td>2</td>
          <td>校本部</td><td>播慧楼</td><td>J4-3</td>
        </tr>
      </tbody>
    </table>
  </td></tr></table>
</body></html>`;

const examHtml = `<!doctype html>
<html><body>
  <div>2026-2027 第一学期</div>
  <table>
    <tr><th>课程编号</th><th>课程名称</th><th>课序号</th><th>考试类型</th><th>考试时间</th><th>考场</th><th>座位号</th><th>状态</th></tr>
    <tr><td>31131862</td><td>内部审计</td><td>01</td><td>期末</td><td>2027年01月08日 09:00-11:00</td><td>校本部 / 梅园 / 201</td><td>18</td><td>已安排</td></tr>
  </table>
</body></html>`;

const casLoginHtml = `<!doctype html>
<html><head><title>统一身份认证中心</title></head><body>
  <form method="post" action="">
    <input type="hidden" name="fingerprint" value="">
    <input type="text" name="username" value="">
    <input type="hidden" name="password" value="">
    <input type="hidden" name="verify_token" value="">
    <input type="hidden" name="verify_code" value="">
    <input type="hidden" name="__token__" value="csrf-test-token">
  </form>
  <script>
    key = CryptoJS.enc.Utf8.parse('12793ff634e57cd59df06598e3be5482'.substr(0,16));
  </script>
</body></html>`;

const sliderToken = "testslider".repeat(4);

const sliderChallenge = JSON.stringify({
  code: 1,
  data: {
    token: sliderToken,
    bg: "data:image/png;base64,iVBORw0KGgo=",
    block: "data:image/png;base64,iVBORw0KGgo=",
  },
});

test("week parser preserves ranges and odd/even week sets", () => {
  assert.deepEqual(parseWeeks("1-9周"), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(parseWeeks("9-18周"), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(parseWeeks("1-8周(单周)"), [1, 3, 5, 7]);
  assert.deepEqual(parseWeeks("1-8周上"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseWeeks("前八周"), [1, 2, 3, 4, 5, 6, 7, 8]);
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

test("timetable parser expands rowspans and separate meeting columns", () => {
  const parsed = parseTimetableHtml(rowspanTimetableHtml);
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].courseName, "内部审计");
  assert.equal(parsed.sections[0].meetings.length, 2);
  assert.deepEqual(parsed.sections[0].meetings[0].periods, [1, 2]);
  assert.deepEqual(parsed.sections[0].meetings[1].periods, [5, 6, 7]);
  assert.equal(parsed.sections[0].meetings[1].weekday, 3);
  assert.equal(parsed.sections[0].meetings[1].room, "403");
  assert.equal(parsed.sections[1].meetings.length, 1);
  assert.deepEqual(parsed.sections[1].meetings[0].weeks, [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  ]);
  assert.deepEqual(parsed.sections[1].teachers, ["谭袁月", "宋淑琴"]);
});

test("timetable parser rejects false success when no meeting was decoded", () => {
  const html = timetableHtml.replace(
    /1-9周 \/ 星期一 \/ 1-2节<br>10-18周 \/ 星期三 \/ 5-7节|2-18 周 \/ 星期四 \/ 8-9节/gu,
    "待安排",
  );
  assert.throws(() => parseTimetableHtml(html), {
    code: "ACADEMIC_TIMETABLE_FORMAT_CHANGED",
  });
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
          ? "<Auth><ErrorCode>20021</ErrorCode><TwfID>authenticated-session</TwfID></Auth>"
          : "<Auth><ErrorCode>20012</ErrorCode></Auth>",
      );
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      assert.match(options.headers.Cookie, /TWFID=authenticated-session/u);
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

test("connector follows school WebVPN resource redirects after SMS login", async () => {
  const challenge = rsaChallengeXml();
  const redirectedHost = "202-199-165-193.vpn.dufe.edu.cn:8118";
  const fetchImpl = async (url) => {
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
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><TwfID>authenticated-session</TwfID></Auth>",
      );
    }
    if (
      parsed.hostname === "zhjw-dufe-edu-cn.vpn.dufe.edu.cn" &&
      parsed.pathname.includes("thisSemesterCurriculum")
    ) {
      return response("", {
        status: 302,
        headers: {
          location: `http://${redirectedHost}${parsed.pathname}`,
        },
      });
    }
    if (
      parsed.host === redirectedHost &&
      parsed.pathname.includes("thisSemesterCurriculum")
    ) {
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
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.equal(completed.snapshot.sections.length, 2);
});

test("connector completes the school CAS slider step before importing", async () => {
  const challenge = rsaChallengeXml();
  const ssoHost = "sso-dufe-edu-cn.vpn.dufe.edu.cn:8118";
  const timetablePath = "/student/courseSelect/thisSemesterCurriculum/index";
  const serviceUrl = `http://zhjw-dufe-edu-cn.vpn.dufe.edu.cn:8118${timetablePath}`;
  let casSubmissions = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const cookies = String(options.headers?.Cookie ?? "");
    if (parsed.pathname === "/por/login_auth.csp") return response(challenge);
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><NextService>sms</NextService></Auth>",
      );
    }
    if (parsed.pathname === "/por/login_sms.csp") {
      return response(
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode><TwfID>vpn-session</TwfID></Auth>");
    }
    if (parsed.host === ssoHost && parsed.pathname === "/auth/cas/login") {
      if ((options.method ?? "GET") === "POST") {
        casSubmissions += 1;
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("username"), "20260001");
        assert.equal(form.get("password"), "R6ANtscKUJD0ksbUwLNNDw==");
        assert.ok(!String(options.body).includes("test-password"));
        assert.equal(form.get("verify_token"), sliderToken);
        assert.match(form.get("verify_code"), /^11[67]$/u);
        assert.equal(form.get("__token__"), "csrf-test-token");
        assert.match(form.get("fingerprint"), /^[a-f0-9]{32}$/u);
        if (form.get("verify_code") === "116") {
          return response(casLoginHtml);
        }
        return response("", {
          status: 302,
          headers: {
            location: serviceUrl,
            "set-cookie": "SSO_SESSION=ready; Path=/",
          },
        });
      }
      return response(casLoginHtml, {
        headers: { "set-cookie": "SSO_PRE=session; Path=/" },
      });
    }
    if (parsed.host === ssoHost && parsed.pathname === "/auth/widget") {
      assert.equal(options.method, "POST");
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("width"), "280");
      assert.equal(form.get("height"), "155");
      assert.equal(form.get("block_size"), "80");
      return response(sliderChallenge, {
        headers: { "content-type": "application/json" },
      });
    }
    if (parsed.pathname === timetablePath) {
      if (/SSO_SESSION=ready/u.test(cookies)) {
        return response(timetableHtml, {
          headers: { "set-cookie": "ACADEMIC_SESSION=ready; Path=/" },
        });
      }
      return response("", {
        status: 302,
        headers: {
          location: `http://${ssoHost}/auth/cas/login?service=${encodeURIComponent(serviceUrl)}`,
        },
      });
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
  const prompted = await connector.verifySms({
    transactionId: started.transactionId,
    code: "123456",
    principalKey: "device:test",
  });
  assert.equal(prompted.status, "sso_verification_required");
  assert.equal(prompted.challenge.width, 280);
  assert.equal(prompted.challenge.pieceWidth, 80);
  assert.equal(prompted.challenge.maxOffset, 240);
  assert.match(prompted.challenge.backgroundImage, /^data:image\/png;base64,/u);
  assert.equal(connector.pendingCount(), 1);

  const retried = await connector.verifySso({
    transactionId: started.transactionId,
    verifyCode: "116",
    principalKey: "device:test",
  });
  assert.equal(retried.status, "sso_verification_required");
  assert.equal(retried.verificationFailed, true);
  assert.equal(connector.pendingCount(), 1);

  const completed = await connector.verifySso({
    transactionId: started.transactionId,
    verifyCode: "117",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.equal(completed.snapshot.sections.length, 2);
  assert.equal(completed.snapshot.exams.length, 1);
  assert.equal(casSubmissions, 2);
  assert.equal(connector.pendingCount(), 0);
});

test("connector rejects external redirects and retains verified SMS sessions for retry", async () => {
  const challenge = rsaChallengeXml();
  let timetableAttempts = 0;
  let smsVerificationAttempts = 0;
  const fetchImpl = async (url) => {
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
        "<Auth><ErrorCode>1</ErrorCode><USER_PHONE>138****0000</USER_PHONE></Auth>",
      );
    }
    if (parsed.pathname === "/por/post_sms.csp") {
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname === "/por/login_sms1.csp") {
      smsVerificationAttempts += 1;
      return response("<Auth><ErrorCode>1</ErrorCode></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      timetableAttempts += 1;
      if (timetableAttempts === 1) {
        return response("", {
          status: 302,
          headers: { location: "https://attacker.example/capture" },
        });
      }
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
  await assert.rejects(
    connector.verifySms({
      transactionId: started.transactionId,
      code: "123456",
      principalKey: "device:test",
    }),
    (error) => {
      assert.equal(error.code, "ACADEMIC_UNTRUSTED_REDIRECT");
      assert.equal(error.stage, "timetable_fetch");
      assert.equal(error.retryable, true);
      assert.equal(
        error.diagnostic.redirectFromOrigin,
        "http://zhjw-dufe-edu-cn.vpn.dufe.edu.cn:8118",
      );
      assert.equal(
        error.diagnostic.redirectToOrigin,
        "https://attacker.example",
      );
      assert.equal(error.diagnostic.redirectStatus, 302);
      return true;
    },
  );
  assert.equal(connector.pendingCount(), 1);
  const completed = await connector.verifySms({
    transactionId: started.transactionId,
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
  assert.equal(smsVerificationAttempts, 1);
  assert.equal(connector.pendingCount(), 0);
});

test("connector accepts the official redirect-range auth completion codes", async () => {
  const challenge = rsaChallengeXml();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/por/login_auth.csp") {
      return response(challenge, { headers: { "set-cookie": "TWFID=abc; Path=/" } });
    }
    if (parsed.pathname === "/public/psw_config") return response(challenge);
    if (parsed.pathname === "/por/login_psw.csp") {
      return response("<Auth><ErrorCode>40001</ErrorCode><TwfID>redirect-session</TwfID></Auth>");
    }
    if (parsed.pathname.includes("thisSemesterCurriculum")) {
      return response(timetableHtml);
    }
    if (parsed.pathname.includes("examPlan")) return response(examHtml);
    throw new Error(`unexpected request: ${parsed}`);
  };
  const connector = createAcademicConnector({ fetchImpl });
  const completed = await connector.start({
    username: "20260001",
    password: "test-password",
    principalKey: "device:test",
  });
  assert.equal(completed.status, "imported");
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
