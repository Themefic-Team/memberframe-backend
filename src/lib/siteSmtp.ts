/**
 * A site's own SMTP server. Development doc: 25-custom-smtp.md.
 *
 * Stored as the `custom_smtp` integration in the site settings document, with
 * the password sealed in `integration_secrets` like the sign-in secrets. This
 * module is the rules for those values, and the one place that turns them into
 * a connection.
 *
 * ## Host safety
 *
 * The creator types the host, and the server connects to it. Unchecked, the
 * test button would let anyone with a creator account probe the platform's own
 * network. So the host is resolved first, every address it resolves to must be
 * public, and the connection is made to that address, with the typed name kept
 * for TLS, so the DNS answer cannot change between the check and the connect.
 * The port is limited to the mail ports. `SITE_SMTP_ALLOW_PRIVATE_HOSTS` lifts
 * both rules for development, where the server is Mailpit on 127.0.0.1.
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export const SITE_SMTP_ID = "custom_smtp";

export const SMTP_SECURITY = ["ssl", "starttls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

/** The ports a public mail server listens on. */
export const MAIL_PORTS: ReadonlyArray<number> = [25, 465, 587, 2525];

const MAX_HOST = 253;
const MAX_USERNAME = 255;
const MAX_FROM_NAME = 100;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export interface SiteSmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

export interface SmtpProblem {
  key: string;
  message: string;
}

// ============================================================================
// ADDRESSES
// ============================================================================

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv6");
}

/** Is this IP address one the platform must never connect to for a creator? */
export function isPrivateAddress(address: string): boolean {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is the IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);

  const family = isIP(trimmed);
  if (family === 4) return PRIVATE.check(trimmed, "ipv4");
  if (family === 6) return PRIVATE.check(trimmed, "ipv6");
  // Not an address at all: treat as unsafe rather than guess.
  return true;
}

/** A name that always means this machine or its network, whatever DNS says. */
function isLocalName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal");
}

// ============================================================================
// VALUES
// ============================================================================

const text = (values: Record<string, unknown>, key: string): string => {
  const value = values[key];
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
};

/**
 * Everything wrong with a set of values, one problem per key.
 *
 * The password is not checked here: it is a secret, stored apart, and whether
 * one is held is `secretsPresent`'s answer, not this function's.
 */
export function smtpValueProblems(values: Record<string, unknown>, allowPrivate: boolean): SmtpProblem[] {
  const problems: SmtpProblem[] = [];
  const host = text(values, "host");
  const port = text(values, "port");
  const security = text(values, "security") || "starttls";

  if (host === "") {
    problems.push({ key: "host", message: "Enter the SMTP host, for example smtp.example.com." });
  } else if (host.length > MAX_HOST || (isIP(host) === 0 && !HOSTNAME.test(host))) {
    problems.push({ key: "host", message: "That is not a valid host name." });
  } else if (!allowPrivate && (isLocalName(host) || (isIP(host) !== 0 && isPrivateAddress(host)))) {
    problems.push({ key: "host", message: "Use your mail provider's public host. Private and local addresses are not allowed." });
  }

  const portNumber = Number(port);
  if (!/^\d{1,5}$/.test(port) || portNumber < 1 || portNumber > 65535) {
    problems.push({ key: "port", message: "Enter the port, usually 587 or 465." });
  } else if (!allowPrivate && !MAIL_PORTS.includes(portNumber)) {
    problems.push({ key: "port", message: `Use a mail port: ${MAIL_PORTS.join(", ")}.` });
  }

  if (!(SMTP_SECURITY as ReadonlyArray<string>).includes(security)) {
    problems.push({ key: "security", message: "Choose SSL/TLS, STARTTLS, or None." });
  }

  if (text(values, "username").length > MAX_USERNAME) {
    problems.push({ key: "username", message: "The username is too long." });
  }

  const fromAddress = text(values, "fromAddress");
  if (!EMAIL.test(fromAddress)) {
    problems.push({ key: "fromAddress", message: "Enter the address emails are sent from." });
  }

  const fromName = text(values, "fromName");
  if (fromName.length > MAX_FROM_NAME || /[\r\n]/.test(fromName)) {
    problems.push({ key: "fromName", message: `Keep the name on one line, under ${MAX_FROM_NAME} characters.` });
  }

  const replyTo = text(values, "replyTo");
  if (replyTo !== "" && !EMAIL.test(replyTo)) {
    problems.push({ key: "replyTo", message: "Enter a valid reply-to address, or leave it empty." });
  }

  return problems;
}

/** The values as a config, or null when they are not usable. */
export function readSiteSmtp(values: Record<string, unknown>, allowPrivate: boolean): SiteSmtpConfig | null {
  if (smtpValueProblems(values, allowPrivate).length > 0) return null;
  return {
    host: text(values, "host"),
    port: Number(text(values, "port")),
    security: (text(values, "security") || "starttls") as SmtpSecurity,
    username: text(values, "username"),
    fromName: text(values, "fromName").replace(/"/g, "'"),
    fromAddress: text(values, "fromAddress"),
    replyTo: text(values, "replyTo"),
  };
}

// ============================================================================
// CONNECTING
// ============================================================================

export class SmtpHostRefused extends Error {}

/**
 * The address to connect to for this host.
 *
 * Every address the name resolves to must be public, not just the first: a
 * name with one public and one private record could otherwise be steered to
 * the private one by the order of the answer.
 */
export async function resolveMailHost(
  host: string,
  allowPrivate: boolean,
  resolve: (host: string) => Promise<Array<{ address: string }>> = (name) => lookup(name, { all: true })
): Promise<string> {
  if (isIP(host) !== 0) {
    if (!allowPrivate && isPrivateAddress(host)) throw new SmtpHostRefused("That host is a private address.");
    return host;
  }
  if (!allowPrivate && isLocalName(host)) throw new SmtpHostRefused("That host is a local name.");

  const answers = await resolve(host);
  if (answers.length === 0) throw new SmtpHostRefused(`${host} did not resolve.`);
  if (!allowPrivate && answers.some((answer) => isPrivateAddress(answer.address))) {
    throw new SmtpHostRefused(`${host} resolves to a private address.`);
  }
  return answers[0]!.address;
}

/** nodemailer options for one send, to an address already resolved. */
export function transportOptions(config: SiteSmtpConfig, password: string, address: string) {
  return {
    host: address,
    port: config.port,
    secure: config.security === "ssl",
    requireTLS: config.security === "starttls",
    // The certificate is checked against the name the creator typed, not the
    // address it resolved to.
    tls: { servername: isIP(config.host) === 0 ? config.host : undefined },
    auth: config.username !== "" ? { user: config.username, pass: password } : undefined,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  };
}

/** The From line. */
export function fromHeader(config: SiteSmtpConfig): string {
  return config.fromName !== "" ? `"${config.fromName}" <${config.fromAddress}>` : config.fromAddress;
}

/** A provider's error, short enough for a card. */
export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "The SMTP server refused the email.";
}
