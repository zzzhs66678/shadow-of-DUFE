import assert from "node:assert/strict";
import test from "node:test";
import { AcademicCookieJar } from "../src/academic-cookie-jar.mjs";

const vpn = new URL("https://vpn.dufe.edu.cn");
const sso = "https://sso.vpn.dufe.edu.cn/auth/login";

test("school cookies respect host, path, TLS and expiry across redirects", () => {
  const jar = new AcademicCookieJar();
  const headers = new Headers();
  headers.append("Set-Cookie", "HOST=host-only; Path=/; Secure");
  headers.append("Set-Cookie", "PATH=restricted; Path=/auth; Secure");
  headers.append("Set-Cookie", "VPN=shared; Domain=vpn.dufe.edu.cn; Path=/; Secure");
  headers.append("Set-Cookie", "GONE=expired; Max-Age=0; Path=/");
  jar.update(new Response("", { headers }), sso);
  assert.match(jar.header(sso), /HOST=host-only/);
  assert.match(jar.header(sso), /PATH=restricted/);
  assert.doesNotMatch(jar.header("https://sso.vpn.dufe.edu.cn/other"), /PATH=/);
  assert.equal(jar.header("http://sso.vpn.dufe.edu.cn/auth/login"), "");
  assert.equal(jar.header("https://school.vpn.dufe.edu.cn/"), "VPN=shared");
  assert.equal(jar.header("https://evil.example/"), "");
  assert.doesNotMatch(jar.header(sso), /GONE=/);
  jar.clear();
  assert.equal(jar.header(sso), "");
});

test("each school import owns its own jar and rejects foreign-domain cookies", () => {
  const a = new AcademicCookieJar();
  const b = new AcademicCookieJar();
  a.setVpnSession("TWFID", "synthetic-flow-a", vpn);
  a.update(new Response("", { headers: { "Set-Cookie": "FOREIGN=secret; Domain=evil.example; Path=/" } }), vpn);
  assert.equal(b.header(sso), "");
  assert.equal(a.header(sso), "TWFID=synthetic-flow-a");
  assert.equal(a.header("https://evil.example/"), "");
  assert.throws(() => a.setVpnSession("TWFID", "bad\r\nheader", vpn));
});
