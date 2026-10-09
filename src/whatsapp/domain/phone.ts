import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

/**
 * Explicit conversions between EXTERNAL phone numbers (E.164, what humans and
 * APIs use) and INTERNAL WhatsApp JIDs (protocol addresses). They are NOT the
 * same thing:
 *   - a JID may carry a device suffix   ("919812345678:12@s.whatsapp.net")
 *   - a JID may be a privacy LID        ("123456789012345@lid") with no phone
 *   - groups/broadcast/newsletters are not people
 * Never build one from the other with string concatenation elsewhere.
 */

export const PN_SERVER = 's.whatsapp.net';

export class InvalidPhoneNumberError extends Error {
  constructor() { super('invalid phone number'); }
}

/** Parses user input into E.164. `defaultCountry` applies to numbers without a +country prefix. */
export function toE164(input: string, defaultCountry?: CountryCode): string {
  const cleaned = input.trim();
  if (!/^[+0-9()\-.\s]{6,32}$/.test(cleaned)) throw new InvalidPhoneNumberError();
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isValid()) throw new InvalidPhoneNumberError();
  return parsed.number; // "+919812345678"
}

/** E.164 -> 1:1 user JID ("+919812345678" -> "919812345678@s.whatsapp.net"). */
export function e164ToUserJid(e164: string): string {
  if (!/^\+[1-9][0-9]{6,14}$/.test(e164)) throw new InvalidPhoneNumberError();
  return `${e164.slice(1)}@${PN_SERVER}`;
}

export interface ParsedJid { user: string; device?: number; server: string }

export function parseJid(jid: string | null | undefined): ParsedJid | null {
  if (!jid) return null;
  const at = jid.indexOf('@');
  if (at <= 0) return null;
  const server = jid.slice(at + 1);
  const userPart = jid.slice(0, at);
  const [userAndAgent, deviceStr] = userPart.split(':');
  const user = userAndAgent.split('_')[0];
  if (!user || !server) return null;
  return { user, server, device: deviceStr !== undefined ? Number(deviceStr) : undefined };
}

export const isGroupJid = (jid?: string | null) => !!jid && jid.endsWith('@g.us');
export const isBroadcastJid = (jid?: string | null) => !!jid && jid.endsWith('@broadcast');
export const isNewsletterJid = (jid?: string | null) => !!jid && jid.endsWith('@newsletter');
export const isLidJid = (jid?: string | null) => !!jid && jid.endsWith('@lid');
export const isPnUserJid = (jid?: string | null) => !!jid && jid.endsWith(`@${PN_SERVER}`);

/** Removes the device suffix: "9198...:12@s.whatsapp.net" -> "9198...@s.whatsapp.net". */
export function normalizeUserJid(jid: string): string {
  const p = parseJid(jid);
  if (!p) throw new Error('invalid jid');
  return `${p.user}@${p.server}`;
}

/** Phone-number JID -> E.164, or null for LIDs/groups/anything that is not a valid number. */
export function userJidToE164(jid: string | null | undefined): string | null {
  if (!isPnUserJid(jid)) return null;
  const p = parseJid(jid)!;
  if (!/^[1-9][0-9]{6,14}$/.test(p.user)) return null;
  const parsed = parsePhoneNumberFromString(`+${p.user}`);
  return parsed && parsed.isPossible() ? parsed.number : null;
}
