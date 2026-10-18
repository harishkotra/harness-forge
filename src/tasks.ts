import type { TaskSpec, Grade } from './types.ts';

/* ------------------------------------------------------------------ */
/* grading helpers                                                      */
/* ------------------------------------------------------------------ */

export function stripFences(raw: string): string {
  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : raw).trim();
}

export function extractJson(raw: string): unknown {
  const text = stripFences(raw);
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  const candidates = [firstObj, firstArr].filter((i) => i >= 0);
  if (!candidates.length) throw new Error('no JSON value found in answer');
  const start = Math.min(...candidates);
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error('unterminated JSON value in answer');
  return JSON.parse(text.slice(start, end + 1));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

export function objectDiff(expected: unknown, got: unknown, path = ''): string[] {
  const out: string[] = [];
  const exp = expected as Record<string, unknown> | null;
  const act = got as Record<string, unknown> | null;
  if (typeof expected !== 'object' || expected === null) {
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      out.push(`${path || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    }
    return out;
  }
  if (typeof got !== 'object' || got === null) {
    out.push(`${path || 'value'}: expected an object, got ${JSON.stringify(got)}`);
    return out;
  }
  for (const key of Object.keys(exp!)) {
    if (!(key in act!)) out.push(`${path ? path + '.' : ''}${key}: missing`);
    else out.push(...objectDiff(exp![key], act![key], path ? `${path}.${key}` : key));
  }
  for (const key of Object.keys(act!)) {
    if (!(key in exp!)) out.push(`${path ? path + '.' : ''}${key}: unexpected key`);
  }
  return out;
}

function fail(score: number, failures: string[]): Grade {
  return { score: Math.max(0, Math.min(1, score)), passed: score >= 1 && failures.length === 0, failures };
}

function parseFail(raw: string, err: unknown): Grade {
  const preview = raw.trim().slice(0, 90).replace(/\s+/g, ' ');
  return fail(0, [
    `answer was not parseable as the requested JSON (${(err as Error).message}); started with: "${preview}"`,
  ]);
}

/* ------------------------------------------------------------------ */
/* 1. invoice extraction                                               */
/* ------------------------------------------------------------------ */

const invoiceSpec = {
  contract:
    'JSON array only, sorted by dueDate ascending. Each object: {vendor, amountCents, currency, dueDate}. amountCents is the final payable amount in integer cents after any discount or credit. currency is ISO 4217. dueDate is YYYY-MM-DD.',
  grade(raw: string, expected: unknown): Grade {
    let got: unknown;
    try {
      got = extractJson(raw);
    } catch (e) {
      return parseFail(raw, e);
    }
    if (!Array.isArray(got)) return fail(0, ['answer is not a JSON array']);
    const exp = expected as { vendor: string; amountCents: number; currency: string; dueDate: string }[];
    const failures: string[] = [];
    let hits = 0;
    const total = exp.length * 4;
    if (got.length !== exp.length) failures.push(`expected ${exp.length} invoices, got ${got.length}`);
    exp.forEach((want, i) => {
      const item = (got as Record<string, unknown>[])[i];
      if (!item || typeof item !== 'object') {
        failures.push(`row ${i + 1}: missing invoice (expected ${want.vendor})`);
        return;
      }
      if (item.vendor === want.vendor) hits++;
      else failures.push(`row ${i + 1}: expected vendor ${want.vendor}, got ${JSON.stringify(item.vendor)}`);
      if (item.amountCents === want.amountCents) hits++;
      else
        failures.push(
          `row ${i + 1} (${want.vendor}): amountCents expected ${want.amountCents}, got ${JSON.stringify(item.amountCents)}`,
        );
      if (item.currency === want.currency) hits++;
      else failures.push(`row ${i + 1}: currency expected ${want.currency}, got ${JSON.stringify(item.currency)}`);
      if (item.dueDate === want.dueDate) hits++;
      else failures.push(`row ${i + 1}: dueDate expected ${want.dueDate}, got ${JSON.stringify(item.dueDate)}`);
      const extra = Object.keys(item).filter((k) => !['vendor', 'amountCents', 'currency', 'dueDate'].includes(k));
      if (extra.length) failures.push(`row ${i + 1}: unexpected keys ${extra.join(', ')}`);
    });
    return fail(hits / total, failures);
  },
};

export const invoiceTask: TaskSpec = {
  id: 'invoices',
  title: 'Ledger entry from a messy invoice folder',
  domain: 'finance ops',
  contract: invoiceSpec.contract,
  grade: invoiceSpec.grade,
  variants: {
    public: {
      input: `Subject: March close, invoices from the vendor folder

- Brightline Studio, invoice BS-1042, $1,204.50, issued 2026-03-02, net 30. A courtesy discount of 20% was applied to the total before booking.
- Kestrel Freight, invoice KF-77, 860.00 EUR, issued 12 March 2026, net 14.
- Vantablack Labs, invoice VL-9, $400 with a $50 credit applied, issued 2026/03/10, net 45.
- Brightline Studio, invoice BS-1042, $1,204.50, issued 2026-03-02, net 30.
- Northwind Parts, credit note CN-3, -$220.00, issued 2026-03-05. Do not book credit notes into the ledger.
- Halcyon Cloud, invoice HC-11, $1,760.00, issued 2026-03-08, net 60, 15% partner discount applied.

Book the invoices. One row per invoice, duplicates collapse to a single row.`,
      expected: [
        { vendor: 'Kestrel Freight', amountCents: 86000, currency: 'EUR', dueDate: '2026-03-26' },
        { vendor: 'Brightline Studio', amountCents: 96360, currency: 'USD', dueDate: '2026-04-01' },
        { vendor: 'Vantablack Labs', amountCents: 35000, currency: 'USD', dueDate: '2026-04-24' },
        { vendor: 'Halcyon Cloud', amountCents: 149600, currency: 'USD', dueDate: '2026-05-07' },
      ],
    },
    holdout: {
      input: `Subject: May close, invoices from the vendor folder

- Corvid Analytics, invoice CA-210, $2,310.00, issued 2026-05-04, net 15. A volume discount of 10% was applied to the total before booking.
- Hollowpoint Media, invoice HM-8, 1,275.50 GBP, issued 2026/05/01, net 30.
- Ninefold Robotics, invoice NR-3, $980 with an $80 credit applied, issued 2026-05-09, net 60.
- Corvid Analytics, invoice CA-210, $2,310.00, issued 2026-05-04, net 15.
- Meridian Grid, credit note MG-1, -$310.00, issued 2026-05-06. Do not book credit notes into the ledger.
- Meridian Grid, invoice MG-7, 540.00 EUR, issued 2026-04-30, net 45, 25% partner discount applied.

Book the invoices. One row per invoice, duplicates collapse to a single row.`,
      expected: [
        { vendor: 'Corvid Analytics', amountCents: 207900, currency: 'USD', dueDate: '2026-05-19' },
        { vendor: 'Hollowpoint Media', amountCents: 127550, currency: 'GBP', dueDate: '2026-05-31' },
        { vendor: 'Meridian Grid', amountCents: 40500, currency: 'EUR', dueDate: '2026-06-14' },
        { vendor: 'Ninefold Robotics', amountCents: 90000, currency: 'USD', dueDate: '2026-07-08' },
      ],
    },
  },
};

/* ------------------------------------------------------------------ */
/* 2. date normalisation                                               */
/* ------------------------------------------------------------------ */

const dateSpec = {
  contract:
    'Return a JSON array of ISO dates (YYYY-MM-DD) in the same order as the input list, with null for anything that cannot be resolved. Dash and dot separated numeric dates are DD-MM-YYYY or DD.MM.YYYY. Slash dates are YYYY/MM/DD. Compact 8 digit strings are YYYYMMDD. ISO timestamps keep the date part only. Notes like TBD and calendar-invalid dates become null.',
  grade(raw: string, expected: unknown): Grade {
    let got: unknown;
    try {
      got = extractJson(raw);
    } catch (e) {
      return parseFail(raw, e);
    }
    if (!Array.isArray(got)) return fail(0, ['answer is not a JSON array']);
    const exp = expected as (string | null)[];
    const failures: string[] = [];
    let hits = 0;
    if (got.length !== exp.length) failures.push(`expected ${exp.length} dates, got ${got.length}`);
    exp.forEach((want, i) => {
      if ((got as unknown[])[i] === want) hits++;
      else failures.push(`item ${i + 1}: expected ${JSON.stringify(want)}, got ${JSON.stringify((got as unknown[])[i])}`);
    });
    return fail(hits / exp.length, failures);
  },
};

export const dateTask: TaskSpec = {
  id: 'dates',
  title: 'Normalise twelve mixed format dates',
  domain: 'data cleanup',
  contract: dateSpec.contract,
  grade: dateSpec.grade,
  variants: {
    public: {
      input: `Normalise this list, keeping the original order:
1. 12 Mar 2026
2. 2026/03/04
3. 05-04-2026
4. 4th of March 2026
5. Mar 5, '26
6. 20260306
7. 07.03.2026
8. next Friday after 2026-03-02
9. 2026-03-09T14:30:00Z
10. TBD
11. 2026/02/31
12. 15 Mar 2026`,
      expected: [
        '2026-03-12',
        '2026-03-04',
        '2026-04-05',
        '2026-03-04',
        '2026-03-05',
        '2026-03-06',
        '2026-03-07',
        '2026-03-06',
        '2026-03-09',
        null,
        null,
        '2026-03-15',
      ],
    },
    holdout: {
      input: `Normalise this list, keeping the original order:
1. 3 Nov 2026
2. 2026/11/14
3. 12-11-2026
4. 21st of November 2026
5. Nov 2, '26
6. 20261120
7. 09.11.2026
8. next Tuesday after 2026-11-02
9. 2026-11-30T23:59:00Z
10. unknown
11. 2026/02/30
12. 18 Nov 2026`,
      expected: [
        '2026-11-03',
        '2026-11-14',
        '2026-11-12',
        '2026-11-21',
        '2026-11-02',
        '2026-11-20',
        '2026-11-09',
        '2026-11-03',
        '2026-11-30',
        null,
        null,
        '2026-11-18',
      ],
    },
  },
};

/* ------------------------------------------------------------------ */
/* 3. CSV repair                                                       */
/* ------------------------------------------------------------------ */

const csvSpec = {
  contract:
    'Return the repaired CSV only, no prose and no code fence. Header exactly id,name,city,total. Drop blank lines, drop duplicate rows keeping the first occurrence, sort rows by id ascending, write totals as plain decimals with two places and no thousands separator, and quote only fields that contain a comma.',
  grade(raw: string, expected: unknown): Grade {
    const text = stripFences(raw).replace(/\r\n/g, '\n').trim();
    const want = String(expected).trim();
    if (text === want) return fail(1, []);
    const gotLines = text.split('\n').map((l) => l.trimEnd());
    const wantLines = want.split('\n');
    const failures: string[] = [];
    let hits = 0;
    if (gotLines[0] !== wantLines[0]) failures.push(`header: expected "${wantLines[0]}", got "${gotLines[0]}"`);
    else hits++;
    for (let i = 1; i < wantLines.length; i++) {
      if (gotLines[i] === wantLines[i]) hits++;
      else failures.push(`line ${i + 1}: expected "${wantLines[i]}", got "${gotLines[i] ?? '(missing)'}"`);
    }
    if (gotLines.length !== wantLines.length) failures.push(`expected ${wantLines.length} lines, got ${gotLines.length}`);
    return fail(hits / wantLines.length, failures);
  },
};

export const csvTask: TaskSpec = {
  id: 'csv',
  title: 'Repair a broken CSV export',
  domain: 'data cleanup',
  contract: csvSpec.contract,
  grade: csvSpec.grade,
  variants: {
    public: {
      input: `This export came out of a legacy system and is wrong in several ways. Fix it.

id,name,city,total
3,"Acme, Inc.",Pune,"1,240.50"
1,Globex,Mumbai,980
2,"Initech, Ltd.",Delhi,1500.00
3,"Acme, Inc.",Pune,"1,240.50"

4,Umbrella,Chennai,1200.5
5,"Wonka, Ltd.",Goa,75
2,"Initech, Ltd.",Delhi,1500.00
6,Nakatomi,Hyderabad,0`,
      expected: `id,name,city,total
1,Globex,Mumbai,980.00
2,"Initech, Ltd.",Delhi,1500.00
3,"Acme, Inc.",Pune,1240.50
4,Umbrella,Chennai,1200.50
5,"Wonka, Ltd.",Goa,75.00
6,Nakatomi,Hyderabad,0.00`,
    },
    holdout: {
      input: `This export came out of a legacy system and is wrong in several ways. Fix it.

id,name,city,total
7,"Soylent, Corp.",Austin,"3,400.25"
2,Zentek,Denver,110
5,"Hooli, Inc.",Palo Alto,"2,215.75"

2,Zentek,Denver,110
9,Vehement,Chennai,950.5
7,"Soylent, Corp.",Austin,"3,400.25"
11,Massive Dynamic,Sunnyvale,2000`,
      expected: `id,name,city,total
2,Zentek,Denver,110.00
5,"Hooli, Inc.",Palo Alto,2215.75
7,"Soylent, Corp.",Austin,3400.25
9,Vehement,Chennai,950.50
11,Massive Dynamic,Sunnyvale,2000.00`,
    },
  },
};

/* ------------------------------------------------------------------ */
/* 4. discount and tax arithmetic                                      */
/* ------------------------------------------------------------------ */

const mathSpec = {
  contract:
    'Return one JSON object with exactly these integer cent fields: lineDiscountCents, netSubtotalCents, orderDiscountCents, taxCents, totalCents. Apply rules in this order: per line bulk discount first, then the order level discount on the net subtotal, then tax on the post discount amount. Round half up to the nearest cent at every stage, and round each line discount before summing them.',
  grade(raw: string, expected: unknown): Grade {
    let got: unknown;
    try {
      got = extractJson(raw);
    } catch (e) {
      return parseFail(raw, e);
    }
    if (typeof got !== 'object' || got === null || Array.isArray(got)) return fail(0, ['answer is not a single JSON object']);
    const failures = objectDiff(expected, got);
    const keys = Object.keys(expected as Record<string, unknown>).length;
    const hits = keys - failures.filter((f) => !f.includes('unexpected key')).length;
    return fail(Math.max(0, hits) / keys, failures);
  },
};

export const mathTask: TaskSpec = {
  id: 'math',
  title: 'Order total with bulk and tiered discounts',
  domain: 'finance ops',
  contract: mathSpec.contract,
  grade: mathSpec.grade,
  variants: {
    public: {
      input: `Price this order and return the numbers.

Lines:
- SKU-A x3 at 2500 cents each
- SKU-B x1 at 4200 cents each
- SKU-C x2 at 1100 cents each
- SKU-D x4 at 640 cents each

Rules:
1. Any line with 3 or more units gets a 4% line discount.
2. If the net subtotal is above 12000 cents, take 10% off the whole order.
3. Tax is 8.25% of the post discount amount.`,
      expected: {
        lineDiscountCents: 402,
        netSubtotalCents: 16058,
        orderDiscountCents: 1606,
        taxCents: 1192,
        totalCents: 15644,
      },
    },
    holdout: {
      input: `Price this order and return the numbers.

Lines:
- SKU-D x4 at 1800 cents each
- SKU-E x2 at 3350 cents each
- SKU-F x1 at 900 cents each
- SKU-G x3 at 725 cents each

Rules:
1. Any line with 3 or more units gets a 4% line discount.
2. If the net subtotal is above 12000 cents, take 10% off the whole order.
3. Tax is 8.25% of the post discount amount.`,
      expected: {
        lineDiscountCents: 375,
        netSubtotalCents: 16600,
        orderDiscountCents: 1660,
        taxCents: 1233,
        totalCents: 16173,
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* 5. clause risk tiers                                                */
/* ------------------------------------------------------------------ */

const RISK_RUBRIC = `Rubric:
high   = auto-renew term longer than 12 months, unlimited or uncapped liability, or termination without notice.
medium = payment terms beyond 60 days, assignment of pre-existing IP, or mandatory arbitration in a foreign forum.
low    = anything else.`;

const riskSpec = {
  contract:
    'Return a JSON array with one object per clause: {id, tier, reason}. tier is exactly one of high, medium, low. reason is 12 words or fewer and names the rubric trigger.',
  grade(raw: string, expected: unknown): Grade {
    let got: unknown;
    try {
      got = extractJson(raw);
    } catch (e) {
      return parseFail(raw, e);
    }
    if (!Array.isArray(got)) return fail(0, ['answer is not a JSON array']);
    const exp = expected as { id: string; tier: string }[];
    const failures: string[] = [];
    let tierHits = 0;
    let reasonHits = 0;
    if (got.length !== exp.length) failures.push(`expected ${exp.length} rows, got ${got.length}`);
    for (const want of exp) {
      const row = (got as Record<string, unknown>[]).find((r) => r && r.id === want.id);
      if (!row) {
        failures.push(`${want.id}: missing`);
        continue;
      }
      if (row.tier === want.tier) tierHits++;
      else failures.push(`${want.id}: tier expected ${want.tier}, got ${JSON.stringify(row.tier)}`);
      const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
      const words = reason ? reason.split(/\s+/).length : 0;
      if (words > 0 && words <= 12) reasonHits++;
      else failures.push(`${want.id}: reason must be 1 to 12 words, got ${words}`);
    }
    const score = (tierHits / exp.length) * 0.7 + (reasonHits / exp.length) * 0.3;
    return fail(score, failures);
  },
};

export const riskTask: TaskSpec = {
  id: 'risk',
  title: 'Tier nine contract clauses',
  domain: 'legal ops',
  contract: riskSpec.contract,
  grade: riskSpec.grade,
  variants: {
    public: {
      input: `Tier each clause.

c1. The Term renews automatically for successive periods of 24 months unless either party gives notice.
c2. Supplier's aggregate liability under this Agreement shall be unlimited.
c3. Customer may terminate this Agreement at any time without notice.
c4. Customer shall pay each invoice within 90 days of receipt.
c5. Supplier hereby assigns all pre-existing intellectual property to Customer.
c6. The Agreement is governed by the laws of Singapore, with disputes resolved by binding arbitration in Singapore.
c7. Either party may audit the other's compliance records once per year on 30 days notice.
c8. Supplier may subcontract any part of the services to affiliates without notice.
c9. The Term of this Agreement is 6 months, renewable for 12 month periods.

${RISK_RUBRIC}`,
      expected: [
        { id: 'c1', tier: 'high' },
        { id: 'c2', tier: 'high' },
        { id: 'c3', tier: 'high' },
        { id: 'c4', tier: 'medium' },
        { id: 'c5', tier: 'medium' },
        { id: 'c6', tier: 'medium' },
        { id: 'c7', tier: 'low' },
        { id: 'c8', tier: 'low' },
        { id: 'c9', tier: 'low' },
      ],
    },
    holdout: {
      input: `Tier each clause.

c1. This Agreement renews for consecutive 36 month terms unless cancelled 90 days before expiry.
c2. In no event shall either party's liability be limited, capped, or excluded.
c3. Either party may end this Agreement immediately, for any reason, without prior notice.
c4. All amounts are payable 120 days after the invoice date.
c5. All intellectual property developed before the Effective Date is transferred to Customer as part of this Agreement.
c6. Any dispute shall be finally settled by arbitration seated in Dubai under DIAC rules.
c7. The parties will meet quarterly to review service levels.
c8. Supplier may engage third party contractors to deliver the services.
c9. The initial term is 9 months and renews for 6 month periods.

${RISK_RUBRIC}`,
      expected: [
        { id: 'c1', tier: 'high' },
        { id: 'c2', tier: 'high' },
        { id: 'c3', tier: 'high' },
        { id: 'c4', tier: 'medium' },
        { id: 'c5', tier: 'medium' },
        { id: 'c6', tier: 'medium' },
        { id: 'c7', tier: 'low' },
        { id: 'c8', tier: 'low' },
        { id: 'c9', tier: 'low' },
      ],
    },
  },
};

/* ------------------------------------------------------------------ */
/* 6. request payload assembly                                         */
/* ------------------------------------------------------------------ */

const payloadSpec = {
  contract: `Return one JSON object only, snake_case keys, with:
customer_id (integer), company (string), plan_tier (lowercase: pro or team), billing_interval (monthly or annual), seat_count (integer), trial_days (integer, 0 when there is no trial), mrr_cents (integer, seat_count times the per seat monthly price in cents), start_date (YYYY-MM-DD), auto_renew (boolean), billing_address {street, city, postal_code, country} with a two letter uppercase country, and metadata.referral_code when a referral exists. Omit any key whose value is null or empty, including metadata when it has no entries. No extra keys.`,
  grade(raw: string, expected: unknown): Grade {
    let got: unknown;
    try {
      got = extractJson(raw);
    } catch (e) {
      return parseFail(raw, e);
    }
    const failures = objectDiff(expected, got);
    const exp = expected as Record<string, unknown>;
    const keys = Object.keys(exp).length;
    const missing = failures.filter((f) => f.includes('missing') || f.includes('unexpected key')).length;
    const wrong = failures.length - missing;
    const score = Math.max(0, 1 - (wrong * 0.5 + missing) / Math.max(keys, 1));
    return fail(score, failures);
  },
};

export const payloadTask: TaskSpec = {
  id: 'payload',
  title: 'Build a subscription request body',
  domain: 'api work',
  contract: payloadSpec.contract,
  grade: payloadSpec.grade,
  variants: {
    public: {
      input: `Customer record:
company: Northwind Ops (id 4471)
plan: Pro, billed annual
seats: 12
trial: no trial
address: 14 Lodhi Road, New Delhi, 110003, IN
referral: LAUNCH26
discount code: none
per seat monthly price: $49.00
start: 15 March 2026
auto renew: yes

Build the body for POST /v1/subscriptions.`,
      expected: {
        customer_id: 4471,
        company: 'Northwind Ops',
        plan_tier: 'pro',
        billing_interval: 'annual',
        seat_count: 12,
        trial_days: 0,
        mrr_cents: 58800,
        start_date: '2026-03-15',
        auto_renew: true,
        billing_address: { street: '14 Lodhi Road', city: 'New Delhi', postal_code: '110003', country: 'IN' },
        metadata: { referral_code: 'LAUNCH26' },
      },
    },
    holdout: {
      input: `Customer record:
company: Cobalt Freight (id 5120)
plan: Team, billed monthly
seats: 4
trial: 14 days
address: 8 Harbour Street, Cape Town, 8001, za
referral: none
discount code: WINTER
per seat monthly price: $89.00
start: 2 April 2026
auto renew: no

Build the body for POST /v1/subscriptions.`,
      expected: {
        customer_id: 5120,
        company: 'Cobalt Freight',
        plan_tier: 'team',
        billing_interval: 'monthly',
        seat_count: 4,
        trial_days: 14,
        mrr_cents: 35600,
        start_date: '2026-04-02',
        auto_renew: false,
        billing_address: { street: '8 Harbour Street', city: 'Cape Town', postal_code: '8001', country: 'ZA' },
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* 7. changelog with a house style                                     */
/* ------------------------------------------------------------------ */

interface Check {
  ok: boolean;
  detail: string;
}

function scoreChecks(checks: Check[]): Grade {
  const failures = checks.filter((c) => !c.ok).map((c) => c.detail);
  return fail(checks.filter((c) => c.ok).length / checks.length, failures);
}

const wordsOf = (text: string) => text.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;

export interface ChangelogExpected {
  refs: string[];
  choreRefs: string[];
  breakingRef: string;
  addedRefs: string[];
  breakingMustMention: string;
  maxWords: number;
  maxBulletWords: number;
}

const changelogSpec = {
  contract: `Return markdown only, no prose before or after. Exactly three sections, in this order: "## Breaking", "## Added", "## Fixed". One bullet per shipped change, each bullet at most 14 words. Include each feature and fix reference exactly once, in the section it belongs to. Never mention chore commits. No em dashes, en dashes or semicolons anywhere. Total at most 120 words. The Breaking section has exactly one bullet and it names the new requirement.`,
  grade(raw: string, expected: unknown): Grade {
    const e = expected as ChangelogExpected;
    const text = stripFences(raw).trim();
    if (wordsOf(text) < 12) return fail(0, ['answer is empty or far too short to be the requested document']);
    const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    const bullets = text.split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
    const refsIn = (s: string) => (s.match(/#\d{3}/g) ?? []) as string[];
    const allRefs = refsIn(text);

    const sectionOf = (ref: string) => {
      const idx = text.indexOf(ref);
      if (idx < 0) return null;
      const before = text.slice(0, idx);
      const lastHeading = [...before.matchAll(/^##\s+(.+)$/gm)].pop();
      return lastHeading ? lastHeading[1].trim().toLowerCase() : null;
    };

    const checks: Check[] = [
      {
        ok: headings.length === 3 && headings.map((h) => h.toLowerCase()).join('|') === 'breaking|added|fixed',
        detail: `sections: expected ## Breaking, ## Added, ## Fixed in that order, got ${JSON.stringify(headings)}`,
      },
      {
        ok: e.refs.every((r) => allRefs.filter((x) => x === r).length === 1),
        detail: `references: expected each of ${e.refs.join(', ')} exactly once, got ${JSON.stringify(allRefs)}`,
      },
      {
        ok: e.choreRefs.every((r) => !text.includes(r)),
        detail: `chore references must not appear: ${e.choreRefs.filter((r) => text.includes(r)).join(', ')} leaked in`,
      },
      {
        ok: e.refs.every((r) => {
          const want = r === e.breakingRef ? 'breaking' : e.addedRefs.includes(r) ? 'added' : 'fixed';
          return sectionOf(r) === want;
        }),
        detail: 'references are not in the right section (features under Added, fixes under Fixed, the breaking change under Breaking)',
      },
      {
        ok: bullets.length > 0 && bullets.every((b) => wordsOf(b) <= e.maxBulletWords),
        detail: `bullets: at most ${e.maxBulletWords} words each, longest is ${Math.max(0, ...bullets.map(wordsOf))}`,
      },
      {
        ok: !/[\u2014\u2013;]/.test(text),
        detail: 'forbidden punctuation: em dash, en dash or semicolon found',
      },
      {
        ok: wordsOf(text) <= e.maxWords,
        detail: `length: at most ${e.maxWords} words, got ${wordsOf(text)}`,
      },
      {
        ok:
          text.toLowerCase().includes(e.breakingMustMention.toLowerCase()) &&
          bullets.filter((b) => b.toLowerCase().includes(e.breakingMustMention.toLowerCase())).length === 1,
        detail: `the Breaking bullet must name ${e.breakingMustMention} exactly once`,
      },
    ];
    return scoreChecks(checks);
  },
};

export const changelogTask: TaskSpec = {
  id: 'changelog',
  title: 'Release notes in the house style',
  domain: 'developer comms',
  contract: changelogSpec.contract,
  grade: changelogSpec.grade,
  variants: {
    public: {
      input: `Write the changelog for release 2.14.0 from these commits.

- #412 feat!: drop Node 18 support, require Node 20
- #415 chore: bump prettier to 3.4
- #418 feat: add CSV export to the reports page
- #421 fix: stop duplicate webhook deliveries on retry
- #423 feat: keyboard shortcuts for the queue view
- #425 fix: timezone drift in the weekly digest
- #427 chore: remove unused feature flags
- #430 fix: crash when a filter returns no rows`,
      expected: {
        refs: ['#412', '#418', '#421', '#423', '#425', '#430'],
        choreRefs: ['#415', '#427'],
        breakingRef: '#412',
        addedRefs: ['#418', '#423'],
        breakingMustMention: 'Node 20',
        maxWords: 120,
        maxBulletWords: 14,
      } satisfies ChangelogExpected,
    },
    holdout: {
      input: `Write the changelog for release 3.0.1 from these commits.

- #501 feat!: remove the legacy XML importer, use the JSON importer
- #503 chore: upgrade test runners
- #506 feat: bulk approve pending requests
- #509 fix: truncated names in exported PDFs
- #511 feat: audit log retention setting
- #514 fix: retry storm when the queue drains
- #517 chore: tidy CI cache keys
- #520 fix: wrong cursor on the archived tab`,
      expected: {
        refs: ['#501', '#506', '#509', '#511', '#514', '#520'],
        choreRefs: ['#503', '#517'],
        breakingRef: '#501',
        addedRefs: ['#506', '#511'],
        breakingMustMention: 'JSON importer',
        maxWords: 120,
        maxBulletWords: 14,
      } satisfies ChangelogExpected,
    },
  },
};

/* ------------------------------------------------------------------ */
/* 8. customer incident update                                         */
/* ------------------------------------------------------------------ */

export interface IncidentExpected {
  headings: string[];
  maxWords: number;
  regions: string[];
  allowedPercents: string[];
  allowedTimestamps: string[];
  minTimestamps: number;
}

const incidentSpec = {
  contract: `Return the update only. Sections, in order and with these exact headings: "## Summary", "## Impact", "## Timeline", "## What we are doing", "## Next update". At most 180 words. The Summary is one sentence of at most 25 words. Timeline entries start with an HH:MM UTC timestamp. Do not speculate: no "probably", "likely", "we believe", "appears to", "seems to" or "root cause is". State the affected regions exactly as given. No percentage other than the ones in the facts. Next update must give a time in HH:MM UTC.`,
  grade(raw: string, expected: unknown): Grade {
    const e = expected as IncidentExpected;
    const text = stripFences(raw).trim();
    if (wordsOf(text) < 12) return fail(0, ['answer is empty or far too short to be the requested document']);
    const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim().toLowerCase());
    const summary = text.split(/^##\s+Impact/m)[0] ?? '';
    const summaryBody = summary.replace(/^##\s+Summary/m, '').trim();
    const summarySentences = summaryBody.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
    const percents = (text.match(/\d+(?:\.\d+)?\s?%/g) ?? []).map((s) => s.replace(/\s/g, ''));
    const banned = ['probably', 'likely', 'we believe', 'appears to', 'seems to', 'root cause is'];
    const timestamps = text.match(/\d{2}:\d{2} UTC/g) ?? [];
    const lower = text.toLowerCase();

    const checks: Check[] = [
      {
        ok: headings.slice(0, e.headings.length).join('|') === e.headings.join('|'),
        detail: `sections must be ${e.headings.map((h) => `## ${h}`).join(', ')} in order, got ${JSON.stringify(headings)}`,
      },
      { ok: wordsOf(text) <= e.maxWords, detail: `length: at most ${e.maxWords} words, got ${wordsOf(text)}` },
      {
        ok: summarySentences.length === 1 && wordsOf(summaryBody) <= 25,
        detail: `summary must be one sentence of at most 25 words, got ${summarySentences.length} sentence(s) and ${wordsOf(summaryBody)} words`,
      },
      {
        ok: banned.every((b) => !lower.includes(b)),
        detail: `speculation language found: ${banned.filter((b) => lower.includes(b)).join(', ')}`,
      },
      {
        ok: e.regions.every((r) => text.includes(r)),
        detail: `affected regions missing: ${e.regions.filter((r) => !text.includes(r)).join(', ')}`,
      },
      {
        ok: timestamps.length >= e.minTimestamps,
        detail: `timeline needs at least ${e.minTimestamps} HH:MM UTC timestamps, got ${timestamps.length}`,
      },
      {
        ok: timestamps.every((t) => e.allowedTimestamps.includes(t)),
        detail: `invented timestamps: ${timestamps.filter((t) => !e.allowedTimestamps.includes(t)).join(', ') || 'none'}`,
      },
      {
        ok: percents.every((p) => e.allowedPercents.includes(p)),
        detail: `percentages other than ${e.allowedPercents.join(', ')} were invented: ${percents.filter((p) => !e.allowedPercents.includes(p)).join(', ') || 'none'}`,
      },
      {
        ok: /##\s+Next update[\s\S]*\d{2}:\d{2} UTC/i.test(text),
        detail: 'the Next update section must commit to a time in HH:MM UTC',
      },
    ];
    return scoreChecks(checks);
  },
};

export const incidentTask: TaskSpec = {
  id: 'incident',
  title: 'Customer incident update from raw facts',
  domain: 'customer comms',
  contract: incidentSpec.contract,
  grade: incidentSpec.grade,
  variants: {
    public: {
      input: `Turn these facts into the customer facing update. Only use what is here.

14:02 UTC deploy 8841 went out
14:05 UTC checkout error rate rose to 18%
14:07 UTC on-call paged
14:19 UTC rolled back to 8839
14:26 UTC error rate back to 0.4%
Affected: EU and APAC. US was unaffected.
Cause: a migration in 8841 added a NOT NULL column without a default.
Next update due 15:00 UTC.`,
      expected: {
        headings: ['summary', 'impact', 'timeline', 'what we are doing', 'next update'],
        maxWords: 180,
        regions: ['EU', 'APAC'],
        allowedPercents: ['18%', '0.4%'],
        allowedTimestamps: ['14:02 UTC', '14:05 UTC', '14:07 UTC', '14:19 UTC', '14:26 UTC', '15:00 UTC'],
        minTimestamps: 3,
      } satisfies IncidentExpected,
    },
    holdout: {
      input: `Turn these facts into the customer facing update. Only use what is here.

09:41 UTC config change 5520 shipped
09:44 UTC login success rate dropped to 61%
09:46 UTC on-call paged
09:52 UTC reverted to 5519
10:03 UTC success rate back to 99.7%
Affected: LATAM and APAC. EU was unaffected.
Cause: 5520 pointed the auth service at a stale key.
Next update due 11:00 UTC.`,
      expected: {
        headings: ['summary', 'impact', 'timeline', 'what we are doing', 'next update'],
        maxWords: 180,
        regions: ['LATAM', 'APAC'],
        allowedPercents: ['61%', '99.7%'],
        allowedTimestamps: ['09:41 UTC', '09:44 UTC', '09:46 UTC', '09:52 UTC', '10:03 UTC', '11:00 UTC'],
        minTimestamps: 3,
      } satisfies IncidentExpected,
    },
  },
};

/* ------------------------------------------------------------------ */
/* 9. short outreach email                                             */
/* ------------------------------------------------------------------ */

export interface EmailExpected {
  maxSubjectWords: number;
  maxBodyWords: number;
  mustInclude: string[];
}

const emailSpec = {
  contract: `Return the email only: a line starting "Subject:" and then the body. Subject at most 6 words. Body at most 90 words. Exactly one question mark in the whole email. No exclamation marks. No links. No em dashes. Do not open with "I hope this finds you well", "quick question", "reaching out" or "circling back". Both numbers from the pilot must appear exactly. Sign off as "Harish".`,
  grade(raw: string, expected: unknown): Grade {
    const e = expected as EmailExpected;
    const text = stripFences(raw).trim();
    if (wordsOf(text) < 12) return fail(0, ['answer is empty or far too short to be the requested email']);
    const subjectLine = text.split('\n').find((l) => /^subject:/i.test(l.trim())) ?? '';
    const subject = subjectLine.replace(/^subject:\s*/i, '').trim();
    const body = text.replace(subjectLine, '').trim();
    const lower = text.toLowerCase();

    const checks: Check[] = [
      { ok: !!subjectLine, detail: 'missing a line starting with "Subject:"' },
      {
        ok: wordsOf(subject) <= e.maxSubjectWords && wordsOf(subject) > 0,
        detail: `subject must be 1 to ${e.maxSubjectWords} words, got ${wordsOf(subject)}`,
      },
      { ok: wordsOf(body) <= e.maxBodyWords, detail: `body must be at most ${e.maxBodyWords} words, got ${wordsOf(body)}` },
      { ok: (text.match(/\?/g) ?? []).length === 1, detail: `exactly one question mark, got ${(text.match(/\?/g) ?? []).length}` },
      { ok: !text.includes('!'), detail: 'exclamation mark found' },
      { ok: !/https?:\/\/|www\./.test(text), detail: 'a link was included' },
      { ok: !/[\u2014\u2013]/.test(text), detail: 'em dash or en dash found' },
      {
        ok: !/hope this finds you well|quick question|reaching out|circling back/i.test(lower),
        detail: 'banned opener found',
      },
      {
        ok: e.mustInclude.every((m) => text.includes(m)),
        detail: `missing pilot numbers: ${e.mustInclude.filter((m) => !text.includes(m)).join(', ')}`,
      },
      { ok: /harish/i.test(text), detail: 'missing the signature "Harish"' },
    ];
    return scoreChecks(checks);
  },
};

export const emailTask: TaskSpec = {
  id: 'email',
  title: 'Outreach email under a strict style contract',
  domain: 'customer comms',
  contract: emailSpec.contract,
  grade: emailSpec.grade,
  variants: {
    public: {
      input: `Write to Dana Whitfield, head of platform at Kestrel Freight.

Context: in the pilot we cut their invoice reconciliation time from 6 hours to 90 minutes per month end. Their team runs a Python pipeline. Goal: a 20 minute call next week.`,
      expected: {
        maxSubjectWords: 6,
        maxBodyWords: 90,
        mustInclude: ['6 hours', '90 minutes'],
      } satisfies EmailExpected,
    },
    holdout: {
      input: `Write to Marcus Bell, director of operations at Halcyon Cloud.

Context: in the pilot we cut their nightly close from 4 hours to 35 minutes. Their team runs a Go service. Goal: a 20 minute call next week.`,
      expected: {
        maxSubjectWords: 6,
        maxBodyWords: 90,
        mustInclude: ['4 hours', '35 minutes'],
      } satisfies EmailExpected,
    },
  },
};

export const TASKS: TaskSpec[] = [
  invoiceTask,
  dateTask,
  csvTask,
  mathTask,
  riskTask,
  payloadTask,
  changelogTask,
  incidentTask,
  emailTask,
];

/**
 * The suite the loop optimises against. Four tasks, four different artifact
 * types, so one harness has to hold four distinct contracts without turning
 * into a wall of rules. The rest of TASKS stays in the repo as extra coverage
 * for anyone who wants a longer run.
 */
export const SUITE: TaskSpec[] = [invoiceTask, csvTask, changelogTask, emailTask];
