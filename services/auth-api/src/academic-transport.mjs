import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

function unsafeAddress() {
  const error = new Error("Academic target address is not public");
  error.code = "ACADEMIC_UNSAFE_ADDRESS";
  return error;
}

function publicAddress(value) {
  try { return ipaddr.process(value).range() === "unicast"; }
  catch { return false; }
}

// Resolve inside the socket connector and return these exact validated IPs.
// A separate DNS preflight followed by a second lookup would allow rebinding.
export function createPublicLookup(lookup = systemLookup) {
  return (hostname, options, callback) => {
    Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })).then((records) => {
      if (!Array.isArray(records) || !records.length || records.some((record) =>
        !publicAddress(record.address) || isIP(record.address) !== record.family)) throw unsafeAddress();
      const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
      const selected = family ? records.filter(record => record.family === family) : records;
      if (!selected.length) throw unsafeAddress();
      return selected;
    }).then((records) => options.all ? callback(null, records)
      : callback(null, records[0].address, records[0].family), callback);
  };
}

export function createAcademicTransport() {
  const agent = new Agent({ connections: 2, connect: {
    timeout: 10_000, rejectUnauthorized: true, lookup: createPublicLookup(),
  } });
  return {
    fetch(url, options) {
      const target = new URL(url);
      const hostname = target.hostname.replace(/^\[|\]$/gu, "");
      // Literal addresses bypass DNS lookup; apply the same rule before fetch.
      if (isIP(hostname) && !publicAddress(hostname)) throw unsafeAddress();
      return fetch(target, { ...options, dispatcher: agent });
    },
    close() { void agent.destroy().catch(() => {}); },
  };
}
