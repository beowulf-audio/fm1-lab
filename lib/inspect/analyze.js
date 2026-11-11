// analyze.js — static checks on a decoded FM-1 package. Pure functions, browser + Node.
import { parsePackage } from "./fwsc.js";

export const FLASH = {
  PUYA: { id: 0x856014, name: "Puya P25Q80 (original FM-1 flash)", le: [0x14, 0x60, 0x85, 0x00] },
  UC25: { id: 0xb36014, name: "UC25HQ80 (flash in newer FM-1 units)", le: [0x14, 0x60, 0xb3, 0x00] },
};
const FM1_CHIP_KEY = 0x980f;

// ---------------------------------------------------------------- byte helpers
export function indexOfBytes(hay, needle, from = 0) {
  const n = needle.length, first = needle[0];
  outer: for (let i = hay.indexOf(first, from); i !== -1 && i <= hay.length - n; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < n; j++) if (needle[j] !== -1 && hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
const has = (hay, needle) => indexOfBytes(hay, needle) !== -1;
function countBytes(hay, needle, cap = 50) {
  let c = 0;
  for (let i = indexOfBytes(hay, needle); i !== -1 && c < cap; i = indexOfBytes(hay, needle, i + 1)) c++;
  return c;
}

/** printable ASCII runs of length >= min */
export function strings(buf, min = 5) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    if (c >= 0x20 && c < 0x7f) { if (s < 0) s = i; }
    else { if (s >= 0 && i - s >= min) out.push(String.fromCharCode(...buf.subarray(s, Math.min(i, s + 400)))); s = -1; }
  }
  return out;
}

// ---------------------------------------------------------------- capability markers (on decrypted code + strings)
const MARKERS = {
  wifi:      { label: "Wi-Fi",            re: /\bssid\b|wpa_supplicant|wpa2|\bwlan\b|wifi_|wifi |WIFI/i },
  tcpip:     { label: "TCP/IP stack",     re: /\blwip\b|tcp_(write|connect|output)|dhcp|dns_gethostbyname|getaddrinfo|udp_sendto|netconn_/i },
  http:      { label: "HTTP client",      re: /HTTP\/1\.[01]|^GET \/|Host: |User-Agent|Content-Length|\bhttp_client|httpc_/im },
  tls:       { label: "TLS (HTTPS)",      re: /mbedtls|wolfssl|BEGIN CERTIFICATE|TLSv1|tls_open/i },
  bluetooth: { label: "Bluetooth stack",  re: /\bbtstack\b|\bgatt\b|\bl2cap\b|\bhci_|a2dp|\bble_|nimble|bt_adv/i },
};
const URL_RE = /(?:https?|wss?|mqtt|ftp):\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/gi;
const HOST_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|me|co|cn|ru|de|uk|fm|gg|xyz|cloud|site|info|biz|top|tk)\b/gi;
const IP_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const BENIGN_HOST = /(^|\.)(github\.com|github\.io|githubusercontent\.com|doi\.org|m-vave\.com|cuvave\.com|example\.(com|org|net)|wikipedia\.org)$/i;

// USB descriptor signatures a firmware would need to pose as something other than a MIDI/audio device
const USB_SIGS = {
  hidKeyboard: { label: "USB keyboard (HID report descriptor)", bytes: [0x05, 0x01, 0x09, 0x06, 0xa1, 0x01] },
  hidMouse:    { label: "USB mouse (HID report descriptor)",    bytes: [0x05, 0x01, 0x09, 0x02, 0xa1, 0x01] },
  // interface descriptor: bLength 9, type 4, if#, alt, #ep, class 08 (mass storage), subclass 06 (SCSI), protocol 50 (bulk-only)
  massStorage: { label: "USB drive (mass-storage interface)",   bytes: [0x09, 0x04, -1, -1, -1, 0x08, 0x06, 0x50] },
};

function modelOf(identity) {
  if (/^FM-1_/i.test(identity)) return "FM-1";
  if (/^SMK-?37|^SMK37/i.test(identity)) return "SMK-37";
  if (/^MKE/i.test(identity)) return "MKE-P37";
  return identity ? "unknown" : "none";
}

/**
 * Analyse one package.
 * @param {Uint8Array} bytes the .fwsc file
 * @returns report object (see README for fields)
 */
export function analyze(bytes) {
  const pkg = parsePackage(bytes);
  const rep = {
    size: bytes.length, identity: pkg.identity, model: modelOf(pkg.identity), parsed: pkg.ok, errors: pkg.errors,
    package: {
      headerCrcOk: pkg.headerCrcOk, chipKey: pkg.chipKey, chipKeyOk: pkg.chipKey === FM1_CHIP_KEY,
      entries: pkg.entries.map((e) => ({ type: e.type, size: e.size })),
      files: pkg.files.map((f) => f.name), appFiles: pkg.appFiles.map((f) => f.name),
      appSize: pkg.app ? pkg.app.length : 0, appSlotSize: pkg.appSlotSize,
    },
    flash: null, network: null, usb: null, strings: null, findings: [], verdict: "unknown",
  };
  if (!pkg.ok) {
    if (pkg.headerCrcOk) {   // a well-formed package that just carries no application: bootloader, recovery or flasher stage
      rep.verdict = "other";
      rep.findings.push({ level: "info", area: "package", text: "A valid FM-1 package, but it carries no application: most likely a bootloader, a recovery stage or a flasher helper. Its code can't be checked here; only install it if a recovery guide you trust tells you to." });
    } else {
      rep.verdict = "invalid";
      rep.findings.push({ level: "bad", area: "package", text: pkg.errors[0] || "Could not read the package." });
    }
    return { report: rep, app: null };
  }
  const app = pkg.app;

  // ---- flash chip support
  const puya = has(app, FLASH.PUYA.le), uc25 = has(app, FLASH.UC25.le);
  rep.flash = { puyaConstant: puya, uc25Constant: uc25 };
  if (uc25) rep.findings.push({ level: "ok", area: "flash", text: "Recognises the UC25HQ80 flash used in newer FM-1 units (its chip ID is in the code)." });
  else if (puya) rep.findings.push({ level: rep.model === "FM-1" ? "warn" : "info", area: "flash",
    text: "Checks for the original Puya flash chip only. On newer FM-1 units (UC25HQ80 flash) firmware like this has kept saves in RAM only and refused later installs, which then needs a USB download-mode rescue. Check the project's notes for newer-unit support before installing on a recent FM-1." });
  else rep.findings.push({ level: "info", area: "flash", text: "No flash-chip ID check found in the code. M-VAVE's own firmware works this way on all units; for a community firmware, check its notes about newer units." });

  // ---- strings, network capability, endpoints
  const strs = strings(app);
  const text = strs.join("\n");
  const markers = {};
  for (const [k, m] of Object.entries(MARKERS)) markers[k] = m.re.test(text);
  const urls = [...new Set(text.match(URL_RE) || [])].sort();
  const hosts = [...new Set((text.match(HOST_RE) || []).map((h) => h.toLowerCase()))].filter((h) => !/\.(c|h|o)$/.test(h)).sort();
  const ips = [...new Set(text.match(IP_RE) || [])].filter((ip) => {
    const o = ip.split(".").map(Number);
    return !(o[0] === 0 || o[0] < 10 && o.every((x) => x < 10)) && !(o[0] === 127) && !(o[0] === 255) && !/^(1|2)\.\d+\.\d+\.\d+$/.test(ip);
  }).sort();
  const unusualHosts = hosts.filter((h) => !BENIGN_HOST.test(h));
  const canInternet = markers.wifi && markers.tcpip;
  rep.network = { markers, urls, hosts, unusualHosts, ips: ips.slice(0, 20), internetCapable: canInternet };
  if (canInternet && (markers.http || urls.length))
    rep.findings.push({ level: "info", area: "network", text: `Can use the internet over Wi-Fi${markers.tls ? " (with HTTPS)" : ""}. ${unusualHosts.length ? "Addresses it names: " + unusualHosts.slice(0, 8).join(", ") + "." : "It names no servers."} Fine if that is what the firmware is for (radio, streaming); unexpected for a plain synth.` });
  else if (markers.wifi || markers.tcpip || markers.bluetooth)
    rep.findings.push({ level: "ok", area: "network", text: "Contains the chip's standard Bluetooth/networking libraries (as M-VAVE's own firmware does); no sign it talks to internet servers." });
  else rep.findings.push({ level: "ok", area: "network", text: "No networking code found." });
  if (ips.length) rep.findings.push({ level: "warn", area: "network", text: `Contains hard-coded IP addresses: ${ips.slice(0, 5).join(", ")}. Worth a look: firmware rarely needs them.` });

  // ---- USB identities
  const usb = {};
  for (const [k, s] of Object.entries(USB_SIGS)) usb[k] = countBytes(app, s.bytes) > 0;
  rep.usb = usb;
  if (usb.hidKeyboard) rep.findings.push({ level: "bad", area: "usb", text: "Can present itself to a computer as a USB KEYBOARD. A firmware that does this can type commands into your computer. Only install if the project says why (e.g. a macro-pad firmware)." });
  if (usb.hidMouse) rep.findings.push({ level: "warn", area: "usb", text: "Can present itself as a USB mouse." });
  if (usb.massStorage) rep.findings.push({ level: "warn", area: "usb", text: "Can present itself as a USB drive." });
  if (!usb.hidKeyboard && !usb.hidMouse && !usb.massStorage) rep.findings.push({ level: "ok", area: "usb", text: "Does not pose as a keyboard, mouse or drive over USB." });

  // ---- package sanity
  if (!rep.package.chipKeyOk) rep.findings.push({ level: "warn", area: "package", text: `Chip key is 0x${(pkg.chipKey ?? 0).toString(16).toUpperCase()}, not the FM-1/SMK-37's 0x980F: probably made for another device.` });
  if (rep.model === "SMK-37" || rep.model === "MKE-P37") rep.findings.push({ level: "info", area: "package", text: `Built for the ${rep.model} keyboard, not the FM-1.` });
  else if (rep.model !== "FM-1") rep.findings.push({ level: "warn", area: "package", text: `Unexpected package identity "${pkg.identity}".` });

  // ---- interesting strings: versions and names
  const versions = [...new Set(text.match(/\bv?\d+\.\d+(?:\.\d+){0,2}(?:-[a-z0-9.]+)?\b/gi) || [])].filter((v) => /^v/i.test(v) || v.split(".").length >= 3).slice(0, 12);
  rep.strings = { count: strs.length, versions, urls: urls.slice(0, 40) };

  const levels = rep.findings.map((f) => f.level);
  rep.verdict = levels.includes("bad") ? "risk" : levels.includes("warn") ? "caution" : "ok";
  return { report: rep, app };
}
