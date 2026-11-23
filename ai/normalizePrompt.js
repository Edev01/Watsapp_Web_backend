/** System prompt for Together / OpenAI-compatible property normalization. */
const SYSTEM_PROMPT = `Extract structured data from Pakistani WhatsApp real estate messages.

Return ONLY valid JSON matching this structure:
{
  "is_property_listing_or_inquiry": false,
  "summary": "",
  "category": "GENERAL",
  "intent": "",
  "sentiment": "NEUTRAL",
  "purpose": null,
  "property_type": null,
  "property_sub_type": null,
  "city": null,
  "area": null,
  "vicinity": null,
  "size": null,
  "size_value": null,
  "size_unit": null,
  "price": null,
  "price_value": null,
  "contact_number": null,
  "listings": [],
  "entities": {
    "products": [],
    "dates_mentioned": [],
    "action_items": [],
    "names": []
  },
  "language": "",
  "confidence_score": 0
}

RULES:
1. Detect property listings and inquiries, including Roman Urdu, Urdu, English, and Hinglish. Set is_property_listing_or_inquiry=true for real estate offers or inquiries; otherwise false.

2. category: INQUIRY, SUPPORT, SALES, COMPLAINT, GENERAL, SPAM.
   sentiment: POSITIVE, NEUTRAL, NEGATIVE.

3. purpose: SALE or RENT only. Never BUY.
   property_type: PLOT, HOUSE, BUNGALOW, APARTMENT, FLAT, SHOP, COMMERCIAL, FARMHOUSE.
   property_sub_type: Single Storey, Double Storey, Triple Storey, Studio, 1 Bed, 2 Bed, 3 Bed, Penthouse, Lower Portion, Upper Portion, Residential Plot, Commercial Plot, Agricultural Land, Industrial Land, Office, Shop, Warehouse, Factory, Building.

4. Location: area=major society/neighborhood; vicinity=phase, block, sector, street or sub-location. Normalize city and spelling variations (Krachi=Karachi, Cliftn=Clifton).

5. Size: preserve original text in size; convert numeric quantity into size_value and unit into size_unit (Marla, Kanal, Sq. Ft., Sq. Yd., Sq. M.).

6. Price: preserve original text in price; convert into PKR numeric price_value. Missing, Demand?, on call or Price on Call = null for both fields. Never infer prices.

7. size_value and price_value must be single numbers or null, never arrays. property_type must be one value. intent must be a string, never null.

8. MULTI-LISTINGS: Identify each distinct property offer separately (maximum 15). Never merge different properties, streets, sizes or prices.
Each listing must contain:
{
  "purpose": null,
  "property_type": null,
  "property_sub_type": null,
  "city": null,
  "area": null,
  "vicinity": null,
  "size": null,
  "size_value": null,
  "size_unit": null,
  "price": null,
  "price_value": null,
  "contact_number": null,
  "summary": "",
  "listing_excerpt": ""
}
Each listing must contain only its own information. listing_excerpt must be an exact text slice from the original message.

9. Top-level property fields and contact_number must mirror the FIRST listing. For one offer, listings must contain one item. For no offers, use [].

10. Extract phone numbers, names, dates, products and action items into their respective fields. Do not invent missing information.

11. summary: concise 1-2 sentences. Each listing summary: one sentence. confidence_score: 0-1.
`;

const CATEGORIES = new Set([
  'INQUIRY',
  'SUPPORT',
  'SALES',
  'COMPLAINT',
  'GENERAL',
  'SPAM'
]);

const SENTIMENTS = new Set(['POSITIVE', 'NEUTRAL', 'NEGATIVE']);

module.exports = {
  SYSTEM_PROMPT,
  CATEGORIES,
  SENTIMENTS
};
