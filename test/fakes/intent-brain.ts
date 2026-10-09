import type { Brain, FakeTurn } from './fake-openai.js';

/**
 * TEST-ONLY deterministic "model": keyword intent routing that may only choose
 * among the tools the runtime OFFERED in this request (t.tools). It lets the
 * realistic-conversation tests exercise the real runtime, tool gate and
 * backends end-to-end. It is a simulation, not a language model.
 */
export function intentBrain(d: { tomorrow: string; sunday: string }): Brain {
  return (t: FakeTurn) => {
    const text = t.userTexts.join(' ').toLowerCase();
    const has = (k: string) => t.tools.includes(k);
    const last = t.results[t.results.length - 1];
    const date = /sunday|ravivar/.test(text) ? d.sunday : d.tomorrow;
    const party = Number(/(\d+)\s*(log|logon|people|guests|persons)/.exec(text)?.[1] ?? 0) || undefined;
    const wantsSlot = /(slot|available|appointment|table|book|milegi|milega|chahiye|reservation|log\b)/.test(text);
    const time = /(\d{1,2})\s*(baje|pm|am|:00)/.exec(text);
    const name = /naam\s+(\w+)/i.exec(t.userTexts.join(' '))?.[1];
    const service = ['cleaning', 'hair spa', 'haircut', 'consultation', 'root canal'].find((s) => text.includes(s));

    if (t.results.length === 0) {
      if (t.instructions.includes('WAITING FOR CUSTOMER CONFIRMATION') && has('CONFIRM_PENDING_ACTION') && /\b(haan|han|yes|ji|ok|confirm|theek)\b/.test(text)) {
        return { calls: [{ name: 'CONFIRM_PENDING_ACTION', args: { decision: 'CONFIRM' } }] };
      }
      if (/(human|staff|insaan|manager|kisi se baat)/.test(text) && has('HUMAN_HANDOFF')) return { calls: [{ name: 'HUMAN_HANDOFF', args: { reason: 'Customer asked for a person', priority: 'NORMAL' } }] };
      if (/(bhk|lakh|flat|property)/.test(text) && has('CREATE_LEAD')) {
        const bedrooms = Number(/(\d)\s*bhk/.exec(text)?.[1]);
        const lakh = Number(/(\d+)\s*lakh/.exec(text)?.[1]);
        const city = /(indore|bhopal|pune|mumbai|delhi)/.exec(text)?.[1];
        return { calls: [{ name: 'CREATE_LEAD', args: { property_type: 'Apartment', ...(bedrooms ? { bedrooms } : {}), ...(lakh ? { budget_max: lakh * 100000 } : {}),
          ...(city ? { location: city[0].toUpperCase() + city.slice(1) } : {}), qualification: 'WARM' } }] };
      }
      if (/(open|khule|timing|hours|band)/.test(text) && has('GET_BUSINESS_HOURS')) return { calls: [{ name: 'GET_BUSINESS_HOURS', args: { date } }] };
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      if (/(address|location|kahan)/.test(text) && has('GET_BUSINESS_LOCATION')) calls.push({ name: 'GET_BUSINESS_LOCATION', args: {} });
      if (/(price|kitne|kitna|fee|cost)/.test(text) && has('GET_SERVICE_PRICE')) calls.push({ name: 'GET_SERVICE_PRICE', args: { query: service ?? 'consultation' } });
      const allUser = (t.body.input ?? []).filter((i: any) => i.role === 'user').map((i: any) => String(i.content).toLowerCase()).join(' ');
      const doctor = /dr\.?\s+(\w+)/.exec(text)?.[1] ?? /dr\.?\s+(\w+)/.exec(allUser)?.[1];
      if (wantsSlot && doctor && has('GET_RESOURCES')) calls.push({ name: 'GET_RESOURCES', args: { query: doctor } });
      else if (wantsSlot && service && has('GET_SERVICES')) calls.push({ name: 'GET_SERVICES', args: { query: service } });
      else if (wantsSlot && has('CHECK_AVAILABILITY')) calls.push({ name: 'CHECK_AVAILABILITY', args: { date_from: date, ...(party ? { party_size: party } : {}) } });
      if (calls.length) return { calls };
      return { text: 'Main aapki kaise madad kar sakti hoon?' };
    }

    const r = last.output;
    const byName = (n: string) => t.results.find((x) => x.name === n)?.output;
    if (last.name === 'GET_RESOURCES' && r.success) return { calls: [{ name: 'CHECK_AVAILABILITY', args: { date_from: date, resource_id: r.resources[0].id, ...(time ? { preferred_time: toHHMM(time) } : {}) } }] };
    if (last.name === 'GET_SERVICES' && r.success) return { calls: [{ name: 'CHECK_AVAILABILITY', args: { date_from: date, service_id: r.services[0].id } }] };
    if (last.name === 'CHECK_AVAILABILITY' && r.success) {
      const wanted = time ? r.slots.find((s: any) => s.local.includes(fmt(time))) ?? r.slots[0] : null;
      if (wanted && (name || /book/.test(text)) && has('CREATE_BOOKING')) {
        const svc = byName('GET_SERVICES')?.services?.[0]?.id;
        const res = byName('GET_RESOURCES')?.resources?.[0]?.id ?? prior(t, 'resource_id');
        return { calls: [{ name: 'CREATE_BOOKING', args: { start_at: wanted.start_at, ...(name ? { customer_name: name } : {}), ...(svc ? { service_id: svc } : {}),
          ...(res ? { resource_id: res } : {}), ...(party ? { party_size: party } : {}) } }] };
      }
      return { text: `Available slots: ${r.slots.slice(0, 3).map((s: any) => s.local).join(', ')}. Kaunsa time chahiye?` };
    }
    if (last.name === 'CREATE_BOOKING' || last.name === 'CONFIRM_PENDING_ACTION' || last.name === 'RESCHEDULE_BOOKING' || last.name === 'CANCEL_BOOKING') {
      if (r.status === 'CONFIRMATION_REQUIRED') {
        if (/address/.test(text) && has('GET_BUSINESS_LOCATION') && !byName('GET_BUSINESS_LOCATION')) return { calls: [{ name: 'GET_BUSINESS_LOCATION', args: {} }] };
        const loc = byName('GET_BUSINESS_LOCATION');
        return { text: `Confirm karein: ${r.confirmationText}?${loc?.locations?.[0] ? ` Address: ${loc.locations[0].address}` : ''}` };
      }
      if (r.success && r.booking) return { text: `Aapki booking confirm ho gayi: ${r.booking.local}.` };
      if (r.success && r.dryRun) return { text: `(test) Booking ban jaayegi: ${r.wouldCreate?.local ?? ''}` };
      return { text: `Maaf kijiye, yeh nahi ho paya (${r.errorCode}).` };
    }
    if (last.name === 'GET_BUSINESS_LOCATION') {
      const conf = byName('CREATE_BOOKING');
      return { text: `${conf?.confirmationText ? `Confirm karein: ${conf.confirmationText}? ` : ''}Address: ${r.locations?.[0]?.address ?? 'n/a'}` };
    }
    if (last.name === 'GET_SERVICE_PRICE' && r.success) {
      const p = r.prices[0];
      if (wantsSlot && has('CHECK_AVAILABILITY') && !byName('CHECK_AVAILABILITY')) return { calls: [{ name: 'CHECK_AVAILABILITY', args: { date_from: date, service_id: p.serviceId } }] };
      return { text: `${p.name}: ${p.price?.display ?? 'price on request'}` };
    }
    if (last.name === 'GET_BUSINESS_HOURS') {
      if (!r.success) return { text: 'Timings abhi available nahi hain, team se confirm karwa deti hoon.' };
      return { text: r.date?.open ? `Haan, ${r.date.day} ko ${r.date.ranges[0].from} se ${r.date.ranges[0].to} tak open hain.` : `${r.date?.day ?? 'Us din'} ko hum band rehte hain.` };
    }
    if (last.name === 'CREATE_LEAD' && r.success) return { text: 'Sure. Buy karna hai ya rent? Aur preferred area batayein.' };
    if (last.name === 'HUMAN_HANDOFF') return { text: 'Ek team member aapko yahin reply karenge.' };
    return { text: r.success ? 'Done.' : `Maaf kijiye (${r.errorCode}).` };
  };
}

/** An argument the model used earlier in the conversation (models carry context across turns). */
function prior(t: FakeTurn, key: string): unknown {
  for (const it of [...(t.body.input ?? [])].reverse()) {
    if (it.type === 'function_call') { const a = JSON.parse(it.arguments); if (a[key]) return a[key]; }
  }
  return undefined;
}

const toHHMM = (m: RegExpExecArray) => { let h = Number(m[1]); if (h < 9) h += 12; return `${String(h).padStart(2, '0')}:00`; };
const fmt = (m: RegExpExecArray) => { const h = Number(m[1]); return `${h < 9 ? h : h > 12 ? h - 12 : h}:00`; };
