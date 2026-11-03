/**
 * Extraction prompt + JSON schema for the single-call normalizer (extract v2).
 *
 * The model returns the columns search stores. Code does not rewrite city,
 * area, vicinity, phase, or place_tags with a local gazetteer.
 */

const EXTRACT_VERSION = 2;

const PROPERTY_TYPES = ['PLOT', 'HOUSE', 'BUNGALOW', 'APARTMENT', 'FLAT', 'PENTHOUSE', 'PORTION', 'SHOP', 'OFFICE', 'BUILDING', 'COMMERCIAL', 'FARMHOUSE', 'WAREHOUSE', 'OTHER'];
const SIZE_UNITS = ['SQ_YD', 'SQ_FT', 'SQ_M', 'MARLA', 'KANAL', 'ACRE', 'UNKNOWN'];
const PRICE_BASES = ['TOTAL', 'PER_MONTH', 'PER_SQ_YD', 'PER_SQ_FT', 'PER_FLOOR', 'ON_CALL', 'UNKNOWN'];

const SYSTEM_PROMPT = `You extract structured property listings from WhatsApp messages posted by Pakistani property agents. Messages are Roman Urdu, English, or Urdu script, often with emoji, *asterisks*, and several offers in one message.

These listings are in Defence (DHA), Karachi. Write Defence place names in their normal English spelling. Expand the short forms agents use. Do not change which place it is. A header phase does not override a place that belongs to a different phase.

Spelling examples for Defence Karachi. Expand these in area, vicinity, location_text, street_text, and place_tags. A website such as facebook.com is not a place.
- comm / comm. / com / comercial / commerical = Commercial. "Muslim Comm" = "Muslim Commercial". "Rahat Com" = "Rahat Commercial". "bukhari comercial" = "Bukhari Commercial". "8th comm street" = "8th Commercial Street".
- khy / kh-e / khy-e / kh e / khayban = Khayaban. "khy saadi" = "Khayaban Saadi". "khy e Shaheen" = "Khayaban-e-Shaheen". "KHY-E-SHAHBAZ" = "Khayaban-e-Shahbaz".
- st = Street. "Sahil st 23" = "Sahil Street 23". "Rahat St 1" = "Rahat Street 1". "12th st" = "12th Street".
- ln = Lane. "Ln-4" = "Lane 4". "Murtaza Ln-3" = "Murtaza Lane 3".
- blk = Block. "Clifton Blk 4" = "Clifton Block 4".
- sec = Sector. "Sec 5B" = "Sector 5B". "SEC 3A" = "Sector 3A".
- ph, when a number follows, = Phase. "Ph 6" = "Phase 6". "Defence ph 4" = "Defence Phase 4". The phase integer is that written number.
- ext = Extension. "Phase 7 Ext" = "Phase 7 Extension". "Ph 2 ext" = "Phase 2 Extension". The phase integer stays the number written.
- Defense = Defence.
- DCK / D.C.K. = DHA City Karachi. A sector number is DHA City, not a DHA phase.
- Precinct / BTK / P10A / P15B = Bahria Town Karachi only. Precincts are not DHA phases. Never store P4 or P15B as phase 4 or 15. Write vicinity as "Precinct 10A" and put "Precinct 10A", "P10A", "BTK", "Bahria Town Karachi" in place_tags. Ignore Bahria Rawalpindi, Bahria Heights, Bahria Lahore, and DHA Khayaban-e-Bahria.
- "800s" / "570 series" is a plot number series, not a size. Do not copy it into size.
- If the offer writes yards, that size wins. If it writes no yards, leave size null (a precinct map fills cuttings later). Extra land ("500 + 125 extra") keeps the main written size, not the sum.
- BTK apartment / tower / flat with no precinct is Precinct 19. BTK farmhouse with no precinct is Precinct 18.
- A Market and B Market are DHA Phase 2.
- Zone A–E, D Cutting, Arafat / Khayaban-e-Arafat are DHA Phase 8. Zones are not Clifton.
- Clifton Block N is Clifton, Karachi. It is not DHA Phase N. Never mix Clifton and DHA.
- Defence View is a separate society. It is not DHA.

Fix agent typing errors in area, vicinity, location_text, street_text, summary, price, and place_tags. Examples: NEOGASHABLE = Negotiable, commerical = Commercial, pahse = Phase. listing_excerpt stays the original offer lines.

Return only facts written in the message, after those spelling expansions. Do not add a society, street, or city that the message does not say. A phase written on an offer stays that phase. A bare street number does not imply a different phase.

## What counts as a property message
is_property = true for an offer (sale/rent) or a requirement. false for greetings, forwards, group links only, job ads, courses, general chat.
kind = REQUIREMENT only when someone wants to buy or rent a property: "req", "Req", "requirement", "required 500 yards", "plot chahiye", "looking to buy", "looking to rent", "want to purchase". kind = OFFER when the agent has the property (for sale / for rent / demand card / looking for buyers / buyer required / tenant wanted). These phrases are deal terms, never requirement inventory — even if the word required/requirement/req appears: "commission required", "percentage % required", "covering required", "renovation required", "profile required", "tenant profile required", "offer required", "OFFER REQ", "confirm offer req", "required quote", "required well maintain", "required 50% white money". If those are the only required/req words, kind MUST be OFFER. "Req 500 yards" / "plot chahiye" is REQUIREMENT. "OFFER REQ" on a for-sale card is OFFER.

## Multiple offers
Return one listings[] entry per distinct property (max 40).
- A header ("DHA PHASE 8", "Defence Phase VI") applies to the offers under it until the next header, unless that offer names a place in a different Defence phase. Then write the place's phase, not the header. Under "DHA PHASE 08", Sahil and Zone D stay Phase 8. Khayaban-e-Tanzeem is Phase 5, so that listing's phase is 5.
- One offer line is one listing. A header line alone is not a listing.
- listing_excerpt = the exact lines of this offer only.

## Fields search stores (fill these yourself)
- purpose: SALE or RENT. Null if unstated. "Demand"/"Dem" is a price, not rent. "kiraya", "rent", "lease" = RENT.
- property_type: one enum value matching what is written.
- city: only if a city is written (Karachi, Lahore, Islamabad). Otherwise null. DHA, Defence, Clifton, and Phase do not imply a city.
- area: the society, scheme, or named place, with Defence Karachi spelling expanded (DHA, Bahria Town, Clifton, "Muslim Comm" = "Muslim Commercial"). Null if not written.
- vicinity: the specific place for this offer, in one string, with the same spelling expansion (phase, commercial, khayaban, sector, block, street). Example: "Phase 6, 33rd Street". "khy Bukhari, 12th st" = "Khayaban Bukhari, 12th Street". Do not add places that are not in the message. Amenities are not places (Bug Garden, Swimming Pool, Servant Quarters, Fully Furnish).
- phase: integer when this offer states a phase ("Phase 6", "PHASE VI", "Ph-8", "Phase II" = 2, "phase 7 ext" = 7), or when this offer names A Market / B Market (2), a Phase 8 zone, or a Defence place in a different phase than the header. Clifton Block N is not a phase. Sector N is DHA City, not a phase. Precinct N is Bahria Town. Otherwise null. A street number alone does not change the header phase.
- phase_max: when the offer names a phase range ("Phase 5 to 7", "Ph 5-8"), phase is the first number and phase_max is the last. Put every phase in that range in place_tags ("Phase 5", "Phase 6", "Phase 7"). Null when there is only one phase.
- place_tags: short phrases from this offer that should match search (the society, the phase phrase, the street, the commercial), using the expanded Defence spellings. For a phase range, include each phase. Do not add Clifton to a DHA listing. Do not add districts, tehsils, or "Karachi Division".
- price_flagged: true when the written price looks like a typing error (missing crore/lakh, an extra zero, 9.60 written as 960, a demand far outside normal Karachi asking prices). false when the price is normal or on call.
- price_flag_reason: a short reason when price_flagged is true, otherwise null.
- location_text: the locality or commercial, spelling expanded ("Muslim Comm" = "Muslim Commercial"). street_text: the street or lane, spelling expanded ("12th st" = "12th Street"). Null if absent.
- size: the size phrase as written ("500 yards", "2 Kanal"). size_value = the first size number. size_unit from the enum (yard/yrd/gaz = SQ_YD, sqft/sft = SQ_FT). Bedrooms, floors, plot numbers, street numbers, and phones are not sizes. "60x100" is dimensions_text, not size.
- price: the full price phrase as written ("1 Crore 90 Lakh", "13.Crore", "80 to 85 lakh", "4.50"). Null for "on call" or when absent. Phones are not prices. In Bahria Town / BTK ads, "@42", "@ 4.50", "@85 lac" is the asking price — copy it into price (you may drop the @) and fill price_value. @ is not a mention or username.
- price_value: that price in PKR as one number (1 crore = 10000000, 1 lakh = 100000, 4.50 lakh = 450000, 13 crore = 130000000). For a range, price_value is the lower number, price_min and price_max are the ends. Null if there is no price.
- price_basis: TOTAL, PER_MONTH (rent), PER_SQ_YD, PER_SQ_FT, PER_FLOOR, ON_CALL, or UNKNOWN.
- contact_numbers: phones as written. agent_name if written. summary: one short line. confidence: 0 to 1.

## Roman Urdu
dem/demand = asking price; kiraya = rent; farokht = sale; chahiye = wants to buy/rent; "required" after commission/percentage/covering/renovation/profile/offer/white money is not a requirement; lac/lakh = 100000; crore/cr = 10000000; hazar = 1000; gaz/yrd = square yard; mein/main often means "in", not a place name.

Return JSON only, matching the schema. Use null for anything not written.`;

const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const nullableEnum = (values) => ({ type: ['string', 'null'], enum: [...values, null] });

const LISTING_SCHEMA = {
  type: 'object',
  properties: {
    listing_excerpt: { type: 'string' },
    kind: { type: 'string', enum: ['OFFER', 'REQUIREMENT'] },
    purpose: nullableEnum(['SALE', 'RENT']),
    property_type: nullableEnum(PROPERTY_TYPES),
    city: nullable('string'),
    area: nullable('string'),
    vicinity: nullable('string'),
    phase: nullable('integer'),
    phase_max: nullable('integer'),
    place_tags: { type: 'array', items: { type: 'string' } },
    location_text: nullable('string'),
    street_text: nullable('string'),
    size: nullable('string'),
    size_value: nullable('number'),
    size_unit: nullableEnum(SIZE_UNITS),
    dimensions_text: nullable('string'),
    price: nullable('string'),
    price_value: nullable('number'),
    price_min: nullable('number'),
    price_max: nullable('number'),
    price_basis: nullableEnum(PRICE_BASES),
    contact_numbers: { type: 'array', items: { type: 'string' } },
    agent_name: nullable('string'),
    summary: nullable('string'),
    price_flagged: { type: 'boolean' },
    price_flag_reason: nullable('string'),
    confidence: { type: 'number' }
  },
  required: ['listing_excerpt', 'kind']
};

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    is_property: { type: 'boolean' },
    language: { type: 'string', enum: ['en', 'ur', 'roman_ur', 'mixed'] },
    listings: { type: 'array', items: LISTING_SCHEMA, maxItems: 40 }
  },
  required: ['is_property', 'listings']
};

/** JSON Schema -> Gemini responseSchema (OpenAPI subset: UPPERCASE types + nullable). */
function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && Array.isArray(v)) {
      const real = v.find((t) => t !== 'null');
      out.type = String(real).toUpperCase();
      if (v.includes('null')) out.nullable = true;
    } else if (k === 'type') {
      out.type = String(v).toUpperCase();
    } else if (k === 'enum') {
      out.enum = v.filter((x) => x !== null);
    } else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items') {
      out.items = toGeminiSchema(v);
    } else if (k === 'maxItems') {
      out.maxItems = String(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** User message sent with SYSTEM_PROMPT. Keep SYSTEM_PROMPT byte-identical across calls (prompt caching). */
function buildUserMessage(cleanedText, { sender } = {}) {
  const who = sender ? `Sender: ${sender}\n` : '';
  return `${who}Message:\n${cleanedText}`;
}

module.exports = {
  EXTRACT_VERSION,
  PROPERTY_TYPES,
  SIZE_UNITS,
  PRICE_BASES,
  SYSTEM_PROMPT,
  EXTRACTION_SCHEMA,
  toGeminiSchema,
  buildUserMessage
};
