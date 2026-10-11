import { CookieJar as RfcCookieJar } from "tough-cookie";

// One in-memory jar per import flow. Host, path, Secure and expiry are all
// interpreted by the maintained RFC 6265 library, never by splitting pairs.
export class AcademicCookieJar {
  #jar = new RfcCookieJar(undefined, { prefixSecurity: "strict" });

  update(response, url) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      this.#jar.setCookieSync(value, String(url), { ignoreError: true });
    }
  }

  header(url) {
    return this.#jar.getCookieStringSync(String(url));
  }

  setVpnSession(name, value, vpn) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || !value || /[;\r\n]/u.test(value)) {
      const error = new Error("ACADEMIC_PROTOCOL_CHANGED");
      error.code = "ACADEMIC_PROTOCOL_CHANGED";
      throw error;
    }
    // The vendor XML TWFID represents the Web VPN session, shared only with
    // mapped hosts beneath this VPN domain. It is not a general SSO cookie.
    this.#jar.setCookieSync(`${name}=${value}; Domain=${vpn.hostname}; Path=/`, vpn.href);
  }

  clear() {
    this.#jar.removeAllCookiesSync();
  }
}
