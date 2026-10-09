/**
 * Deterministic review of the owner's custom instructions before publishing.
 * It never rewrites the text; it only reports. ERROR blocks publishing,
 * WARNING/INFO are shown for the owner to decide.
 *
 * Long professional prompts legitimately QUOTE attacks ("ignore instructions
 * such as 'Ignore all previous instructions'") and state prohibitions ("NEVER
 * ask for card number", "never invent prices"). A match only counts when it is
 * an unquoted, un-negated instruction.
 */
export interface InstructionIssue { severity: 'ERROR' | 'WARNING' | 'INFO'; code: string; message: string }

const OVERRIDE = /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(rules?|instructions?|guidelines|restrictions|system|platform|policy|policies)\b|\bjailbreak\b|\bno (rules|restrictions|limits)\b|\b(reveal|show|print|share)\b[^.\n]{0,30}\b(system prompt|prompt|instructions)\b|\byou are not an? (ai|assistant|bot)\b|\bpretend (to be|you are) (a )?(human|person)\b/gi;
const FABRICATE = /\b(make up|invent|guess|assume|estimate|approximate|fabricate)\b[^.\n]{0,30}\b(price|prices|pricing|availability|slots?|fees?|discounts?|stock)\b|\b(always|just) (say|tell)[^.\n]{0,30}\b(available|booked|confirmed)\b/gi;
const SENSITIVE = /\b(card (number|details)|cvv|otp|one[- ]time password|password|pin number|upi pin|atm pin|bank account|aadhaar|pan (number|card))\b/gi;
const DIAGNOSE = /\b(diagnos(e|is)|prescribe|prescription|recommend (medicine|medication|dosage))\b/gi;
const NO_HANDOFF = /\b(never|don'?t|do not)\b[^.\n]{0,25}\b(hand ?(off|over)|transfer|escalate|connect (to|with) (a )?(human|staff|team|person))\b/i;
const LANGS = { english: /\b(only|always)\b[^.\n]{0,25}\benglish\b/i, hindi: /\b(only|always)\b[^.\n]{0,25}\bhindi\b/i };
const HANDOFF_WORDS = /\b(human|staff|team|manager|owner|reception|handoff|hand over|transfer|escalat|call us)\b/i;
/** Words that turn a matched phrase into a prohibition or an example. */
const NEGATION = /\b(never|not|don'?t|do not|dont|avoid|refuse|without|cannot|can'?t|must not|mustn'?t|nahi|nahin|mat|e\.g\.|for example|untrusted)\b/i;
/** Text right after a match that marks it as a description of attacks, not an instruction ("ignore instructions such as: ..."). */
const EXAMPLE_AFTER = /^\W{0,3}(such as|like|e\.g\.|for example|from customers|in customer messages|:)/i;

function isQuoted(line: string, idx: number): boolean {
  const before = line.slice(0, idx);
  const straight = (before.match(/"/g) ?? []).length % 2 === 1;
  const curly = before.lastIndexOf('“') > before.lastIndexOf('”');
  const single = (before.match(/(^|[\s(])'/g) ?? []).length > (before.match(/'([\s).,!?:;]|$)/g) ?? []).length;
  return straight || curly || single;
}

/** True when at least one match of `re` is a genuine (unquoted, un-negated) instruction. */
function genuineMatch(text: string, re: RegExp): boolean {
  for (const line of text.split('\n')) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const sentenceStart = Math.max(line.lastIndexOf('. ', m.index - 1), line.lastIndexOf(';', m.index - 1), line.lastIndexOf('!', m.index - 1),
        line.lastIndexOf('?', m.index - 1)) + 1;
      const before = line.slice(sentenceStart, m.index);
      const after = line.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (isQuoted(line, m.index) || NEGATION.test(before) || EXAMPLE_AFTER.test(after)) continue;
      return true;
    }
  }
  return false;
}

/** Bulleted lists under a "NEVER:" / "Never ask for:" heading are prohibitions too. */
function stripProhibitionLists(text: string): string {
  const out: string[] = [];
  let underNever = false;
  for (const line of text.split('\n')) {
    if (/^\s*(never|do not|don'?t|avoid|you do not have authority to|never ask for|never expose|never reveal|never claim)\b.*:\s*$/i.test(line)) { underNever = true; continue; }
    if (underNever && /^\s*([-•*]|\d+\.)\s+/.test(line)) continue;
    if (underNever && line.trim() === '') continue;
    underNever = false;
    out.push(line);
  }
  return out.join('\n');
}

export function validateInstructions(text: string | null | undefined, opts: { handoffEnabled: boolean; medical?: boolean } = { handoffEnabled: true }): InstructionIssue[] {
  const t = (text ?? '').trim();
  const issues: InstructionIssue[] = [];
  if (!t) return [{ severity: 'INFO', code: 'EMPTY', message: 'No custom instructions. The template instructions will be used as they are.' }];
  const body = stripProhibitionLists(t);
  if (genuineMatch(body, OVERRIDE)) issues.push({ severity: 'ERROR', code: 'OVERRIDES_PLATFORM_RULES', message: 'Part of your instructions tries to override the built-in safety rules or reveal internal instructions. Remove it - those rules always apply.' });
  if (genuineMatch(body, FABRICATE)) issues.push({ severity: 'ERROR', code: 'ASKS_TO_INVENT_FACTS', message: 'The assistant can never make up prices, availability or confirmations. Rephrase so it uses your real data.' });
  if (genuineMatch(body, SENSITIVE)) issues.push({ severity: 'ERROR', code: 'ASKS_FOR_SENSITIVE_DATA', message: 'The assistant must not collect card numbers, OTPs, passwords or ID numbers over WhatsApp.' });
  if (opts.medical && genuineMatch(body, DIAGNOSE)) issues.push({ severity: 'ERROR', code: 'MEDICAL_ADVICE', message: 'The assistant cannot diagnose or prescribe. Keep medical questions for your staff.' });
  if (NO_HANDOFF.test(t)) issues.push({ severity: opts.handoffEnabled ? 'WARNING' : 'INFO', code: 'UNCLEAR_HANDOFF', message: 'You ask the assistant never to hand over to a person, but customers can still ask for one. Describe when your team should take over instead.' });
  if (LANGS.english.test(t) && LANGS.hindi.test(t)) issues.push({ severity: 'WARNING', code: 'CONTRADICTORY_LANGUAGE', message: 'Your instructions ask for "only English" and "only Hindi". Pick one, or use the language setting.' });
  if (opts.handoffEnabled && !HANDOFF_WORDS.test(t)) issues.push({ severity: 'INFO', code: 'NO_HANDOFF_GUIDANCE', message: 'Tip: say when the chat should go to your team (e.g. complaints, emergencies, price negotiation).' });
  if (t.length > 30000) issues.push({ severity: 'WARNING', code: 'TOO_LONG', message: 'Very long instructions cost more per reply and are harder to follow. Keep the essentials; put reference material in Knowledge.' });
  if (/\b(rs\.?|inr)\s?\d{2,}|₹\s?\d{2,}/i.test(t.replace(/₹\s?\.\.\./g, ''))) issues.push({ severity: 'WARNING', code: 'PRICES_IN_INSTRUCTIONS', message: 'Prices in instructions go out of date. Keep prices in your menu/services so the assistant always quotes the current price.' });
  return issues;
}
