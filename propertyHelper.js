/**
 * Property Helper Utilities for Parsing Real Estate Prices & Area Units
 */

/**
 * Parses real estate price strings (e.g. "PKR 1.8 Cr", "85 Lac", "45,000 / month", "15000000") into numeric PKR.
 */
function parsePriceInPKR(priceStr, rawMsg) {
  const sourceStr = priceStr || '';
  if (!sourceStr && !rawMsg) return null;
  const str = String(sourceStr || rawMsg).toLowerCase().replace(/,/g, '').trim();

  let total = 0;
  let matchedAny = false;

  // Crores / Cr / Cror
  let crMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:cr|crore|cror|crores)\b/i);
  if (crMatch) {
    total += parseFloat(crMatch[1]) * 10000000;
    matchedAny = true;
  }

  // Lac / Lakh / Lacs
  let lacMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:lac|lacs|lakh|lakhs)\b/i);
  if (lacMatch) {
    total += parseFloat(lacMatch[1]) * 100000;
    matchedAny = true;
  }

  // K / Thousand
  let kMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/i);
  if (kMatch) {
    total += parseFloat(kMatch[1]) * 1000;
    matchedAny = true;
  }

  if (matchedAny) return total;

  // Direct currency format: PKR 45000, Rs. 150000
  let pkrMatch = str.match(/(?:pkr|rs\.?|\$)\s*(\d+(?:\.\d+)?)/i);
  if (pkrMatch) {
    return parseFloat(pkrMatch[1]);
  }

  // Pure digits: 15000000, 45000
  let digitMatch = str.match(/(\d{5,})/);
  if (digitMatch) {
    return parseFloat(digitMatch[1]);
  }

  return null;
}

/**
 * Converts size strings (e.g. "2 Kanal", "5 Marla", "120 Sq Yd", "450 Sq Ft") to target area unit.
 * Standard Pakistani land units:
 * 1 Kanal = 20 Marla
 * 1 Marla = 25 Sq. Yd (Yards) = 225 Sq. Ft (Feet)
 */
function parseAreaInUnit(sizeStr, rawMsg, targetUnit = 'Marla') {
  const sourceStr = sizeStr || '';
  if (!sourceStr && !rawMsg) return null;
  const str = String(sourceStr || rawMsg).toLowerCase().replace(/,/g, '').trim();

  let marlaVal = null;

  let kanalMatch = str.match(/(\d+(?:\.\d+)?)\s*kanal/i);
  if (kanalMatch) {
    marlaVal = parseFloat(kanalMatch[1]) * 20;
  } else {
    let marlaMatch = str.match(/(\d+(?:\.\d+)?)\s*marla/i);
    if (marlaMatch) {
      marlaVal = parseFloat(marlaMatch[1]);
    } else {
      let ydMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*yd|sq\.?\s*yard|yard|yards|yrd|yd)/i);
      if (ydMatch) {
        marlaVal = parseFloat(ydMatch[1]) / 25;
      } else {
        let ftMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sq\.?\s*feet|ft|feet)/i);
        if (ftMatch) {
          marlaVal = parseFloat(ftMatch[1]) / 225;
        }
      }
    }
  }

  if (marlaVal === null) return null;

  const tu = (targetUnit || 'Marla').toLowerCase().trim();
  if (tu.includes('kanal')) return marlaVal / 20;
  if (tu.includes('marla')) return marlaVal;
  if (tu.includes('yd') || tu.includes('yard')) return marlaVal * 25;
  if (tu.includes('ft') || tu.includes('feet')) return marlaVal * 225;

  return marlaVal;
}

/**
 * Filter & sort properties array based on criteria.
 */
function filterAndSortProperties(rawRows, filters = {}) {
  const targetUnit = filters.areaUnit || 'Marla';

  let items = rawRows.map(r => {
    const parsedPrice = parsePriceInPKR(r.price, r.raw_message);
    const parsedArea = parseAreaInUnit(r.size, r.raw_message, targetUnit);

    return {
      id: r.id,
      whatsappMessageId: r.whatsapp_message_id,
      chatJid: r.chat_jid,
      chatName: r.chat_name,
      sender: r.sender,
      purpose: r.purpose || 'SALE',
      city: r.city,
      location: r.vicinity || r.area || r.city,
      area: r.area,
      vicinity: r.vicinity,
      propertyType: r.property_type,
      propertySubType: r.property_sub_type || null,
      size: r.size,
      parsedPricePKR: parsedPrice,
      parsedAreaInTargetUnit: parsedArea,
      targetAreaUnit: targetUnit,
      price: r.price,
      contactNumber: r.contact_number,
      summary: r.summary,
      rawMessage: r.raw_message,
      fromMe: r.from_me || r.fromMe || false,
      from_me: r.from_me || r.fromMe || false,
      userId: r.user_id || 1,
      user_id: r.user_id || 1,
      createdAt: r.created_at
    };
  });

  // Price Min Filter
  if (filters.priceMin !== undefined && filters.priceMin !== null && String(filters.priceMin).trim() !== '') {
    const minP = parseFloat(filters.priceMin);
    if (!isNaN(minP)) {
      items = items.filter(r => r.parsedPricePKR !== null && r.parsedPricePKR >= minP);
    }
  }

  // Price Max Filter
  if (filters.priceMax !== undefined && filters.priceMax !== null && String(filters.priceMax).trim() !== '') {
    const maxP = parseFloat(filters.priceMax);
    if (!isNaN(maxP)) {
      items = items.filter(r => r.parsedPricePKR !== null && r.parsedPricePKR <= maxP);
    }
  }

  // Area Min Filter
  if (filters.areaMin !== undefined && filters.areaMin !== null && String(filters.areaMin).trim() !== '') {
    const minA = parseFloat(filters.areaMin);
    if (!isNaN(minA)) {
      items = items.filter(r => r.parsedAreaInTargetUnit !== null && r.parsedAreaInTargetUnit >= minA);
    }
  }

  // Area Max Filter
  if (filters.areaMax !== undefined && filters.areaMax !== null && String(filters.areaMax).trim() !== '') {
    const maxA = parseFloat(filters.areaMax);
    if (!isNaN(maxA)) {
      items = items.filter(r => r.parsedAreaInTargetUnit !== null && r.parsedAreaInTargetUnit <= maxA);
    }
  }

  // Sorting
  const sort = (filters.sortBy || 'Newest First').toLowerCase();
  if (sort.includes('price') && (sort.includes('low') || sort.includes('asc'))) {
    items.sort((a, b) => (a.parsedPricePKR || 0) - (b.parsedPricePKR || 0));
  } else if (sort.includes('price') && (sort.includes('high') || sort.includes('desc'))) {
    items.sort((a, b) => (b.parsedPricePKR || 0) - (a.parsedPricePKR || 0));
  } else if (sort.includes('oldest') || sort.includes('asc')) {
    items.sort((a, b) => a.id - b.id);
  } else {
    // Newest First (default)
    items.sort((a, b) => b.id - a.id);
  }

  return items;
}

module.exports = {
  parsePriceInPKR,
  parseAreaInUnit,
  filterAndSortProperties
};
